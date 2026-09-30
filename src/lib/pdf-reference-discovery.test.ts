import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from './pdf-compatibility';
import { readReferencePages } from './pdf-reference-discovery';

vi.mock('./pdf-compatibility', () => ({ readPdfTextContent: vi.fn() }));

const readText = vi.mocked(readPdfTextContent);
type TextContent = Awaited<ReturnType<typeof readPdfTextContent>>;

function content(text: string): TextContent {
  return {
    items: text.split('\n').map((str, index) => ({
      str, transform: [10, 0, 0, 10, 90, 700 - index * 14], width: 300,
      height: 10, hasEOL: true, fontName: 'body', dir: 'ltr',
    })),
    styles: {}, lang: null,
  };
}

function documentPages(count: number, heading_page?: number): PDFPageProxy[] {
  const pages = Array.from({ length: count }, (_, index) => ({ pageNumber: index + 1 }) as PDFPageProxy);
  readText.mockImplementation(async (page) => content(
    (page as PDFPageProxy).pageNumber === heading_page ? 'References\nJane Doe. A useful paper. 2024.' : `Page ${(page as PDFPageProxy).pageNumber}`,
  ));
  return pages;
}

function readPageNumbers(): number[] {
  return readText.mock.calls.map(([page]) => (page as PDFPageProxy).pageNumber);
}

describe('bibliography page discovery', () => {
  beforeEach(() => vi.resetAllMocks());

  it('finds the heading on page 42 of a 67-page paper before the original tail window', async () => {
    const result = await readReferencePages(documentPages(67, 42), () => true);
    expect(result.map((page) => page.page_number)).toEqual(Array.from({ length: 26 }, (_, index) => index + 42));
    expect(readPageNumbers()).toEqual([...Array.from({ length: 25 }, (_, index) => index + 43), 42]);
    expect(result[0].lines?.[0]).toEqual({ text: 'References', source_rect: [90, 700, 390, 710] });
  });

  it('finds a bibliography before a long appendix without an arbitrary page cutoff', async () => {
    const result = await readReferencePages(documentPages(120, 12), () => true);
    expect(result.map((page) => page.page_number)).toEqual(Array.from({ length: 109 }, (_, index) => index + 12));
    expect(readPageNumbers().at(-1)).toBe(12);
    expect(new Set(readPageNumbers()).size).toBe(109);
  });

  it('keeps the original tail scan when its heading is already included', async () => {
    const result = await readReferencePages(documentPages(67, 50), () => true);
    expect(result.map((page) => page.page_number)).toEqual(Array.from({ length: 25 }, (_, index) => index + 43));
    expect(readPageNumbers()).toEqual(result.map((page) => page.page_number));
  });

  it('reads a short document once and preserves page order', async () => {
    const result = await readReferencePages(documentPages(4, 3), () => true);
    expect(result.map((page) => page.page_number)).toEqual([1, 2, 3, 4]);
    expect(readPageNumbers()).toEqual([1, 2, 3, 4]);
  });

  it('retains only the original fallback pages when no heading exists anywhere', async () => {
    const pages = documentPages(20);
    readText.mockImplementation(async (page) => content((page as PDFPageProxy).pageNumber === 1
      ? 'A body link https://example.org/body' : 'A tail link https://example.org/tail'));
    const result = await readReferencePages(pages, () => true);
    expect(result.map((page) => page.page_number)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(result.every((page) => !page.text.includes('/body'))).toBe(true);
    expect(readPageNumbers()).toHaveLength(20);
  });

  it('does not start text extraction for an obsolete document', async () => {
    expect(await readReferencePages(documentPages(67, 42), () => false)).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });

  it.each(['initial', 'backward'] as const)('drops an obsolete document after an awaited %s read', async (phase) => {
    const pages = documentPages(67, 42);
    let current = true;
    readText.mockImplementation(async (page) => {
      if ((page as PDFPageProxy).pageNumber === (phase === 'initial' ? 43 : 42)) current = false;
      return content(current ? 'Appendix' : 'References');
    });
    expect(await readReferencePages(pages, () => current)).toEqual([]);
    expect(readPageNumbers()).toHaveLength(phase === 'initial' ? 1 : 26);
  });

  it('checks cancellation again before reading the next page', async () => {
    const pages = documentPages(67, 42);
    const is_current = vi.fn().mockReturnValue(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await readReferencePages(pages, is_current)).toEqual([]);
    expect(readPageNumbers()).toEqual([43]);
  });

  it('propagates extraction errors to the existing reader error path', async () => {
    const pages = documentPages(67, 42);
    readText.mockRejectedValue(new Error('Invalid text stream'));
    await expect(readReferencePages(pages, () => true)).rejects.toThrow('Invalid text stream');
    expect(readPageNumbers()).toEqual([43]);
  });
});
