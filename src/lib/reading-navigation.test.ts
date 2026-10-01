import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingLayout, ReadingLocation } from './types';
import { findReadingBlock } from './reading-navigation';

const layout: ReadingLayout = { layout_version: 4, pdf_hash: 'hash', page_count: 1, blocks: [
  { block_id: 'p1-b0', page_number: 1, source_rect: [50, 100, 300, 700], kind: 'text', block_type: 'content', text: 'Left', figure_label: null },
  { block_id: 'p1-b1', page_number: 1, source_rect: [310, 100, 560, 700], kind: 'text', block_type: 'content', text: 'Right', figure_label: null },
] };
const location: ReadingLocation = {
  paper_id: 'paper', page_number: 1, page_position: [0.7, 0.5], zoom: 1, rotation: 0, reader_mode: 'reading', reading_block_id: 'p1-b0',
};
const page = { rotate: 0, getViewport: () => ({ width: 600, height: 800, convertToPdfPoint: (x: number, y: number) => [x, 800 - y] }) } as unknown as PDFPageProxy;

describe('Reading destinations across layout rebuilds', () => {
  it('uses the source point when an old block ID now belongs to the other column', () => {
    expect(findReadingBlock(layout, location, [page])).toBe(layout.blocks[1]);
  });

  it('keeps the matching ID when it still contains the source point', () => {
    expect(findReadingBlock(layout, { ...location, page_position: [0.2, 0.5] }, [page])).toBe(layout.blocks[0]);
  });

  it('keeps an ID as a tie-breaker in removed gutter whitespace', () => {
    expect(findReadingBlock(layout, { ...location, page_position: [305 / 600, 0.5], reading_block_id: 'p1-b1' }, [page])).toBe(layout.blocks[1]);
  });

  it('finds the closest source region when the saved block no longer exists', () => {
    expect(findReadingBlock(layout, { ...location, reading_block_id: 'p1-b4' }, [page])).toBe(layout.blocks[1]);
    expect(findReadingBlock({ ...layout, blocks: [] }, location, [page])).toBeNull();
  });
});
