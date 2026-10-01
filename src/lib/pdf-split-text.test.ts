// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createSplitTextLayer, prepareSplitPdfText } from './pdf-split-text';
import type { PreparedSplitText } from './pdf-split-text';
import { selectionContext } from './pdf-selection';
import type { SplitLineRect } from './pdf-line-layout';

const text_fixture = vi.hoisted(() => ({ defer_next: false, completions: [] as Array<() => void> }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  TextLayer: class {
    textDivs: HTMLElement[] = [];
    constructor({ textContentSource, container, viewport }: {
      textContentSource: { items: Array<{ str: string; width: number; transform: number[] }> };
      container: HTMLElement; viewport: PageViewport;
    }) {
      for (const item of textContentSource.items) {
        const span = document.createElement('span');
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        span.style.left = `${x}px`; span.style.top = `${y - 9}px`;
        span.dataset.sourceWidth = String(item.width);
        span.textContent = item.str;
        this.textDivs.push(span); container.append(span);
      }
    }
    render() {
      if (!text_fixture.defer_next) return Promise.resolve();
      text_fixture.defer_next = false;
      return new Promise<void>((resolve) => text_fixture.completions.push(resolve));
    }
    cancel() {}
  },
}));

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); text_fixture.defer_next = false; text_fixture.completions = []; });

function characters(value: string, left: number): SplitLineRect[] {
  return Array.from(value, (_, index) => [left + index * 4, 0, left + (index + 1) * 4, 10]);
}

function fixture(font_switch = false) {
  const prepared: PreparedSplitText = {
    layout: { width: 50, height: 20, pieces: [
      { source_rect: [0, 0, 50, 10], display_rect: [0, 0, 50, 10] },
      { source_rect: [50, 0, 100, 10], display_rect: [0, 10, 50, 20] },
    ] },
    viewport: { convertToPdfPoint: (x: number, y: number) => [100 + x, 700 - y] } as PageViewport,
    text: 'Alpha beta gamma', text_style: '', font_scale: 1,
    fragments: [
      ...(font_switch ? [
        { text: 'Al', style: 'font-family:serif', left: 0, top: 0, piece_index: 0, character_rects: characters('Al', 0) },
        { text: 'pha ', style: 'font-family:sans-serif', left: 8, top: 0, piece_index: 0, character_rects: characters('pha ', 8) },
      ] : [{ text: 'Alpha ', style: '', left: 0, top: 0, piece_index: 0, character_rects: characters('Alpha ', 0) }]),
      { text: 'beta gamma', style: '', left: 50, top: 0, piece_index: 1, character_rects: characters('beta gamma', 50) },
    ],
  };
  const { element, quads_for_range } = createSplitTextLayer(prepared, 2);
  const page = document.createElement('div');
  page.append(element);
  document.body.append(page);
  const selection_page = { page_number: 1, text_layer: element, page_element: page,
    viewport: prepared.viewport, text: prepared.text, quads_for_range };
  return { prepared, element, selection_page };
}

describe('split-line source text anchors', () => {
  it('keeps a partial word on the second display line anchored to its exact source characters', () => {
    const { element, selection_page } = fixture();
    const node = element.querySelectorAll('span')[1].firstChild!;
    const range = document.createRange();
    range.setStart(node, 1); range.setEnd(node, 3);
    const result = selectionContext(range, [selection_page]);
    expect(result?.selected_text).toBe('et');
    expect(result?.page_anchors[0].quad_points).toEqual([[154, 700, 162, 700, 162, 690, 154, 690]]);
    expect(result?.page_anchors[0].text_quote).toMatchObject({ exact_text: 'et', prefix: 'Alpha b', suffix: 'a gamma' });
    expect((element.querySelectorAll('span')[1] as HTMLElement).style.left).toBe('0px');
    expect((element.querySelectorAll('span')[1] as HTMLElement).style.top).toBe('20px');
  });

  it('captures a selection crossing the two halves once with original PDF quads', () => {
    const { element, selection_page } = fixture();
    const spans = element.querySelectorAll('span');
    const range = document.createRange();
    range.setStart(spans[0].firstChild!, 2); range.setEnd(spans[1].firstChild!, 4);
    const result = selectionContext(range, [selection_page]);
    expect(result?.selected_text).toBe('pha beta');
    expect(result?.page_anchors[0].quad_points).toEqual([
      [108, 700, 120, 700, 120, 690, 108, 690], [150, 700, 166, 700, 166, 690, 150, 690],
    ]);
    expect(result?.context_text).toBe('Page 1: Alpha beta gamma');
  });

  it('does not insert a space into a word divided by a PDF font change', () => {
    const { element, selection_page } = fixture(true);
    const spans = element.querySelectorAll('span');
    const range = document.createRange();
    range.setStart(spans[0].firstChild!, 0); range.setEnd(spans[2].firstChild!, 4);
    expect(selectionContext(range, [selection_page])?.selected_text).toBe('Alpha beta');
    expect(selectionContext(range, [selection_page])?.page_anchors[0].quad_points).toHaveLength(3);
  });

  it('excludes spans touching only a selection boundary', () => {
    const { element, selection_page } = fixture();
    const range = document.createRange();
    range.setStart(element, 0); range.setEnd(element, 1);
    expect(selectionContext(range, [selection_page])?.selected_text).toBe('Alpha');
    expect(selectionContext(range, [selection_page])?.page_anchors[0].quad_points).toHaveLength(1);
  });

  it('normalizes a ligature while preserving its single source glyph', () => {
    const { prepared } = fixture();
    prepared.text = 'ﬁ beta';
    prepared.fragments[0] = { ...prepared.fragments[0], text: 'ﬁ ', character_rects: characters('ﬁ ', 0) };
    prepared.fragments[1] = { ...prepared.fragments[1], text: 'beta', character_rects: characters('beta', 50) };
    const { element, quads_for_range } = createSplitTextLayer(prepared, 1);
    const page = document.createElement('div'); page.append(element); document.body.append(page);
    const range = document.createRange(); range.selectNodeContents(element.querySelector('span')!);
    const result = selectionContext(range, [{ page_number: 1, text_layer: element, page_element: page, viewport: prepared.viewport, text: prepared.text, quads_for_range }]);
    expect(result?.selected_text).toBe('fi');
    expect(result?.page_anchors[0].quad_points).toEqual([[100, 700, 104, 700, 104, 690, 100, 690]]);
  });
});

function measuredFixture() {
  const item = (str: string, x: number, y: number, width = str.length * 4) => ({
    str, width, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true, transform: [10, 0, 0, 10, x, y],
  });
  const content = { items: [item('alpha', 1, 40), item(' ', 21, 40, 0.5), item('beta gamma delta', 21.5, 40), item('short', 1, 29.1)], styles: {}, lang: null };
  const page = { rotate: 0, userUnit: 1, getViewport: ({ scale, offsetX = 0, offsetY = 0 }: { scale: number; offsetX?: number; offsetY?: number }) => ({
    scale, rotation: 0, width: 128 * scale, height: 50 * scale,
    convertToViewportPoint: (x: number, y: number) => [x * scale + offsetX, (50 - y) * scale + offsetY],
    convertToViewportRectangle: ([left, bottom, right, top]: number[]) => [left * scale + offsetX, (50 - bottom) * scale + offsetY, right * scale + offsetX, (50 - top) * scale + offsetY],
    convertToPdfPoint: (x: number, y: number) => [(x - offsetX) / scale, 50 - (y - offsetY) / scale],
  }), streamTextContent: () => new ReadableStream({ start(controller) { controller.enqueue(content); controller.close(); } }), } as unknown as PDFPageProxy;
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const ancestor = this.commonAncestorContainer;
    const span = ancestor instanceof Element ? ancestor : ancestor.parentElement!;
    const length = span.textContent!.length;
    const start = this.startContainer instanceof Text ? this.startOffset : 0;
    const end = this.endContainer instanceof Text ? this.endOffset : length;
    const character_width = Number((span as HTMLElement).dataset.sourceWidth) / length;
    const factor = span.closest('[data-scale="2"]') ? 2 : 1;
    return new DOMRect((parseFloat((span as HTMLElement).style.left) + start * character_width) * factor,
      parseFloat((span as HTMLElement).style.top) * factor, (end - start) * character_width * factor, 12.5 * factor);
  });
  const host = document.createElement('div'); document.body.append(host);
  return { page, host };
}

describe('source line measurement', () => {
  it('separates overlapping browser font boxes and preserves an explicit narrow PDF space', async () => {
    const { page, host } = measuredFixture();
    const prepared = await prepareSplitPdfText(page, [0, 0, 128, 50], host);
    expect(prepared.layout.width).toBeLessThan(128);
    expect(prepared.layout.height).toBeGreaterThan(50);
    expect(prepared.text).toBe('alpha beta gamma delta\nshort');
    const { element } = createSplitTextLayer(prepared, 1);
    const range = document.createRange(); range.selectNodeContents(element);
    expect(range.toString()).toContain('alpha beta');
  });

  it('measures outside an active reader scale transform', async () => {
    const { page, host } = measuredFixture();
    host.dataset.scale = '2';
    const prepared = await prepareSplitPdfText(page, [0, 0, 128, 50], host);
    expect(prepared.fragments[0].character_rects[0][2] - prepared.fragments[0].character_rects[0][0]).toBe(4);
  });

  it('does not share an in-flight measurement with a new live reader host', async () => {
    const { page, host } = measuredFixture();
    text_fixture.defer_next = true;
    const first = prepareSplitPdfText(page, [0, 0, 128, 50], host).catch((error: Error) => error);
    await vi.waitFor(() => expect(text_fixture.completions).toHaveLength(1));
    host.remove();
    const second_host = document.createElement('div'); document.body.append(second_host);
    const second = await prepareSplitPdfText(page, [0, 0, 128, 50], second_host);
    text_fixture.completions[0]();
    expect(await first).toBeInstanceOf(Error);
    expect(second.layout.width).toBeLessThan(128);
    expect(await prepareSplitPdfText(page, [0, 0, 128, 50], second_host)).toBe(second);
    expect(document.querySelector('.pdf-line-probe')).toBeNull();
  });
});
