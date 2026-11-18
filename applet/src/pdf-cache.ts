import { fs, hostCall } from '../vendor/apell-sdk';
import { hashBytes } from '../generated/doi_ai';
import { requirePaper } from './library';
import { store } from './store';

export interface PdfResource { resource_id: string; size_bytes: number }
export interface LegacyPdfFiles { paths: string[]; size_bytes: number; directory: string }
export type CachedPdf = PdfResource | LegacyPdfFiles;

const chunk_size = 1024 * 1024;

async function readResource(resource_id: string, offset: number, length: number) {
  const { bytes } = await hostCall<{ bytes: number[] }>('resources.read', { resource_id, offset, length });
  if (bytes.length !== length) throw new Error('The cached PDF failed its integrity check.');
  return bytes;
}

export async function validatePdfResource(file: PdfResource) {
  if (!/^[a-f0-9]{64}$/.test(file.resource_id) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) {
    throw new Error('Apell returned an invalid PDF resource.');
  }
  const header = await readResource(file.resource_id, 0, Math.min(file.size_bytes, 1024));
  if (!new TextDecoder().decode(Uint8Array.from(header)).includes('%PDF-')) {
    throw new Error('arXiv did not return a PDF.');
  }
}

export async function getPdfBytes(paper_id: string, options: { expected_pdf_hash?: string; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const { expected_pdf_hash, signal } = options;
  signal?.throwIfAborted();
  const { paper, file } = await store.transaction(async (db) => ({
    paper: await requirePaper(db, paper_id),
    file: await db.get<CachedPdf>('pdf', paper_id),
  }));
  if (expected_pdf_hash !== undefined && paper.pdf_hash !== expected_pdf_hash) throw new Error('The cached PDF belongs to a different revision.');
  if (!file) throw new Error('The cached PDF is missing.');
  signal?.throwIfAborted();
  const data = new Uint8Array(file.size_bytes);
  let offset = 0;
  if ('resource_id' in file) {
    if (file.resource_id !== paper.pdf_hash) throw new Error('The cached PDF belongs to a different revision.');
    while (offset < data.length) {
      const bytes = await readResource(file.resource_id, offset, Math.min(chunk_size, data.length - offset));
      signal?.throwIfAborted();
      data.set(bytes, offset);
      offset += bytes.length;
    }
  } else {
    for (const path of file.paths) {
      const { bytes } = await fs.read(path, { length: chunk_size });
      signal?.throwIfAborted();
      data.set(bytes, offset);
      offset += bytes.length;
    }
  }
  if (offset !== data.length || hashBytes(data) !== paper.pdf_hash) throw new Error('The cached PDF failed its integrity check.');
  return data;
}
