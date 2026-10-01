import type { PageAnchor, QuadPoints, SelectionContext } from './types';
import { normalizePdfText, rectToPdfQuad, textQuote } from './pdf-geometry';
import type { PdfCoordinates } from './pdf-geometry';
import { pdfRangeText } from './pdf-text';

export interface SelectionPage {
  page_number: number;
  text_layer: HTMLElement;
  page_element: HTMLElement;
  viewport: PdfCoordinates;
  text: string;
  // Split lines use original character geometry rather than a linear viewport.
  quads_for_range?: (range: Range) => QuadPoints[];
  source_point_for_position?: (position: [number, number]) => [number, number];
  position_for_source_point?: (point: [number, number]) => [number, number];
}

/** Intersect one browser selection with each text layer before saving anchors. */
export function selectionContext(range: Range, pages: SelectionPage[]): SelectionContext | null {
  const page_anchors: PageAnchor[] = [];
  const context_parts: string[] = [];
  for (const page of pages) {
    if (!range.intersectsNode(page.text_layer)) continue;
    const local = range.cloneRange();
    if (!page.text_layer.contains(local.startContainer)) local.setStart(page.text_layer, 0);
    if (!page.text_layer.contains(local.endContainer)) local.setEnd(page.text_layer, page.text_layer.childNodes.length);
    const exact = normalizePdfText(pdfRangeText(local));
    if (!exact) continue;
    const bounds = page.page_element.getBoundingClientRect();
    const seen_quads = new Set<string>();
    const candidates = page.quads_for_range ? page.quads_for_range(local) : [...local.getClientRects()]
      .map((rect) => rectToPdfQuad(rect, bounds, page.viewport));
    const quads = candidates
      .filter((quad): quad is QuadPoints => {
        if (quad === null) return false;
        const key = quad.map((coordinate) => coordinate.toFixed(2)).join(',');
        if (seen_quads.has(key)) return false;
        seen_quads.add(key);
        return true;
      });
    if (!quads.length) continue;
    const prefix_range = document.createRange();
    prefix_range.selectNodeContents(page.text_layer);
    prefix_range.setEnd(local.startContainer, local.startOffset);
    const offset = normalizePdfText(pdfRangeText(prefix_range)).length;
    const quote = textQuote(exact, page.text, offset);
    page_anchors.push({ page_number: page.page_number, quad_points: quads, text_quote: quote });
    const source = normalizePdfText(page.text);
    const found = source.indexOf(quote.exact_text, Math.max(0, offset - 2));
    const position = Math.max(0, found);
    context_parts.push(`Page ${page.page_number}: ${source.slice(Math.max(0, position - 700), position + quote.exact_text.length + 700)}`);
  }
  if (!page_anchors.length) return null;
  return {
    selected_text: page_anchors.map((anchor) => anchor.text_quote.exact_text).join('\n'),
    context_text: context_parts.join('\n\n'),
    page_anchors,
  };
}
