import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingLayout, ReadingLocation } from './types';
import { regionGeometry } from './pdf-region';
import { clamp } from './pdf-geometry';

type Region = ReturnType<typeof regionGeometry>;

/** Persist points in the full original page even when a crop moves elsewhere. */
export function locationInRegion(position: [number, number], region: Region): [number, number] {
  return [
    clamp((region.left + position[0] * region.width) / region.viewport.width, 0, 1),
    clamp((region.top + position[1] * region.height) / region.viewport.height, 0, 1),
  ];
}

export function positionInRegion(location: ReadingLocation, region: Region): [number, number] {
  return [
    clamp((location.page_position[0] * region.viewport.width - region.left) / region.width, 0, 1),
    clamp((location.page_position[1] * region.viewport.height - region.top) / region.height, 0, 1),
  ];
}

export function findReadingBlock(layout: ReadingLayout, location: ReadingLocation, pages: PDFPageProxy[]) {
  const candidates = layout.blocks.filter((block) => block.page_number === location.page_number);
  const exact = candidates.find((block) => block.block_id === location.reading_block_id);
  if (exact) return exact;
  const page = pages[location.page_number - 1];
  if (!page) return candidates[0] ?? null;
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + location.rotation) % 360 });
  const point = viewport.convertToPdfPoint(location.page_position[0] * viewport.width, location.page_position[1] * viewport.height);
  // If whitespace was removed, choose the closest retained region on this page.
  return candidates.reduce<typeof candidates[number] | null>((best, block) => {
    const distance = (rect: number[]) => Math.hypot(point[0] - clamp(point[0], rect[0], rect[2]), point[1] - clamp(point[1], rect[1], rect[3]));
    return !best || distance(block.source_rect) < distance(best.source_rect) ? block : best;
  }, null);
}
