import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import init from '../generated/doi_ai';
import type { DownloadProgress } from '../vendor/apell-sdk/types';
import { makePdf } from './test-pdf';
import { createPdfReaderTools } from './pdf-reader-tools';
import { sqliteCall } from './test-sqlite';
import { cancelPaperOperation, downloadArxivPaper, getPdfBytes, previewArxivPaper, removePaper } from './backend';
import { progress_events } from './events';
import { store } from './store';

const host = vi.hoisted(() => ({
  call: vi.fn(), request: vi.fn(), download: vi.fn(), read: vi.fn(),
  fs_list: vi.fn(), fs_remove: vi.fn(),
  progress: new Set<(event: DownloadProgress) => void>(),
}));
vi.mock('../vendor/apell-sdk', () => ({
  createId: () => randomUUID(),
  hostCall: host.call,
  config: { get: async () => ({ found: false }), set: async () => {} },
  http: { request: host.request },
  fs: { mkdir: async () => {}, list: host.fs_list, remove: host.fs_remove },
  llm: { cancel: vi.fn() },
  onDownloadProgress: (handler: (event: DownloadProgress) => void) => {
    host.progress.add(handler);
    return () => host.progress.delete(handler);
  },
}));

const database = new DatabaseSync(':memory:');
const paper_id = '2501.00042v2';
const pdf_url = `https://arxiv.org/pdf/${paper_id}`;
const mib = 1024 * 1024;
let timestamp = Date.now();

beforeAll(async () => {
  database.exec('PRAGMA foreign_keys=ON');
  await init({ module_or_path: readFileSync('applet/generated/doi_ai_bg.wasm') });
  host.call.mockImplementation(async (method, params) => {
    if (method === 'resources.download') return host.download(params);
    if (method === 'resources.read') return host.read(params);
    return sqliteCall(database, method, params);
  });
});

beforeEach(async () => {
  // Give each preview and download a fresh arXiv pacing window.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(timestamp += 10_000);
  host.request.mockReset().mockResolvedValue({
    status: 200, headers: [], body: Array.from(new TextEncoder().encode(
      `<feed><entry><id>https://arxiv.org/abs/${paper_id}</id><title>Test paper</title><summary>Abstract</summary></entry></feed>`,
    )),
  });
  host.download.mockReset();
  host.read.mockReset();
  host.fs_list.mockReset();
  host.fs_remove.mockReset().mockResolvedValue(null);
  await store.transaction(db => db.execute('DELETE FROM documents'));
});
afterEach(() => { timestamp = Date.now(); vi.useRealTimers(); });
afterAll(() => database.close());

async function preview() {
  const result = await previewArxivPaper(paper_id, randomUUID());
  vi.setSystemTime(Date.now() + 3000);
  return result.preview_id;
}

function serveResource(bytes: Uint8Array) {
  const resource_id = createHash('sha256').update(bytes).digest('hex');
  const receipt = { resource_id, size_bytes: bytes.length };
  host.download.mockResolvedValue(receipt);
  host.read.mockImplementation(({ resource_id: requested_id, offset = 0, length = 65536 }) => {
    expect(requested_id).toBe(resource_id);
    expect(length).toBeLessThanOrEqual(mib);
    return { bytes: Array.from(bytes.subarray(offset, offset + length)) };
  });
  return receipt;
}

it('downloads a PDF over 16 MiB as an Apell resource, reopens it offline and removes its library reference', async () => {
  const bytes = makePdf([['Evidence.']], 16 * mib);
  const receipt = serveResource(bytes);
  const request_id = randomUUID();
  const on_progress = vi.fn();
  const stop = await progress_events.listen(on_progress);
  try {
    host.download.mockImplementationOnce(() => {
      for (const listener of host.progress) {
        listener({ request_id: 'unrelated', kind: 'download_progress', received_bytes: 7, total_bytes: null });
        listener({ request_id, kind: 'download_progress', received_bytes: mib, total_bytes: bytes.length });
      }
      return receipt;
    });
    const preview_id = await preview();
    const paper = await downloadArxivPaper(preview_id, request_id);
    expect(paper.pdf_hash).toBe(receipt.resource_id);
    expect(host.download).toHaveBeenCalledExactlyOnceWith({ request_id, url: pdf_url });
    expect(on_progress).toHaveBeenCalledWith(expect.objectContaining({ request_id, phase: 'download', received_bytes: mib, total_bytes: bytes.length }));
    expect(on_progress).not.toHaveBeenCalledWith(expect.objectContaining({ received_bytes: 7 }));
    expect(host.read).toHaveBeenCalled();
    expect(host.read.mock.calls.every(([{ length }]) => length <= 1024)).toBe(true);
    expect(await store.transaction(db => db.get('pdf', paper_id))).toMatchObject(receipt);

    const reader = createPdfReaderTools(paper);
    try {
      const page = await reader.execute({ name: 'read_page', page_number: 1 }, new AbortController().signal);
      expect(page.passages[0]).toMatchObject({ page_number: 1, text_quote: { exact_text: 'Evidence.' } });
    } finally { await reader.close(); }
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request.mock.calls[0][0].url).toContain('/api/query?');
    expect(host.download).toHaveBeenCalledTimes(1);
    await removePaper(paper_id);
    expect(await store.transaction(db => db.get('pdf', paper_id))).toBeNull();
    expect(await store.transaction(db => db.list('garbage'))).toEqual([]);
    expect(host.fs_remove).not.toHaveBeenCalled();
  } finally { stop(); }
}, 15_000);

it('rejects a non-PDF response before creating a paper or a PDF reference', async () => {
  serveResource(new TextEncoder().encode('<html>Error retrieving PDF</html>'));
  await expect(downloadArxivPaper(await preview(), randomUUID())).rejects.toThrow(/PDF/);
  expect(await store.transaction(db => db.get('paper', paper_id))).toBeNull();
  expect(await store.transaction(db => db.get('pdf', paper_id))).toBeNull();
});

it('waits before retrying an Apell resource download when arXiv rate limits the request', async () => {
  const receipt = serveResource(makePdf([['Second attempt.']]));
  host.download.mockRejectedValueOnce(new Error('Download returned HTTP 429.'));
  const request_id = randomUUID();
  const preview_id = await preview();
  const on_progress = vi.fn();
  const stop = await progress_events.listen(on_progress);
  try {
    const retry_at = new Date(Date.now() + 15_000).toISOString();
    const pending = downloadArxivPaper(preview_id, request_id);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(host.download).toHaveBeenCalledTimes(1);
    expect(on_progress).toHaveBeenCalledWith(expect.objectContaining({ request_id, phase: 'waiting', retry_at }));
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).pdf_hash).toBe(receipt.resource_id);
    expect(host.download).toHaveBeenCalledTimes(2);
    expect(host.request).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

it.each(['cancel', 'remove'] as const)('does not save a late download after %s', async action => {
  const receipt = serveResource(makePdf([['Late response.']]));
  let started!: () => void;
  let finish!: () => void;
  const transferring = new Promise<void>(resolve => { started = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; });
  host.download.mockImplementationOnce(async () => { started(); await completed; return receipt; });
  const request_id = randomUUID();
  const pending = downloadArxivPaper(await preview(), request_id);
  const rejected = expect(pending).rejects.toThrow();
  await transferring;
  if (action === 'cancel') await cancelPaperOperation(request_id);
  else await removePaper(paper_id);
  finish();
  await rejected;
  expect(await store.transaction(db => db.get('paper', paper_id))).toBeNull();
  expect(await store.transaction(db => db.get('pdf', paper_id))).toBeNull();
});

it('rejects truncated and altered resources when reopening a saved PDF', async () => {
  const bytes = makePdf([['Original.']]);
  serveResource(bytes);
  await downloadArxivPaper(await preview(), randomUUID());
  host.read.mockResolvedValue({ bytes: [] });
  await expect(getPdfBytes(paper_id)).rejects.toThrow();
  host.read.mockResolvedValue({ bytes: Array.from(bytes, byte => byte ^ 1) });
  await expect(getPdfBytes(paper_id)).rejects.toThrow();
});

it('continues to clean up pre-existing PDF chunks when removing a legacy paper', async () => {
  const directory = 'papers/legacy';
  const paths = [`${directory}/0`, `${directory}/1`];
  await store.transaction(db => db.put('pdf', paper_id, paper_id, { directory, paths, size_bytes: mib + 10 }));
  host.fs_list.mockImplementation((path: string) => ({ entries: path === 'papers' ? [{ name: 'legacy' }] : [] }));
  await removePaper(paper_id);
  expect(host.fs_remove.mock.calls.map(([path]) => path)).toEqual([...paths, directory]);
  expect(await store.transaction(db => db.get('pdf', paper_id))).toBeNull();
  expect(await store.transaction(db => db.list('garbage'))).toEqual([]);
});
