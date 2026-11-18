import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from '../../src/lib/pdf-compatibility';
import { pdfFontMetrics } from '../../src/lib/pdf-font-metrics';
import { normalizePdfText } from '../../src/lib/pdf-geometry';
import { pdfContentText } from '../../src/lib/pdf-text';
import type { PageAnchor, Paper, QuadPoints } from '../../src/lib/types';
import { getPdfBytes } from './papers';

export type PdfReadRequest =
  | { name: 'search_document'; query: string; start_page?: number }
  | { name: 'read_page'; page_number: number; offset?: number };

export interface PdfReadResult {
  passages: PageAnchor[];
  message: string;
}

const RESULT_LIMIT = 4;
const SEARCH_PAGE_LIMIT = 24;
const PASSAGE_LENGTH = 1024;
const CACHE_PAGES = 6;
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type TextItem = Extract<TextContent['items'][number], { str: string }>;

// Anchor each complete PDF text run using its own transformation and font
// metrics. In particular a page rotation never enters stored PDF coordinates.
function textQuad(item: TextItem, content: TextContent, view: number[]): QuadPoints | null {
  const style = content.styles[item.fontName];
  if (style?.vertical || item.dir === 'ttb') return null;
  const [a, b, c, d, x, y] = item.transform;
  const length = Math.hypot(a, b);
  if (!length || !(item.width > 0) || Math.abs(a * d - b * c) < 1e-8) return null;
  const dx = a / length * item.width, dy = b / length * item.width;
  const { ascent, descent } = pdfFontMetrics(style);
  const top_x = x + c * ascent, top_y = y + d * ascent;
  const bottom_x = x + c * descent, bottom_y = y + d * descent;
  const cx = (top_x + bottom_x + dx) / 2, cy = (top_y + bottom_y + dy) / 2;
  if (cx < view[0] || cx > view[2] || cy < view[1] || cy > view[3]) return null;
  const quad: QuadPoints = [top_x, top_y, top_x + dx, top_y + dy,
    bottom_x + dx, bottom_y + dy, bottom_x, bottom_y];
  return quad.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000) ? quad : null;
}

interface PageText {
  passages: PageAnchor[];
  source: string;
  starts: number[];
}

async function extractPassages(page: PDFPageProxy): Promise<PageText> {
  const content = await readPdfTextContent(page, {}, { max_items: 24_000, max_characters: 400_000 });
  const passages: PageAnchor[] = [];
  let raw = '', quads: QuadPoints[] = [], lines = 0;
  function flush() {
    const exact_text = normalizePdfText(raw);
    if (exact_text && quads.length) passages.push({ page_number: page.pageNumber, quad_points: quads,
      text_quote: { exact_text, prefix: '', suffix: '', normalization_version: 1 } });
    raw = ''; quads = []; lines = 0;
  }
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const text = item.str.normalize('NFKC');
    if (text.length > PASSAGE_LENGTH || text.includes('\0')) { flush(); continue; }
    if (raw.length + text.length + 1 > PASSAGE_LENGTH || quads.length === 24) flush();
    if (text.trim()) {
      const quad = textQuad(item, content, page.view);
      if (!quad) { flush(); continue; }
      quads.push(quad);
    }
    raw += text;
    if (item.hasEOL) {
      raw += ' ';
      if (++lines >= 4) flush();
    }
  }
  flush();
  // The quote and geometry are an exact pair. Keep recovery context only if
  // those adjacent characters actually occur in the extracted source stream.
  const source = normalizePdfText(pdfContentText(content));
  const starts: number[] = [];
  let offset = 0;
  for (const { text_quote } of passages) {
    const found = source.indexOf(text_quote.exact_text, offset);
    starts.push(found);
    if (found === -1) continue;
    offset = found + text_quote.exact_text.length;
    text_quote.prefix = source.slice(Math.max(0, found - 96), found);
    text_quote.suffix = source.slice(offset, offset + 96);
  }
  return { passages, source, starts };
}

// A phrase may straddle adjacent excerpts. Keep both precise anchors and
// exclude matches in text for which no geometry was available.
function searchPage(page: PageText, query: RegExp, result: PageAnchor[]) {
  let index = 0;
  for (const match of page.source.matchAll(query)) {
    const start = match.index!, end = start + match[0].length;
    while (index < page.passages.length && (page.starts[index] < 0 ||
      page.starts[index] + page.passages[index].text_quote.exact_text.length <= start)) index++;
    let covered = start;
    const found: PageAnchor[] = [];
    for (let i = index; i < page.passages.length && page.starts[i] < end; i++) {
      if (page.starts[i] < 0) continue;
      if (page.source.slice(covered, page.starts[i]).trim()) break;
      found.push(page.passages[i]);
      covered = page.starts[i] + page.passages[i].text_quote.exact_text.length;
      if (covered >= end) break;
    }
    if (covered < end) continue;
    for (const passage of found) {
      if (!result.includes(passage)) result.push(passage);
      if (result.length === RESULT_LIMIT) return;
    }
  }
}

function natural(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

/** A reader belongs to one model operation and one exact local PDF revision. */
export function createPdfReaderTools({ paper_id, pdf_hash }: Pick<Paper, 'paper_id' | 'pdf_hash'>) {
  const cache = new Map<number, PageText>();
  let document: Promise<PDFDocumentProxy> | undefined;
  let loading: PDFDocumentLoadingTask | undefined;
  let closed = false;
  let destroying: Promise<void> | undefined;

  function close(): Promise<void> {
    closed = true;
    cache.clear();
    destroying ??= loading?.destroy();
    return destroying ?? Promise.resolve();
  }
  function check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed) throw new Error('This PDF reading operation has ended.');
  }
  async function open(signal: AbortSignal) {
    const [data, { getDocument }, { pdf_options }] = await Promise.all([
      getPdfBytes(paper_id, { expected_pdf_hash: pdf_hash, signal }),
      import('pdfjs-dist/legacy/build/pdf.mjs'), import('./pdf'),
    ]);
    check(signal);
    loading = getDocument({ data, ...pdf_options });
    return loading.promise;
  }
  async function pagePassages(doc: PDFDocumentProxy, page_number: number, signal: AbortSignal) {
    check(signal);
    const cached = cache.get(page_number);
    if (cached) return cached;
    const page = await doc.getPage(page_number);
    try {
      check(signal);
      const data = await extractPassages(page);
      check(signal);
      if (cache.size === CACHE_PAGES) cache.delete(cache.keys().next().value!);
      cache.set(page_number, data);
      return data;
    } finally { page.cleanup(); }
  }
  async function run(request: PdfReadRequest, signal: AbortSignal): Promise<PdfReadResult> {
    const first = request.name === 'read_page' ? request.page_number : request.start_page ?? 1;
    if (!natural(first, 1)) throw new Error('PDF page numbers start at 1.');
    if (request.name === 'read_page' && !natural(request.offset ?? 0, 0)) throw new Error('Invalid passage offset.');
    if (request.name === 'search_document' && (typeof request.query !== 'string' || request.query.length > 256
      || !normalizePdfText(request.query))) throw new Error('Search needs a phrase of up to 256 characters.');
    const doc = await (document ??= open(signal));
    check(signal);
    if (first > doc.numPages) throw new Error(`This PDF has ${doc.numPages} pages.`);
    if (request.name === 'read_page') {
      const { passages: data } = await pagePassages(doc, first, signal);
      if (!data.length) return { passages: [], message: `Page ${first} has no readable text with passage locations. Images were not read.` };
      const offset = request.offset ?? 0;
      if (offset >= data.length) throw new Error(`Page ${first} contains ${data.length} passages; offsets start at 0.`);
      const passages = data.slice(offset, offset + RESULT_LIMIT);
      const next = offset + passages.length;
      return { passages, message: `Page ${first} of ${doc.numPages}. ` + (next < data.length
        ? `To continue reading page ${first}, use offset ${next}.` : 'End of locatable page text.') };
    }
    const literal = normalizePdfText(request.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = new RegExp(literal, 'giu');
    const last = Math.min(doc.numPages, first + SEARCH_PAGE_LIMIT - 1);
    const passages: PageAnchor[] = [];
    const unreadable: number[] = [];
    let scanned = first;
    for (let n = first; n <= last; n++) {
      try {
        const data = await pagePassages(doc, n, signal);
        searchPage(data, query, passages);
      } catch {
        // A damaged or unusually dense page should not hide matches on the
        // rest of the paper. Cancellation still stops the entire operation.
        check(signal);
        unreadable.push(n);
      }
      scanned = n;
      if (passages.length === RESULT_LIMIT) break;
      // Let the webview process Stop and navigation even with the in-process PDF worker.
      if (n < last) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return { passages, message: `Searched locatable text on pages ${first}–${scanned} of ${doc.numPages}. ` +
      (unreadable.length ? `Text extraction failed on pages ${unreadable.join(', ')}. ` : '') +
      (passages.length === RESULT_LIMIT ? `First ${RESULT_LIMIT} matches returned. Use read_page for more text on page ${scanned}. ` : '') +
      (scanned < doc.numPages ? `Continue searching with start_page ${scanned + 1}.` : 'Reached the final page.') };
  }
  async function execute(request: PdfReadRequest, signal: AbortSignal): Promise<PdfReadResult> {
    check(signal);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { void close().catch(() => {}); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([run(request, signal), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  return { execute, close };
}
