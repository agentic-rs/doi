import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfSourceRect } from './types';
import { clamp } from './pdf-geometry';

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

export interface PdfRegionGeometry {
  viewport: PageViewport;
  render_viewport: PageViewport;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keep source coordinates unchanged when a region becomes its own canvas. */
export function regionGeometry(page: PDFPageProxy, zoom: number, rotation: number, source_rect?: PdfSourceRect): PdfRegionGeometry {
  const page_rotation = (page.rotate + rotation) % 360;
  const viewport = page.getViewport({ scale: zoom, rotation: page_rotation });
  const full = { viewport, render_viewport: viewport, left: 0, top: 0, width: viewport.width, height: viewport.height };
  if (!source_rect || !source_rect.every(Number.isFinite)) return full;
  const rect = viewport.convertToViewportRectangle(source_rect);
  const left = clamp(Math.min(rect[0], rect[2]), 0, viewport.width);
  const top = clamp(Math.min(rect[1], rect[3]), 0, viewport.height);
  const right = clamp(Math.max(rect[0], rect[2]), 0, viewport.width);
  const bottom = clamp(Math.max(rect[1], rect[3]), 0, viewport.height);
  if (right <= left || bottom <= top) return full;
  const render_viewport = page.getViewport({ scale: zoom, rotation: page_rotation, offsetX: -left, offsetY: -top });
  // PDF.js draws using this viewport's translated transform; the smaller
  // canvas clips vector graphics, images and their labels together.
  render_viewport.width = right - left;
  render_viewport.height = bottom - top;
  return { viewport, render_viewport, left, top, width: right - left, height: bottom - top };
}

/** Remove off-region text before PDF.js creates selectable text nodes. */
export function regionTextContent(content: PdfTextContent, source_rect: PdfSourceRect): PdfTextContent {
  const [left, bottom, right, top] = source_rect;
  const items = content.items.filter((item) => {
    // Text extraction uses ordinary content (without marked-content tags).
    if (!('str' in item)) return false;
    const [a, b, c, d, x, y] = item.transform as number[];
    if (![a, b, c, d, x, y, item.width, item.height].every(Number.isFinite)) return false;
    const style = content.styles[item.fontName];
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : 0.8;
    const descent = Number.isFinite(style?.descent) ? style.descent : -0.2;
    const vertical = style?.vertical || item.dir === 'ttb';
    const direction_x = vertical ? c : a;
    const direction_y = vertical ? d : b;
    const direction_length = Math.hypot(direction_x, direction_y) || 1;
    const extent = vertical ? item.height : item.width;
    const advance_x = direction_x / direction_length * extent;
    const advance_y = direction_y / direction_length * extent;
    const font_x = vertical ? a : c;
    const font_y = vertical ? b : d;
    // Center ownership avoids duplicate selectable text when neighboring
    // blocks meet at a cut. Segmentation keeps cuts out of text lines.
    const center_x = x + advance_x / 2 + font_x * (ascent + descent) / 2;
    const center_y = y + advance_y / 2 + font_y * (ascent + descent) / 2;
    return center_x >= left && center_x < right && center_y >= bottom && center_y < top;
  });
  return { ...content, items };
}
