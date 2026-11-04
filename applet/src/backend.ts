import { createId, fs, hostCall, http, llm } from '../vendor/apell-sdk';
import type { AiAnswer, AiModel, AiRequest, AiSettings, ReaderCapabilities, ReaderOrientation, ReferenceCandidate } from '../../src/lib/types';
import { store } from './store';
import { cancelPaperAi } from './conversations';
import { invalidatePreviews, live_downloads, type PdfFiles } from './papers';
import { ai_events, progress_events } from './events';

export * from './library';
export * from './papers';
export * from './conversations';
export const nativeAvailable = () => window.parent !== window;
export const onAiStream = ai_events.listen;
export const onProgress = progress_events.listen;

export async function removePaper(paper_id: string): Promise<void> {
  invalidatePreviews(paper_id);
  await cancelPaperAi(paper_id);
  await store.transaction(async (db) => {
    const files = await db.get<PdfFiles>('pdf', paper_id);
    if (files) await db.put('garbage', createId(), '', files);
    await db.execute('DELETE FROM documents WHERE paper_id=?', [paper_id]);
  });
  await collectGarbage();
}

export async function collectGarbage() {
  const records = await store.transaction(async (db) => {
    const result = await db.query("SELECT id FROM documents WHERE kind='garbage' LIMIT 100");
    const records: { id: string; files: PdfFiles }[] = [];
    for (const row of result.rows) if (row[0].type === 'text') {
      const files = await db.get<PdfFiles>('garbage', row[0].value);
      if (files) records.push({ id: row[0].value, files });
    }
    return records;
  });
  if (records.length) await fs.mkdir('papers');
  for (const { id, files } of records) {
    if (live_downloads.has(files.directory)) continue;
    // Files already deleted by an interrupted cleanup are harmless. Keep the
    // durable job if a directory remains so a later launch can retry it.
    const parent = await fs.list('papers');
    if (parent.entries.some((entry) => `papers/${entry.name}` === files.directory)) {
      for (const path of files.paths) await fs.remove(path).catch(() => {});
      const remaining = await fs.list(files.directory);
      if (remaining.entries.length) continue;
      await fs.remove(files.directory);
    }
    await store.transaction((db) => db.remove('garbage', id));
  }
}

export async function getSettings(): Promise<AiSettings> {
  const config = await llm.config();
  return { provider_kind: 'openai_compatible', base_url: config.connection_id, model_id: config.model_id,
    has_api_key: false, host_managed: true, mode: config.mode };
}
export async function saveSettings(_settings: AiSettings, _api_key: string | null): Promise<AiSettings> {
  throw new Error('Manage the model connection in Apell Settings.');
}
export async function listAiModels(_settings: AiSettings, _api_key: string | null): Promise<AiModel[]> {
  throw new Error('Choose the model in Apell Settings.');
}
export async function askSelection(_request: AiRequest): Promise<AiAnswer> {
  throw new Error('Start an AI conversation from the selected passage.');
}

export async function getReaderCapabilities(): Promise<ReaderCapabilities> {
  const device = await hostCall<{ platform: string }>('device.info');
  return { supports_orientation: false, device_kind: device.platform === 'ios' || device.platform === 'android'
    ? (window.innerWidth >= 768 ? 'tablet' : 'phone') : 'desktop' };
}
export async function setReaderOrientation(_orientation: ReaderOrientation): Promise<ReaderOrientation> {
  throw new Error('Rotate your device to change the reading direction.');
}
export async function setReaderAiMode(_active: boolean): Promise<ReaderOrientation> {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

export async function openExternal(_url: string): Promise<void> {
  throw new Error('Apell cannot open external links yet. Select and copy the address to open it in your browser.');
}

/** The host has no share/download capability. Present selectable JSON instead. */
export async function saveAnnotationFile(file_name: string, content: string): Promise<string | null> {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'Export annotations');
  dialog.style.cssText = 'width:min(90vw,720px);max-height:85vh;padding:24px;border:1px solid #aaa;border-radius:16px;background:#fff;color:#222';
  const title = document.createElement('h2'); title.textContent = 'Copy annotation export';
  const description = document.createElement('p'); description.textContent = `Select and copy this JSON into a file named ${file_name}. Apell does not provide file sharing yet.`;
  const textarea = document.createElement('textarea');
  textarea.value = content; textarea.readOnly = true; textarea.setAttribute('aria-label', 'Annotation JSON');
  textarea.style.cssText = 'display:block;width:100%;height:45vh;margin:16px 0;font:12px monospace';
  const select = document.createElement('button'); select.textContent = 'Select all'; select.onclick = () => { textarea.focus(); textarea.select(); };
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close();
  dialog.append(title, description, textarea, select, close); document.body.append(dialog);
  dialog.showModal();
  await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
  dialog.remove();
  return null;
}

export async function resolveReference(citation_text: string): Promise<ReferenceCandidate[]> {
  if (!citation_text.trim() || citation_text.length > 8192) throw new Error('Invalid reference text.');
  const doi = citation_text.match(/10\.\d{4,9}\/[^\s<>"\]]+/i)?.[0].replace(/[.,;)]*$/, '');
  const url = doi ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(citation_text)}&rows=5`;
  const response = await http.request({ url });
  if (response.status === 404) return [];
  if (response.status !== 200) throw new Error(`Reference lookup returned HTTP ${response.status}.`);
  type Work = { DOI?: string; title?: string[]; author?: { given?: string; family?: string; name?: string }[]; 'container-title'?: string[]; published?: { 'date-parts'?: number[][] } };
  const data = JSON.parse(new TextDecoder().decode(new Uint8Array(response.body))) as { message: Work & { items?: Work[] } };
  return (doi ? [data.message] : data.message.items ?? []).filter((work) => typeof work.DOI === 'string' && work.title?.[0])
    .map((work) => ({ title: work.title![0], authors: (work.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')),
      publication_year: work.published?.['date-parts']?.[0]?.[0]?.toString() ?? null,
      venue: work['container-title']?.[0] ?? null, match_kind: doi ? 'identifier' : 'suggestion',
      arxiv_id: null, doi: work.DOI!, url: `https://doi.org/${work.DOI}` }));
}
