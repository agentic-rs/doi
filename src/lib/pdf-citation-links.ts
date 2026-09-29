import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfSourceRect, ReferenceItem } from './types';
import { arxivIdFromUrl, referenceAtDestination } from './pdf-references';

export interface CitationLink {
  page_number: number;
  source_rect: PdfSourceRect;
  reference_id: string;
}

export function referenceForUrl(references: ReferenceItem[], url: string): ReferenceItem | null {
  const arxiv_id = arxivIdFromUrl(url);
  return references.find((item) => item.url === url || (arxiv_id && item.arxiv_id === arxiv_id) ||
    (item.doi && url.toLowerCase() === `https://doi.org/${item.doi}`.toLowerCase())) ?? null;
}

/** Use the PDF author's citation destinations where available, including
 * author/year styles that cannot be identified reliably from plain text. */
export async function extractCitationLinks(
  document: PDFDocumentProxy,
  pages: PDFPageProxy[],
  references: ReferenceItem[],
  is_current: () => boolean,
): Promise<CitationLink[]> {
  if (!references.length) return [];
  const links: CitationLink[] = [];
  const destinations = new Map<string, Promise<unknown[] | null>>();
  const page_indices = new Map<string, Promise<number>>();
  for (const page of pages) {
    if (!is_current()) return [];
    const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
    for (const annotation of annotations) {
      if (!is_current()) return [];
      if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4 || !annotation.rect.every(Number.isFinite)) continue;
      let reference = typeof annotation.url === 'string' ? referenceForUrl(references, annotation.url) : null;
      if (!reference && annotation.dest) {
        try {
          if (typeof annotation.dest === 'string' && !destinations.has(annotation.dest)) {
            destinations.set(annotation.dest, document.getDestination(annotation.dest));
          }
          const destination = typeof annotation.dest === 'string' ? await destinations.get(annotation.dest)! : annotation.dest;
          if (!Array.isArray(destination)) continue;
          const target = destination[0];
          let index: number;
          if (typeof target === 'number') index = target;
          else {
            const key = `${target.num}:${target.gen}`;
            if (!page_indices.has(key)) page_indices.set(key, document.getPageIndex(target));
            index = await page_indices.get(key)!;
          }
          const kind = destination[1]?.name;
          const x = destination[2];
          const y = destination[kind === 'FitR' ? 5 : 3];
          if ((kind === 'XYZ' || kind === 'FitR') && typeof x === 'number' && typeof y === 'number') {
            reference = referenceAtDestination(references, index + 1, [x, y]);
          }
        } catch {
          // An invalid link does not invalidate other references or PDF reading.
        }
      }
      if (reference) links.push({ page_number: page.pageNumber, source_rect: annotation.rect as PdfSourceRect, reference_id: reference.reference_id });
    }
  }
  return is_current() ? links : [];
}
