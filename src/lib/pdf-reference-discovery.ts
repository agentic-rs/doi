import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from './pdf-compatibility';
import { hasReferenceHeading } from './pdf-references';
import type { PageText } from './pdf-references';
import { pdfContentLines } from './pdf-text';

/** Keep the usual tail scan cheap, but find bibliographies before long appendices. */
export async function readReferencePages(pages: PDFPageProxy[], is_current: () => boolean): Promise<PageText[]> {
  const tail_start = Math.max(0, pages.length - Math.min(25, Math.max(6, Math.ceil(pages.length * 0.45))));
  const tail_pages: PageText[] = [];
  let heading_found = false;
  const readPage = async (page: PDFPageProxy): Promise<PageText | null> => {
    if (!is_current()) return null;
    const content = await readPdfTextContent(page);
    if (!is_current()) return null;
    const lines = pdfContentLines(content);
    return { page_number: page.pageNumber, text: lines.map((line) => line.text).join('\n'), lines };
  };
  for (const page of pages.slice(tail_start)) {
    const text_page = await readPage(page);
    if (!text_page) return [];
    tail_pages.push(text_page);
    heading_found ||= hasReferenceHeading(text_page);
  }
  if (heading_found) return tail_pages;

  // Read backward one page at a time, stopping as soon as the missing heading
  // is found. Reverse the new pages before parsing so entries retain PDF order.
  const earlier_pages: PageText[] = [];
  for (let index = tail_start - 1; index >= 0; index -= 1) {
    const text_page = await readPage(pages[index]);
    if (!text_page) return [];
    earlier_pages.push(text_page);
    if (hasReferenceHeading(text_page)) return [...earlier_pages.reverse(), ...tail_pages];
  }
  // A document without a bibliography heading retains the existing tail-only
  // URL fallback; body links must not become newly invented reference entries.
  return is_current() ? tail_pages : [];
}
