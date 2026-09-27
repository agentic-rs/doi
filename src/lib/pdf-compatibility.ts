import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfTextPage = Pick<PDFPageProxy, 'isPureXfa' | 'getTextContent' | 'streamTextContent'>;
type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type PdfTextParameters = Parameters<PDFPageProxy['getTextContent']>[0];

/** Safari 18 streams have getReader(), but lack the async iterator PDF.js uses. */
export async function readPdfTextContent(page: PdfTextPage, parameters: PdfTextParameters = {}): Promise<PdfTextContent> {
  // XFA documents use a separate text source rather than the ordinary stream.
  if (page.isPureXfa) return page.getTextContent(parameters);

  const reader = page.streamTextContent(parameters).getReader();
  const content: PdfTextContent = { items: [], styles: Object.create(null), lang: null };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value as PdfTextContent;
      content.lang ??= chunk.lang;
      Object.assign(content.styles, chunk.styles);
      content.items.push(...chunk.items);
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }
  return content;
}
