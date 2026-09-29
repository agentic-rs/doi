import type { QuadPoints, TextQuote } from './types';

export interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PdfCoordinates {
  convertToPdfPoint: (x: number, y: number) => number[];
  convertToViewportPoint: (x: number, y: number) => number[];
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizePdfText(text: string): string {
  return text.normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
}

export function textQuote(exact_text: string, page_text: string, offset?: number): TextQuote {
  const exact = normalizePdfText(exact_text);
  const text = normalizePdfText(page_text);
  const found = text.indexOf(exact, Math.max(0, (offset ?? 0) - 2));
  const index = found === -1 ? text.indexOf(exact) : found;
  return {
    exact_text: exact,
    prefix: index < 0 ? '' : text.slice(Math.max(0, index - 96), index),
    suffix: index < 0 ? '' : text.slice(index + exact.length, index + exact.length + 96),
    normalization_version: 1,
  };
}

// Store the four visual corners in PDF space, rather than screen pixels. This
// also preserves a rectangle's orientation on rotated or cropped pages.
export function rectToPdfQuad(rect: RectBounds, page_bounds: RectBounds, viewport: PdfCoordinates): QuadPoints | null {
  const left = Math.max(rect.left, page_bounds.left);
  const top = Math.max(rect.top, page_bounds.top);
  const right = Math.min(rect.right, page_bounds.right);
  const bottom = Math.min(rect.bottom, page_bounds.bottom);
  if (right - left < 0.5 || bottom - top < 0.5) return null;
  const points = [[left, top], [right, top], [right, bottom], [left, bottom]];
  return points.flatMap(([x, y]) => viewport.convertToPdfPoint(x - page_bounds.left, y - page_bounds.top)) as QuadPoints;
}

export function quadToSvgPoints(quad: QuadPoints, viewport: PdfCoordinates): string {
  const points: string[] = [];
  for (let index = 0; index < quad.length; index += 2) {
    points.push(viewport.convertToViewportPoint(quad[index], quad[index + 1]).join(','));
  }
  return points.join(' ');
}

export function anchorViewportPosition(quads: QuadPoints[], viewport: PdfCoordinates, width: number, height: number): [number, number] {
  const points = quads.flatMap((quad) => {
    const result: number[][] = [];
    for (let index = 0; index < quad.length; index += 2) result.push(viewport.convertToViewportPoint(quad[index], quad[index + 1]));
    return result;
  });
  if (!points.length) return [0, 0];
  return [
    clamp(Math.min(...points.map(([x]) => x)) / width - 0.05, 0, 1),
    clamp(Math.min(...points.map(([, y]) => y)) / height - 0.05, 0, 1),
  ];
}

export function safeReferenceUrl(value: string): string | null {
  try {
    if (value.length > 8192 || new TextEncoder().encode(value).byteLength > 8192) return null;
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    // The canonical URL is sent to native validation, so it must fit there too.
    if (new TextEncoder().encode(parsed.href).byteLength > 8192) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
