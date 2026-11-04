import { config, createId, fs, http } from '../vendor/apell-sdk';
import { hashBytes, parseArxivId, parsePaperMetadata } from '../generated/doi_ai';
import type { Paper, PaperPreview } from '../../src/lib/types';
import { store } from './store';
import { requirePaper } from './library';
import { progress_events } from './events';

const previews = new Map<string, { paper: Paper; created_at: number }>();
const operations = new Map<string, AbortController>();
export const live_downloads = new Set<string>();
let pacing: Promise<unknown> = Promise.resolve();
let next_request_at = 0;

function check(signal: AbortSignal) { if (signal.aborted) throw new Error('Paper operation cancelled.'); }
async function delay(ms: number, signal: AbortSignal) {
  check(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    function cancel() { clearTimeout(timer); reject(new Error('Paper operation cancelled.')); }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

async function request(url: string, request_id: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const gate = pacing.then(async () => {
      const saved = await config.get('arxiv_next_request_at');
      const persisted = saved.found && typeof saved.value === 'number' ? saved.value : 0;
      const retry_at = Math.max(next_request_at, persisted);
      if (retry_at > Date.now()) {
        progress_events.emit({ request_id, phase: 'waiting', message: 'Waiting for arXiv', received_bytes: 0, total_bytes: null, retry_at: new Date(retry_at).toISOString() });
        await delay(retry_at - Date.now(), signal);
      }
      check(signal);
      next_request_at = Date.now() + 3000;
      await config.set('arxiv_next_request_at', next_request_at);
    });
    pacing = gate.catch(() => {});
    await gate;
    check(signal);
    const response = await http.request({ url, timeout_ms: 120_000 });
    check(signal);
    if (response.status === 429) {
      const header = response.headers.find((h) => h.name.toLowerCase() === 'retry-after')?.value;
      const retry_at = header && /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : header ? Date.parse(header) : NaN;
      next_request_at = Math.max(next_request_at, Number.isFinite(retry_at) ? retry_at : Date.now() + 15_000 * 2 ** attempt);
      await config.set('arxiv_next_request_at', next_request_at);
      if (attempt < 3) continue;
      throw new Error('arXiv is rate limiting requests. Please retry later.');
    }
    if (response.status !== 200) throw new Error(`arXiv returned HTTP ${response.status}.`);
    return new Uint8Array(response.body);
  }
  throw new Error('arXiv request failed.');
}

async function operation<T>(request_id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (operations.has(request_id)) throw new Error('That paper operation is already running.');
  const controller = new AbortController();
  operations.set(request_id, controller);
  try { return await run(controller.signal); } finally { operations.delete(request_id); }
}

export async function cancelPaperOperation(request_id: string) { operations.get(request_id)?.abort(); }

export const previewArxivPaper = (input: string, request_id: string): Promise<PaperPreview> => operation(request_id, async (signal) => {
  const id = parseArxivId(input);
  const existing = await store.transaction((db) => db.get<Paper>('paper', id));
  if (existing) return { preview_id: createId(), metadata: existing, library_paper: existing };
  progress_events.emit({ request_id, phase: 'metadata', message: 'Finding paper metadata…', received_bytes: 0, total_bytes: null });
  const bytes = await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, request_id, signal);
  const paper = parsePaperMetadata(bytes, id) as Paper;
  const preview_id = createId();
  for (const [key, value] of previews) if (Date.now() - value.created_at > 86_400_000) previews.delete(key);
  if (previews.size >= 64) previews.delete(previews.keys().next().value!);
  previews.set(preview_id, { paper, created_at: Date.now() });
  const library_paper = await store.transaction((db) => db.get<Paper>('paper', paper.paper_id));
  return { preview_id, metadata: paper, library_paper };
});

export const downloadArxivPaper = (preview_id: string, request_id: string): Promise<Paper> => operation(request_id, async (signal) => {
  const preview = previews.get(preview_id);
  if (!preview || Date.now() - preview.created_at > 86_400_000) throw new Error('Preview expired. Find the paper again.');
  const existing = await store.transaction((db) => db.get<Paper>('paper', preview.paper.paper_id));
  if (existing) return existing;
  progress_events.emit({ request_id, phase: 'download', message: 'Downloading PDF…', received_bytes: 0, total_bytes: null });
  const bytes = await request(preview.paper.pdf_url, request_id, signal);
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('arXiv did not return a PDF.');
  const pdf_hash = hashBytes(bytes);
  const file_id = createId();
  const directory = `papers/${file_id}`;
  const planned_paths = Array.from({ length: Math.ceil(bytes.length / (1024 * 1024)) }, (_, index) => `${directory}/${index}`);
  live_downloads.add(directory);
  await store.transaction((db) => db.put('garbage', file_id, '', { paths: planned_paths, size_bytes: bytes.length, directory }));
  const paths: string[] = [];
  try {
    await fs.mkdir(directory);
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      check(signal);
      const path = `${directory}/${paths.length}`;
      await fs.write(path, bytes.subarray(offset, offset + 1024 * 1024));
      paths.push(path);
    }
    check(signal);
    // Removal invalidates this exact preview while a download is in flight.
    if (previews.get(preview_id) !== preview) throw new Error('This paper was removed while downloading.');
    const now = new Date().toISOString();
    const paper = { ...preview.paper, pdf_hash, downloaded_at: now, last_opened_at: now };
    const saved = await store.transaction(async (db) => {
      check(signal);
      if (previews.get(preview_id) !== preview) throw new Error('This preview is no longer available.');
      const concurrent = await db.get<Paper>('paper', paper.paper_id);
      if (concurrent) return concurrent;
      await db.put('paper', paper.paper_id, paper.paper_id, paper);
      await db.put('pdf', paper.paper_id, paper.paper_id, { paths, size_bytes: bytes.length, directory });
      await db.remove('garbage', file_id);
      return null;
    });
    if (saved) { for (const path of paths) await fs.remove(path); await fs.remove(directory); return saved; }
    progress_events.emit({ request_id, phase: 'ready', message: 'Paper added', received_bytes: bytes.length, total_bytes: bytes.length });
    return paper;
  } catch (error) {
    for (const path of paths) await fs.remove(path).catch(() => {});
    await fs.remove(directory).catch(() => {});
    throw error;
  } finally { live_downloads.delete(directory); }
});

export interface PdfFiles { paths: string[]; size_bytes: number; directory: string }

export async function getPdfBytes(paper_id: string): Promise<Uint8Array> {
  const { file, paper } = await store.transaction(async (db) => ({ paper: await requirePaper(db, paper_id), file: await db.get<PdfFiles>('pdf', paper_id) }));
  if (!file) throw new Error('The cached PDF is missing.');
  const data = new Uint8Array(file.size_bytes);
  let offset = 0;
  for (const path of file.paths) {
    const result = await fs.read(path, { length: 1024 * 1024 });
    data.set(result.bytes, offset);
    offset += result.bytes.length;
  }
  if (offset !== file.size_bytes || hashBytes(data) !== paper.pdf_hash) throw new Error('The cached PDF failed its integrity check.');
  return data;
}

export function invalidatePreviews(paper_id: string) {
  for (const [key, value] of previews) if (value.paper.paper_id === paper_id) previews.delete(key);
}
