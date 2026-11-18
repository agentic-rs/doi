import { config, createId, hostCall, http, onDownloadProgress } from '../vendor/apell-sdk';
import { parseArxivId, parsePaperMetadata } from '../generated/doi_ai';
import type { Paper, PaperPreview } from '../../src/lib/types';
import { store } from './store';
import { validatePdfResource, type PdfResource } from './pdf-cache';
import { progress_events } from './events';

export { getPdfBytes } from './pdf-cache';

const previews = new Map<string, { paper: Paper; created_at: number }>();
const operations = new Map<string, AbortController>();
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

class ArxivRateLimit extends Error {
  constructor(readonly retry_after?: string) { super('arXiv is rate limiting requests. Please retry later.'); }
}

async function arxivRequest<T>(request_id: string, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const gate = pacing.then(async () => {
      const saved = await config.get('arxiv_next_request_at');
      const persisted = saved.found && typeof saved.value === 'number' ? saved.value : 0;
      next_request_at = Math.max(next_request_at, persisted);
      // Another in-flight request can extend the cooldown while this one waits.
      while (next_request_at > Date.now()) {
        const retry_at = next_request_at;
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
    try {
      const result = await send();
      check(signal);
      return result;
    } catch (error) {
      check(signal);
      if (!(error instanceof ArxivRateLimit)) throw error;
      const header = error.retry_after;
      const retry_at = header && /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : header ? Date.parse(header) : NaN;
      next_request_at = Math.max(next_request_at, Number.isFinite(retry_at) ? retry_at : Date.now() + 15_000 * 2 ** attempt);
      await config.set('arxiv_next_request_at', next_request_at);
      if (attempt === 3) throw error;
    }
  }
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
  const bytes = await arxivRequest(request_id, signal, async () => {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const response = await http.request({ url, timeout_ms: 120_000 });
    if (response.status === 429) throw new ArxivRateLimit(response.headers.find((h) => h.name.toLowerCase() === 'retry-after')?.value);
    if (response.status !== 200) throw new Error(`arXiv returned HTTP ${response.status}.`);
    return new Uint8Array(response.body);
  });
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

  const resource = await arxivRequest(request_id, signal, async () => {
    progress_events.emit({ request_id, phase: 'download', message: 'Downloading PDF…', received_bytes: 0, total_bytes: null });
    const unsubscribe = onDownloadProgress(({ request_id: event_id, received_bytes, total_bytes }) => {
      if (event_id !== request_id || signal.aborted) return;
      const amount = total_bytes
        ? `${Math.floor(100 * received_bytes / total_bytes)}%`
        : `${(received_bytes / (1024 * 1024)).toFixed(1)} MiB`;
      progress_events.emit({ request_id, phase: 'download', message: `Downloading PDF… ${amount}`, received_bytes, total_bytes });
    });
    try {
      return await hostCall<PdfResource>('resources.download', { request_id, url: preview.paper.pdf_url });
    } catch (error) {
      // The resource service exposes the status in its error, without response headers.
      if (error instanceof Error && error.message === 'Download returned HTTP 429.') throw new ArxivRateLimit();
      throw error;
    } finally {
      unsubscribe();
    }
  });

  await validatePdfResource(resource);
  const now = new Date().toISOString();
  const paper = { ...preview.paper, pdf_hash: resource.resource_id, downloaded_at: now, last_opened_at: now };
  const saved = await store.transaction(async (db) => {
    check(signal);
    if (previews.get(preview_id) !== preview) throw new Error('This paper was removed while downloading.');
    const concurrent = await db.get<Paper>('paper', paper.paper_id);
    if (concurrent) return concurrent;
    await db.put('paper', paper.paper_id, paper.paper_id, paper);
    await db.put('pdf', paper.paper_id, paper.paper_id, resource);
    check(signal);
    return paper;
  });
  progress_events.emit({ request_id, phase: 'ready', message: 'Paper added', received_bytes: resource.size_bytes, total_bytes: resource.size_bytes });
  return saved;
});

export function invalidatePreviews(paper_id: string) {
  for (const [key, value] of previews) if (value.paper.paper_id === paper_id) previews.delete(key);
}
