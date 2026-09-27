// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectionContext } from './pdf-selection';
import type { SelectionPage } from './pdf-selection';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function fixturePages(): SelectionPage[] {
  document.body.innerHTML = `<div id="outside">Toolbar text</div>
    <div data-page-number="1"><div class="textLayer"><span>Before first selection</span><br><span>continued</span></div></div>
    <div data-page-number="2"><div class="textLayer"><span>second selection after.</span></div></div>
    <div data-page-number="3"><div class="textLayer"><span>Untouched third page.</span></div></div>`;
  return [1, 2, 3].map((page_number) => {
    const element = document.querySelector<HTMLElement>(`[data-page-number="${page_number}"]`)!;
    const top = 200 + (page_number - 1) * 900;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, top, 600, 800));
    return {
      page_number,
      text_layer: element.querySelector<HTMLElement>('.textLayer')!,
      page_element: element,
      viewport: {
        convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
        convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
      },
      text: ['Before first selection\ncontinued', 'second selection after.', 'Untouched third page.'][page_number - 1],
    };
  });
}

// JSDOM implements actual ranges and cloned fragments, but doesn't do layout.
// Supply browser geometry for each clipped range while retaining DOM endpoints.
function stubRangeGeometry(range: Range) {
  const clone = range.cloneRange.bind(range);
  vi.spyOn(range, 'cloneRange').mockImplementation(() => {
    const local = clone();
    Object.defineProperty(local, 'getClientRects', {
      value: () => {
        const ancestor = local.commonAncestorContainer;
        const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor as Element : ancestor.parentElement!;
        const page_number = Number(element.closest<HTMLElement>('[data-page-number]')!.dataset.pageNumber);
        const top = 220 + (page_number - 1) * 900;
        const line = new DOMRect(110, top, 90, 10);
        // Browsers can return both a span rectangle and the same text box.
        return [line, line, new DOMRect(0, 0, 10, 10)];
      },
    });
    return local;
  });
}

describe('selection anchors across real DOM pages', () => {
  it('clips quotes at page boundaries, preserves line breaks, and excludes untouched pages', () => {
    const pages = fixturePages();
    const range = document.createRange();
    range.setStart(pages[0].text_layer.querySelector('span')!.firstChild!, 7);
    range.setEnd(pages[1].text_layer.querySelector('span')!.firstChild!, 6);
    stubRangeGeometry(range);

    const selection = selectionContext(range, pages);
    expect(selection?.selected_text).toBe('first selection continued\nsecond');
    expect(selection?.page_anchors.map((anchor) => anchor.page_number)).toEqual([1, 2]);
    expect(selection?.page_anchors[0].quad_points).toEqual([[10, 780, 100, 780, 100, 770, 10, 770]]);
    expect(selection?.page_anchors[1].text_quote.exact_text).toBe('second');
    expect(selection?.page_anchors[0].text_quote.prefix).toBe('Before ');
    expect(selection?.context_text).toContain('Page 1: Before first selection continued');
    expect(selection?.context_text).toContain('Page 2: second selection after.');
    expect(selection?.context_text).not.toContain('third page');
  });

  it('keeps a partial word selection limited to the chosen text node offsets', () => {
    const pages = fixturePages();
    const range = document.createRange();
    const text = pages[1].text_layer.querySelector('span')!.firstChild!;
    range.setStart(text, 7);
    range.setEnd(text, 16);
    stubRangeGeometry(range);
    const selection = selectionContext(range, pages);
    expect(selection?.selected_text).toBe('selection');
    expect(selection?.page_anchors).toHaveLength(1);
    expect(selection?.page_anchors[0].text_quote).toMatchObject({ prefix: 'second ', suffix: ' after.' });
  });

  it('does not create annotations for text selected outside the PDF text layers', () => {
    const pages = fixturePages();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('outside')!);
    expect(selectionContext(range, pages)).toBeNull();
  });
});
