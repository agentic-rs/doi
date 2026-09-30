import type { Annotation, PageAnchor, PdfSourceRect, QuadPoints, ReadingLayout } from './types';

export interface ReadingNote {
  annotation: Annotation;
  anchor: PageAnchor;
}

type Point = [number, number];

/** Clip each source quad independently: their combined bounds can span columns. */
function intersectsBlock(quad: QuadPoints, rect: PdfSourceRect): boolean {
  if (!quad.every(Number.isFinite) || !rect.every(Number.isFinite)) return false;
  let polygon: Point[] = [[quad[0], quad[1]], [quad[2], quad[3]], [quad[4], quad[5]], [quad[6], quad[7]]];
  for (const [axis, edge, direction] of [[0, rect[0], 1], [0, rect[2], -1], [1, rect[1], 1], [1, rect[3], -1]] as const) {
    const clipped: Point[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const start_inside = direction * (start[axis] - edge) >= 0;
      const end_inside = direction * (end[axis] - edge) >= 0;
      if (start_inside) clipped.push(start);
      if (start_inside !== end_inside) {
        const fraction = (edge - start[axis]) / (end[axis] - start[axis]);
        clipped.push([start[0] + fraction * (end[0] - start[0]), start[1] + fraction * (end[1] - start[1])]);
      }
    }
    polygon = clipped;
  }
  const area = polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  return Math.abs(area) > 0.000001;
}

/** Ownership uses original PDF coordinates, independent of display order/scale. */
export function mapReadingNotes(layout: ReadingLayout | null, annotations: Annotation[], paper_id: string, pdf_hash: string): Map<string, ReadingNote[]> {
  const notes = new Map<string, ReadingNote[]>();
  if (!layout || layout.pdf_hash !== pdf_hash) return notes;
  const matching = annotations.filter((annotation) => annotation.target.paper_id === paper_id && annotation.target.pdf_hash === pdf_hash);
  for (const block of layout.blocks) {
    const entries: ReadingNote[] = [];
    const seen = new Set<string>();
    for (const annotation of matching) {
      if (seen.has(annotation.annotation_id)) continue;
      for (const anchor of annotation.target.page_anchors) {
        if (anchor.page_number !== block.page_number) continue;
        const quad_points = anchor.quad_points.filter((quad) => intersectsBlock(quad, block.source_rect));
        if (!quad_points.length) continue;
        entries.push({ annotation, anchor: { ...anchor, quad_points } });
        seen.add(annotation.annotation_id);
        break;
      }
    }
    if (entries.length) notes.set(block.block_id, entries);
  }
  return notes;
}
