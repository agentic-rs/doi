import { describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from './pdf-compatibility';

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

function chunk(text: string, lang: string | null, font_name: string): PdfTextContent {
  return {
    items: [{ str: text, dir: 'ltr', transform: [1, 0, 0, 1, 10, 20], width: 20, height: 10, fontName: font_name, hasEOL: false }],
    styles: { [font_name]: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } },
    lang,
  };
}

function textPage(stream: ReadableStream<PdfTextContent>) {
  return { isPureXfa: false, getTextContent: vi.fn(), streamTextContent: vi.fn(() => stream) };
}

describe('PDF text extraction on WebKit', () => {
  it('aggregates chunks without requiring ReadableStream async iteration', async () => {
    const first = chunk('Hello', null, 'F1');
    const second = chunk(' world', 'en', 'F2');
    const stream = new ReadableStream<PdfTextContent>({
      start(controller) { controller.enqueue(first); controller.enqueue(second); controller.close(); },
    });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    Object.defineProperty(stream, 'values', { value: undefined });
    const page = textPage(stream);
    const result = await readPdfTextContent(page, { includeMarkedContent: true, disableNormalization: true });

    expect(result.items).toEqual([...first.items, ...second.items]);
    expect(result.styles).toEqual({ ...first.styles, ...second.styles });
    expect(result.lang).toBe('en');
    expect(Object.getPrototypeOf(result.styles)).toBeNull();
    expect(page.streamTextContent).toHaveBeenCalledWith({ includeMarkedContent: true, disableNormalization: true });
    expect(page.getTextContent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('preserves the original extraction error and releases the reader lock', async () => {
    const failure = new Error('Could not decode the text stream');
    const stream = new ReadableStream<PdfTextContent>({ start(controller) { controller.error(failure); } });
    const reader = stream.getReader();
    const cancel = vi.spyOn(reader, 'cancel');
    vi.spyOn(stream, 'getReader').mockReturnValue(reader);

    await expect(readPdfTextContent(textPage(stream))).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
    expect(stream.locked).toBe(false);
  });

  it('uses the PDF.js XFA extraction path when a page is pure XFA', async () => {
    const content = chunk('Form text', 'en', 'F1');
    const page = { isPureXfa: true, getTextContent: vi.fn(async () => content), streamTextContent: vi.fn() };
    await expect(readPdfTextContent(page)).resolves.toBe(content);
    expect(page.streamTextContent).not.toHaveBeenCalled();
  });
});
