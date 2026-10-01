import { describe, expect, it } from 'vitest';
import {
  createAdaptiveSplitLineLayout,
  createSplitLineLayout,
  mapSplitDisplayPoint,
  mapSplitDisplayRect,
  mapSplitSourcePoint,
  mapSplitSourceRect,
  refineSplitLineCuts,
  splitLineInkCovered,
} from './pdf-line-layout';
import type { SplitLineLayout, SplitLineRaster, SplitLineRect, SplitLineRow } from './pdf-line-layout';

const rows: SplitLineRow[] = [
  { rect: [0, 2, 96, 12], breaks: [30, 48, 69] },
  { rect: [0, 26, 35, 36], breaks: [] },
];

function fixture(): SplitLineLayout {
  return createSplitLineLayout(100, 40, rows)!;
}

function overlaps(first: SplitLineRect, second: SplitLineRect): boolean {
  return first[0] < second[2] && second[0] < first[2] && first[1] < second[3] && second[1] < first[3];
}

describe('fixed one-to-two PDF line geometry', () => {
  it('splits a long row nearest the source midpoint and preserves a short row', () => {
    const layout = fixture();
    expect(layout.width).toBe(48);
    expect(layout.height).toBe(52);
    expect(layout.pieces).toEqual([
      { source_rect: [0, 0, 48, 13], display_rect: [0, 0, 48, 13] },
      { source_rect: [48, 1, 96, 13], display_rect: [0, 13, 48, 25] },
      { source_rect: [0, 13, 48, 19], display_rect: [0, 25, 48, 31] },
      { source_rect: [0, 19, 35, 40], display_rect: [0, 31, 35, 52] },
    ]);
    expect(mapSplitSourcePoint(layout, [10, 8])).toEqual([10, 8]);
    expect(mapSplitSourcePoint(layout, [60, 8])).toEqual([12, 20]);
    expect(mapSplitSourcePoint(layout, [10, 30])).toEqual([10, 42]);
  });

  it('retains indentation and chooses actual word breaks instead of a geometric cut', () => {
    const layout = createSplitLineLayout(100, 20, [{ rect: [12, 5, 94, 15], breaks: [80, 47, 12, 94, NaN] }])!;
    expect(layout.width).toBe(47);
    expect(mapSplitSourcePoint(layout, [12, 8])?.[0]).toBe(12);
    expect(mapSplitSourcePoint(layout, [52, 8])?.[0]).toBe(5);
    expect(layout.pieces.find((piece) => piece.source_rect[0] === 47)).toBeDefined();
  });

  it('leaves an indented short line intact even when its right edge passes the midpoint', () => {
    const layout = createSplitLineLayout(100, 40, [rows[0], { rect: [20, 26, 60, 36], breaks: [] }])!;
    expect(layout.width).toBe(60);
    expect(layout.cuts).toHaveLength(1);
    expect(mapSplitSourcePoint(layout, [22, 30])).toEqual([22, 42]);
    expect(mapSplitSourcePoint(layout, [58, 30])).toEqual([58, 42]);
  });

  it('does not duplicate large paragraph gaps when inserting continuation lines', () => {
    const layout = createSplitLineLayout(100, 120, [
      { rect: [0, 10, 100, 20], breaks: [50] },
      { rect: [0, 100, 100, 110], breaks: [50] },
    ])!;
    expect(layout.height).toBe(144); // Original 120 plus two padded 12-high lines.
    const first_continuation = mapSplitSourcePoint(layout, [75, 15])!;
    const next_paragraph = mapSplitSourcePoint(layout, [25, 105])!;
    expect(next_paragraph[1] - first_continuation[1]).toBe(90);
  });

  it('keeps pieces disjoint and preserves every glyph point without scaling', () => {
    const layout = fixture();
    for (const piece of layout.pieces) {
      expect(piece.display_rect[2] - piece.display_rect[0]).toBe(piece.source_rect[2] - piece.source_rect[0]);
      expect(piece.display_rect[3] - piece.display_rect[1]).toBe(piece.source_rect[3] - piece.source_rect[1]);
      expect(piece.display_rect[2]).toBeLessThanOrEqual(layout.width);
      expect(piece.display_rect[3]).toBeLessThanOrEqual(layout.height);
    }
    for (let first = 0; first < layout.pieces.length; first++) {
      for (let second = first + 1; second < layout.pieces.length; second++) {
        expect(overlaps(layout.pieces[first].source_rect, layout.pieces[second].source_rect)).toBe(false);
        expect(overlaps(layout.pieces[first].display_rect, layout.pieces[second].display_rect)).toBe(false);
      }
    }
    for (const row of rows) {
      for (let x = row.rect[0]; x < row.rect[2]; x += 0.5) {
        for (let y = row.rect[1]; y < row.rect[3]; y += 0.5) {
          const point: [number, number] = [x, y];
          expect(mapSplitDisplayPoint(layout, mapSplitSourcePoint(layout, point)!)).toEqual(point);
        }
      }
    }
  });

  it('assigns a glyph point exactly on the cut to its continuation line', () => {
    const layout = fixture();
    const display = mapSplitSourcePoint(layout, [48, 8]);
    expect(display).toEqual([0, 20]);
    expect(mapSplitDisplayPoint(layout, display!)).toEqual([48, 8]);
  });

  it('clips highlights and links across a line cut and maps each piece back exactly', () => {
    const layout = fixture();
    const display = mapSplitSourceRect(layout, [40, 4, 60, 10]);
    expect(display).toEqual([[40, 4, 48, 10], [0, 16, 12, 22]]);
    expect(display.flatMap((rect) => mapSplitDisplayRect(layout, rect))).toEqual([
      [40, 4, 48, 10], [48, 4, 60, 10],
    ]);
    expect(mapSplitSourceRect(layout, [80, 26, 90, 36])).toEqual([]);
    expect(mapSplitSourceRect(layout, [0, 0, Infinity, 5])).toEqual([]);
  });

  it('clips a display selection spanning two output lines back into separate source regions', () => {
    expect(mapSplitDisplayRect(fixture(), [5, 10, 15, 17])).toEqual([
      [5, 10, 15, 13], [53, 1, 63, 5],
    ]);
  });

  it('clamps blank-space navigation to the nearest retained region', () => {
    const layout = fixture();
    expect(mapSplitSourcePoint(layout, [40, 30])).toEqual([35, 42]);
    expect(mapSplitDisplayPoint(layout, [40, 42])).toEqual([35, 30]);
    expect(mapSplitSourcePoint(layout, [-5, 8])).toEqual([0, 8]);
    expect(mapSplitDisplayPoint(layout, [NaN, 0])).toBeNull();
  });

  it('handles unordered input without mutating rows or their word boundaries', () => {
    const unordered = [structuredClone(rows[1]), structuredClone(rows[0])];
    unordered[1].breaks.reverse();
    const before = structuredClone(unordered);
    expect(createSplitLineLayout(100, 40, unordered)).toEqual(fixture());
    expect(unordered).toEqual(before);
  });

  it('keeps unsafe or already-short blocks in their original layout', () => {
    expect(createSplitLineLayout(100, 40, [])).toBeNull();
    expect(createSplitLineLayout(NaN, 40, rows)).toBeNull();
    expect(createSplitLineLayout(100, 0, rows)).toBeNull();
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 50, 12], breaks: [25] }])).toBeNull();
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 90, 12], breaks: [] }])).toBeNull();
    expect(createSplitLineLayout(100, 40, [rows[0], { rect: [0, 26, 90, 36], breaks: [] }])).toBeNull();
    expect(createSplitLineLayout(100, 40, [rows[0], { rect: [0, 11, 30, 20], breaks: [] }])).toBeNull();
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 101, 12], breaks: [50] }])).toBeNull();
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 90, Infinity], breaks: [50] }])).toBeNull();
    expect(createSplitLineLayout(100, 1e308, [{ rect: [0, 0, 100, 1e308], breaks: [50] }])).toBeNull();
  });
});

describe('fixed one-to-three PDF line geometry', () => {
  it('chooses two distinct measured thirds and retains the short row', () => {
    const layout = createSplitLineLayout(100, 40, rows, 3)!;
    expect(layout.width).toBe(39);
    expect(layout.height).toBe(64);
    expect(layout.pieces).toEqual([
      { source_rect: [0, 0, 30, 13], display_rect: [0, 0, 30, 13] },
      { source_rect: [30, 1, 69, 13], display_rect: [0, 13, 39, 25] },
      { source_rect: [69, 1, 96, 13], display_rect: [0, 25, 27, 37] },
      { source_rect: [0, 13, 30, 19], display_rect: [0, 37, 30, 43] },
      { source_rect: [0, 19, 35, 40], display_rect: [0, 43, 35, 64] },
    ]);
    expect(layout.cuts).toMatchObject([
      { first_piece_index: 0, continuation_piece_index: 1, trailing_piece_index: 3 },
      { first_piece_index: 1, continuation_piece_index: 2, trailing_piece_index: null },
    ]);
  });

  it('preserves each glyph once and roundtrips points and highlights across both cuts', () => {
    const layout = createSplitLineLayout(100, 40, rows, 3)!;
    for (let first = 0; first < layout.pieces.length; first++) {
      for (let second = first + 1; second < layout.pieces.length; second++) {
        expect(overlaps(layout.pieces[first].source_rect, layout.pieces[second].source_rect)).toBe(false);
        expect(overlaps(layout.pieces[first].display_rect, layout.pieces[second].display_rect)).toBe(false);
      }
    }
    for (let x = 0; x < 96; x += 0.5) {
      const source: [number, number] = [x, 8];
      expect(mapSplitDisplayPoint(layout, mapSplitSourcePoint(layout, source)!)).toEqual(source);
    }
    expect(mapSplitSourcePoint(layout, [30, 8])).toEqual([0, 20]);
    expect(mapSplitSourcePoint(layout, [69, 8])).toEqual([0, 32]);
    const displayed = mapSplitSourceRect(layout, [20, 4, 80, 10]);
    expect(displayed).toEqual([[20, 4, 30, 10], [0, 16, 39, 22], [0, 28, 11, 34]]);
    expect(displayed.flatMap((rect) => mapSplitDisplayRect(layout, rect))).toEqual([
      [20, 4, 30, 10], [30, 4, 69, 10], [69, 4, 80, 10],
    ]);
  });

  it('retains the paragraph gutter once for two inserted continuations', () => {
    const layout = createSplitLineLayout(100, 120, [
      { rect: [0, 10, 100, 20], breaks: [30, 70] },
      { rect: [0, 100, 100, 110], breaks: [30, 70] },
    ], 3)!;
    expect(layout.height).toBe(168);
    const last_continuation = mapSplitSourcePoint(layout, [80, 15])!;
    const next_paragraph = mapSplitSourcePoint(layout, [20, 105])!;
    expect(next_paragraph[1] - last_continuation[1]).toBe(90);
  });

  it('requires two different interior word breaks without splitting short rows', () => {
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 96, 12], breaks: [50, 50] }], 3)).toBeNull();
    expect(createSplitLineLayout(100, 40, [{ rect: [0, 2, 96, 12], breaks: [0, 30, 96, NaN] }], 3)).toBeNull();
    const layout = createSplitLineLayout(100, 40, [rows[0], { rect: [20, 26, 60, 36], breaks: [40] }], 3)!;
    expect(layout.pieces.at(-1)?.source_rect).toEqual([0, 19, 60, 40]);
    expect(layout.cuts).toHaveLength(2);
  });
});

function rasterFixture(width: number, height: number) {
  const raster: SplitLineRaster = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  const pixel = (x: number, y: number, darkness = 0, alpha = 255) => {
    raster.data.set([darkness, darkness, darkness, alpha], (y * width + x) * 4);
  };
  return { raster, pixel };
}

describe('split-line printed ink coverage', () => {
  it('accepts all printed source pixels retained by the strip union', () => {
    const { raster, pixel } = rasterFixture(100, 40);
    for (const [x, y] of [[1, 1], [75, 8], [95, 12], [22, 18], [12, 30]]) pixel(x, y);
    expect(splitLineInkCovered(fixture(), raster, 1)).toBe(true);
  });

  it('ignores white gutters and transparent or faint pixels outside the strips', () => {
    const { raster, pixel } = rasterFixture(100, 40);
    pixel(90, 30, 0, 15);
    pixel(80, 30, 230);
    expect(splitLineInkCovered(fixture(), raster, 1)).toBe(true);
    pixel(80, 30, 229, 16);
    expect(splitLineInkCovered(fixture(), raster, 1)).toBe(false);
  });

  it('rejects a source glyph crossing into an omitted part of a line strip', () => {
    const layout: SplitLineLayout = { width: 4, height: 11, pieces: [
      { source_rect: [0, 0, 4, 8], display_rect: [0, 0, 4, 8] },
      { source_rect: [4, 0, 8, 3], display_rect: [0, 8, 4, 11] },
    ] };
    const { raster, pixel } = rasterFixture(8, 8);
    pixel(2, 5);
    pixel(3, 5);
    expect(splitLineInkCovered(layout, raster, 1)).toBe(true);
    pixel(5, 5);
    pixel(6, 5);
    expect(splitLineInkCovered(layout, raster, 1)).toBe(false);
  });

  it('allows one raster pixel at an antialiased edge without growing the guard at high zoom', () => {
    const { raster, pixel } = rasterFixture(400, 160);
    pixel(384, 32); // Exactly one raster pixel beyond the source strip at x=96.
    expect(splitLineInkCovered(fixture(), raster, 4)).toBe(true);
    pixel(385, 32);
    expect(splitLineInkCovered(fixture(), raster, 4)).toBe(false);
  });

  it('detects missed ink above or below the retained second half', () => {
    const { raster, pixel } = rasterFixture(100, 40);
    pixel(75, 13); // One-pixel edge guard below the second half ending at y=13.
    expect(splitLineInkCovered(fixture(), raster, 1)).toBe(true);
    pixel(75, 14);
    expect(splitLineInkCovered(fixture(), raster, 1)).toBe(false);
  });

  it('checks uncovered scanline intervals between disjoint pieces', () => {
    const layout: SplitLineLayout = { width: 6, height: 4, pieces: [
      { source_rect: [0, 0, 2, 4], display_rect: [0, 0, 2, 4] },
      { source_rect: [6, 0, 8, 4], display_rect: [2, 0, 4, 4] },
    ] };
    const { raster, pixel } = rasterFixture(8, 4);
    expect(splitLineInkCovered(layout, raster, 1)).toBe(true);
    pixel(4, 2);
    expect(splitLineInkCovered(layout, raster, 1)).toBe(false);
  });

  it('fails safely for an invalid raster, scale, or source rectangle', () => {
    const { raster } = rasterFixture(100, 40);
    expect(splitLineInkCovered(fixture(), raster, 0)).toBe(false);
    expect(splitLineInkCovered(fixture(), raster, NaN)).toBe(false);
    expect(splitLineInkCovered(fixture(), { ...raster, data: new Uint8ClampedArray(4) }, 1)).toBe(false);
    expect(splitLineInkCovered(fixture(), { ...raster, height: 0 }, 1)).toBe(false);
    expect(splitLineInkCovered({ width: 1, height: 1, pieces: [] }, raster, 1)).toBe(false);
    const invalid = fixture();
    invalid.pieces[0].source_rect = [0, 0, Infinity, 2];
    expect(splitLineInkCovered(invalid, raster, 1)).toBe(false);
  });
});

describe('printed whitespace refinement at line cuts', () => {
  function printedLine(gap_start: number, gap_end: number) {
    const layout = createSplitLineLayout(100, 10, [{ rect: [0, 0, 100, 10], breaks: [50] }])!;
    const { raster, pixel } = rasterFixture(400, 40);
    for (let y = 8; y < 32; y++) for (let x = 0; x < 400; x++) {
      if (x < gap_start * 4 || x >= gap_end * 4) pixel(x, y);
    }
    return { layout, raster };
  }

  it('moves a cut out of a printed glyph into nearby word whitespace', () => {
    const { layout, raster } = printedLine(45, 49);
    // All ink is retained even by the bad cut; coverage alone cannot detect a
    // letter split between the end of one line and the start of the next.
    expect(splitLineInkCovered(layout, raster, 4)).toBe(true);
    const before = structuredClone(layout);
    const refined = refineSplitLineCuts(layout, raster, 4)!;
    expect(refined.pieces[0].source_rect[2]).toBe(47);
    expect(refined.pieces[1].source_rect[0]).toBe(47);
    expect(refined.width).toBe(53);
    expect(refined.height).toBe(layout.height);
    expect(splitLineInkCovered(refined, raster, 4)).toBe(true);
    expect(mapSplitDisplayPoint(refined, mapSplitSourcePoint(refined, [49.5, 5])!)).toEqual([49.5, 5]);
    expect(layout).toEqual(before);
  });

  it('keeps safe cuts stable and makes refinement idempotent', () => {
    const safe = printedLine(48, 52);
    expect(refineSplitLineCuts(safe.layout, safe.raster, 4)).toBe(safe.layout);
    const shifted = printedLine(45, 49);
    const refined = refineSplitLineCuts(shifted.layout, shifted.raster, 4)!;
    expect(refineSplitLineCuts(refined, shifted.raster, 4)).toBe(refined);
  });

  it('rejects a cut with no nearby safe gutter instead of splitting a glyph', () => {
    const blocked = printedLine(0, 0);
    expect(refineSplitLineCuts(blocked.layout, blocked.raster, 4)).toBeNull();
    const distant = printedLine(30, 34);
    expect(refineSplitLineCuts(distant.layout, distant.raster, 4)).toBeNull();
    const letter_gap = printedLine(49.5, 50.25);
    expect(refineSplitLineCuts(letter_gap.layout, letter_gap.raster, 4)).toBeNull();
  });

  it('updates a row gutter without changing the following line or fragment order', () => {
    const layout = fixture();
    const { raster, pixel } = rasterFixture(400, 160);
    for (let y = 8; y < 48; y++) for (let x = 0; x < 384; x++) {
      if (x < 43 * 4 || x >= 47 * 4) pixel(x, y);
    }
    const refined = refineSplitLineCuts(layout, raster, 4)!;
    expect(refined.pieces).toHaveLength(layout.pieces.length);
    expect(refined.pieces[2].source_rect[2]).toBe(45);
    expect(refined.pieces[3]).toEqual(layout.pieces[3]);
    expect(refined.cuts).toEqual(layout.cuts);
  });

  it('composes both refinements to the shared middle strip and its one trailing gutter', () => {
    const layout = createSplitLineLayout(100, 40, rows, 3)!;
    const { raster, pixel } = rasterFixture(400, 160);
    for (let y = 8; y < 48; y++) for (let x = 0; x < 384; x++) {
      if (!(x >= 26 * 4 && x < 30 * 4) && !(x >= 70 * 4 && x < 74 * 4)) pixel(x, y);
    }
    const refined = refineSplitLineCuts(layout, raster, 4)!;
    expect(refined.pieces[0].source_rect[2]).toBe(28);
    expect(refined.pieces[1].source_rect).toEqual([28, 1, 72, 13]);
    expect(refined.pieces[1].display_rect).toEqual([0, 13, 44, 25]);
    expect(refined.pieces[2].source_rect[0]).toBe(72);
    expect(refined.pieces[3].source_rect[2]).toBe(28);
    expect(refined.pieces[4]).toEqual(layout.pieces[4]);
    expect(refined.width).toBe(44);
    expect(refineSplitLineCuts(refined, raster, 4)).toBe(refined);
    expect(splitLineInkCovered(refined, raster, 4)).toBe(true);
  });

  it('rejects three lines if either boundary lacks a printed word gutter', () => {
    const layout = createSplitLineLayout(100, 10, [{ rect: [0, 0, 100, 10], breaks: [30, 70] }], 3)!;
    const { raster, pixel } = rasterFixture(400, 40);
    for (let y = 8; y < 32; y++) for (let x = 0; x < 400; x++) {
      if (x < 28 * 4 || x >= 32 * 4) pixel(x, y);
    }
    expect(refineSplitLineCuts(layout, raster, 4)).toBeNull();
  });
});

describe('per-row adaptive split geometry', () => {
  const mixed_rows: SplitLineRow[] = [
    { rect: [0, 2, 100, 12], breaks: [30, 50, 70] },
    { rect: [0, 22, 100, 32], breaks: [30, 50, 70] },
    { rect: [0, 42, 100, 52], breaks: [30, 50, 70] },
    { rect: [10, 62, 50, 72], breaks: [] },
  ];

  function mixedRaster() {
    const { raster, pixel } = rasterFixture(400, 320);
    for (let row = 0; row < 4; row++) {
      for (let y = mixed_rows[row].rect[1] * 4; y < mixed_rows[row].rect[3] * 4; y++) {
        for (let x = mixed_rows[row].rect[0] * 4; x < mixed_rows[row].rect[2] * 4; x++) {
          if (row === 0 && x >= 48 * 4 && x < 52 * 4) continue;
          if (row === 1 && ((x >= 28 * 4 && x < 32 * 4) || (x >= 68 * 4 && x < 72 * 4))) continue;
          pixel(x, y);
        }
      }
    }
    return raster;
  }

  it('tries two, then three, then a smaller original line independently per row', () => {
    const provisional = createAdaptiveSplitLineLayout(100, 80, mixed_rows)!;
    expect(provisional.line_counts).toEqual([2, 2, 2, 1]);
    const raster = mixedRaster();
    const layout = createAdaptiveSplitLineLayout(100, 80, mixed_rows, raster, 4)!;
    expect(layout.line_counts).toEqual([2, 3, 1, 1]);
    expect(layout.fit_width).toBe(provisional.fit_width);
    expect(layout.fit_width).toBe(50);
    expect(layout.width).toBe(50);
    expect(layout.height).toBe(106);
    expect(splitLineInkCovered(layout, raster, 4)).toBe(true);
    const retained = layout.pieces.find((piece) => piece.source_rect[1] === 37 && piece.source_rect[3] === 57)!;
    expect(retained.source_rect).toEqual([0, 37, 100, 57]);
    expect(retained.display_rect).toEqual([0, 73, 50, 83]);
    const short = layout.pieces.at(-1)!;
    expect(short.source_rect).toEqual([0, 57, 50, 80]);
    expect(short.display_rect).toEqual([0, 83, 50, 106]);
  });

  it('keeps three-line and two-line glyphs at the same size while scaling only the fallback row', () => {
    const layout = createAdaptiveSplitLineLayout(100, 80, mixed_rows, mixedRaster(), 4)!;
    const point_scales = [[10, 8], [40, 28], [10, 48], [20, 68]] as const;
    for (const [x, y] of point_scales) {
      const start = mapSplitSourcePoint(layout, [x, y])!;
      const end = mapSplitSourcePoint(layout, [x + 1, y + 1])!;
      const expected = y === 48 ? 0.5 : 1;
      expect(end[0] - start[0]).toBe(expected);
      expect(end[1] - start[1]).toBe(expected);
      expect(mapSplitDisplayPoint(layout, start)).toEqual([x, y]);
    }
    const source: SplitLineRect = [10, 44, 90, 50];
    const displayed = mapSplitSourceRect(layout, source);
    expect(displayed).toEqual([[5, 76.5, 45, 79.5]]);
    expect(displayed.flatMap((rect) => mapSplitDisplayRect(layout, rect))).toEqual([source]);
  });

  it('retains an unbreakable long line at a smaller size without blocking another row', () => {
    const layout = createAdaptiveSplitLineLayout(100, 40, [
      rows[0], { rect: [0, 26, 96, 36], breaks: [] },
    ])!;
    expect(layout.line_counts).toEqual([2, 1]);
    expect(layout.fit_width).toBe(50);
    expect(layout.width).toBe(50);
    expect(layout.pieces.at(-1)?.source_rect).toEqual([0, 19, 100, 40]);
    expect(layout.pieces.at(-1)?.display_rect).toEqual([0, 31, 50, 41.5]);
  });

  it('does not shrink every row when a short indented row widens the fitting width', () => {
    const layout = createAdaptiveSplitLineLayout(100, 40, [rows[0], { rect: [20, 26, 60, 36], breaks: [] }])!;
    expect(layout.fit_width).toBe(60);
    expect(layout.width).toBe(60);
    expect(mapSplitSourcePoint(layout, [22, 30])).toEqual([22, 42]);
  });

  it('keeps every original line small when no row has a safe split', () => {
    const layout = createAdaptiveSplitLineLayout(100, 20, [{ rect: [0, 5, 100, 15], breaks: [] }])!;
    expect(layout.line_counts).toEqual([1]);
    expect(layout.fit_width).toBe(50);
    expect(layout.pieces).toEqual([{ source_rect: [0, 0, 100, 20], display_rect: [0, 0, 50, 10] }]);
    expect(mapSplitDisplayPoint(layout, [25, 5])).toEqual([50, 10]);
  });

  it('rejects cuts that would overflow the common fitting width after refinement', () => {
    const one_row: SplitLineRow[] = [{ rect: [0, 0, 100, 10], breaks: [50] }];
    const { raster, pixel } = rasterFixture(400, 40);
    for (let y = 8; y < 32; y++) for (let x = 0; x < 400; x++) {
      if (x < 45 * 4 || x >= 49 * 4) pixel(x, y);
    }
    const layout = createAdaptiveSplitLineLayout(100, 10, one_row, raster, 4)!;
    expect(layout.line_counts).toEqual([1]);
    expect(layout.width).toBe(50);
    expect(splitLineInkCovered(layout, raster, 4)).toBe(true);
  });

  it('retains prior safe raster cuts instead of returning to measured boundaries on every render', () => {
    const one_row: SplitLineRow[] = [{ rect: [0, 0, 96, 10], breaks: [30, 50, 65] }];
    const print = (gap_end: number) => {
      const { raster, pixel } = rasterFixture(400, 40);
      for (let y = 8; y < 32; y++) for (let x = 0; x < 384; x++) {
        if (x < 45 * 4 || x >= gap_end * 4) pixel(x, y);
      }
      return raster;
    };
    const first = createAdaptiveSplitLineLayout(100, 10, one_row, print(49), 4)!;
    expect(first.line_counts).toEqual([2]);
    expect(first.pieces[0].source_rect[2]).toBe(47);
    const next_raster = print(51);
    const stable = createAdaptiveSplitLineLayout(100, 10, one_row, next_raster, 4, first)!;
    expect(stable).toEqual(first);
    const fresh = createAdaptiveSplitLineLayout(100, 10, one_row, next_raster, 4)!;
    expect(fresh.pieces[0].source_rect[2]).toBe(50);
  });

  it('keeps prior small-row fallbacks stable and retries when a prior cut becomes unsafe', () => {
    const raster = mixedRaster();
    const first = createAdaptiveSplitLineLayout(100, 80, mixed_rows, raster, 4)!;
    const stable = createAdaptiveSplitLineLayout(100, 80, mixed_rows, raster, 4, first)!;
    expect(stable).toEqual(first);
    for (let y = 8; y < 48; y++) for (let x = 0; x < 400; x++) {
      raster.data.set([0, 0, 0, 255], (y * 400 + x) * 4);
    }
    const changed = createAdaptiveSplitLineLayout(100, 80, mixed_rows, raster, 4, first)!;
    expect(changed.line_counts).toEqual([1, 3, 1, 1]);
    expect(changed.fit_width).toBe(first.fit_width);
    expect(changed.width).toBeLessThanOrEqual(changed.fit_width!);
  });

  it('retains unmodelled gutter ink without dropping it from a short row', () => {
    const { raster, pixel } = rasterFixture(100, 40);
    pixel(80, 30);
    const layout = createAdaptiveSplitLineLayout(100, 40, rows, raster, 1)!;
    expect(layout.line_counts).toEqual([2, 1]);
    expect(layout.pieces.at(-1)?.source_rect).toEqual([0, 19, 100, 40]);
    expect(splitLineInkCovered(layout, raster, 1)).toBe(true);
  });

  it('merges vertically overlapping glyph rows before moving or scaling their pixels', () => {
    const close_rows = mixed_rows.slice(0, 3);
    const { raster, pixel } = rasterFixture(400, 240);
    for (const row of close_rows) {
      for (let y = row.rect[1] * 4; y < row.rect[3] * 4; y++) for (let x = 0; x < 400; x++) {
        if (x < 48 * 4 || x >= 52 * 4) pixel(x, y);
      }
    }
    // Font metrics placed this printed mark between rows. Cutting at the
    // measured midpoint would move two halves of the same glyph separately.
    pixel(10, 67);
    pixel(10, 68);
    const layout = createAdaptiveSplitLineLayout(100, 60, close_rows, raster, 4)!;
    expect(layout.line_counts).toEqual([1, 1, 2]);
    expect(layout.pieces[0]).toEqual({ source_rect: [0, 0, 100, 37], display_rect: [0, 0, 50, 18.5] });
    expect(layout.pieces[1].source_rect[1]).toBe(37);
    expect(layout.height).toBe(53.5);
    expect(splitLineInkCovered(layout, raster, 4)).toBe(true);
    expect(mapSplitSourcePoint(layout, [10, 16.5])).toEqual([5, 8.25]);
    expect(mapSplitSourcePoint(layout, [10, 17.5])).toEqual([5, 8.75]);
    const across: SplitLineRect = [5, 16, 15, 18];
    const display = mapSplitSourceRect(layout, across);
    expect(display).toEqual([[2.5, 8, 7.5, 9]]);
    expect(display.flatMap((rect) => mapSplitDisplayRect(layout, rect))).toEqual([across]);
  });

  it('merges connected unsafe row boundaries as one smaller band and retains it across rerenders', () => {
    const close_rows = mixed_rows.slice(0, 3);
    const { raster, pixel } = rasterFixture(400, 240);
    pixel(10, 68);
    pixel(20, 148);
    const layout = createAdaptiveSplitLineLayout(100, 60, close_rows, raster, 4)!;
    expect(layout.line_counts).toEqual([1, 1, 1]);
    expect(layout.pieces).toEqual([{ source_rect: [0, 0, 100, 60], display_rect: [0, 0, 50, 30] }]);
    const blank = rasterFixture(400, 240).raster;
    expect(createAdaptiveSplitLineLayout(100, 60, close_rows, blank, 4, layout)).toEqual(layout);
    // A fresh block with genuinely separate rows still uses two lines each.
    expect(createAdaptiveSplitLineLayout(100, 60, close_rows, blank, 4)?.line_counts).toEqual([2, 2, 2]);
  });

  it('fails safely for invalid rows or raster inputs', () => {
    expect(createAdaptiveSplitLineLayout(100, 40, [])).toBeNull();
    expect(createAdaptiveSplitLineLayout(100, 40, [rows[0], { rect: [0, 11, 90, 20], breaks: [50] }])).toBeNull();
    const { raster } = rasterFixture(100, 40);
    expect(createAdaptiveSplitLineLayout(100, 40, rows, raster)).toBeNull();
    expect(createAdaptiveSplitLineLayout(100, 40, rows, raster, 0)).toBeNull();
    expect(createAdaptiveSplitLineLayout(100, 40, rows, { ...raster, data: new Uint8ClampedArray(4) }, 1)).toBeNull();
  });
});
