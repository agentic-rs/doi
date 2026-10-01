/** Top-left coordinates in an unscaled PDF crop or its split-line display. */
export type SplitLineRect = [number, number, number, number];
export type SplitLinePoint = [number, number];

export interface SplitLineRow {
  rect: SplitLineRect;
  // Safe whitespace cuts measured in the original text layer, never estimated
  // from character counts. A cut may fall inside one PDF text item.
  breaks: number[];
}

export interface SplitLinePiece {
  source_rect: SplitLineRect;
  display_rect: SplitLineRect;
}

export interface SplitLineLayout {
  width: number;
  height: number;
  pieces: SplitLinePiece[];
  cuts?: SplitLineCut[];
}

export interface SplitLineCut {
  first_piece_index: number;
  continuation_piece_index: number;
  trailing_piece_index: number | null;
  search_radius: number;
  minimum_gap: number;
}

export interface SplitLineRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function validRect(rect: SplitLineRect): boolean {
  return rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3];
}

function contains(rect: SplitLineRect, point: SplitLinePoint): boolean {
  // Give a shared cut to exactly one piece, including when its text begins
  // precisely on the next display line.
  return point[0] >= rect[0] && point[0] < rect[2] && point[1] >= rect[1] && point[1] < rect[3];
}

function clampPoint(point: SplitLinePoint, rect: SplitLineRect): SplitLinePoint {
  return [Math.max(rect[0], Math.min(rect[2], point[0])), Math.max(rect[1], Math.min(rect[3], point[1]))];
}

/**
 * Make each long source line two display lines, preserving its printed pixels.
 * Short lines stay intact. The caller must provide complete, nonoverlapping
 * glyph rows and safe word boundaries; unsafe crops retain their original view.
 */
export function createSplitLineLayout(width: number, height: number, rows: readonly SplitLineRow[]): SplitLineLayout | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !rows.length) return null;
  const ordered = [...rows].sort((first, second) => first.rect[1] - second.rect[1]);
  for (let index = 0; index < ordered.length; index++) {
    const rect = ordered[index].rect;
    if (!validRect(rect) || rect[0] < 0 || rect[1] < 0 || rect[2] > width || rect[3] > height
      || (index > 0 && rect[1] < ordered[index - 1].rect[3])) return null;
  }
  const midpoint = width / 2;
  const cuts = ordered.map((row) => {
    if (row.rect[2] - row.rect[0] <= midpoint) return null;
    const safe = row.breaks.filter((cut) => Number.isFinite(cut) && cut > row.rect[0] && cut < row.rect[2]).sort((a, b) => a - b);
    return safe.reduce<number | null>((best, cut) => best === null || Math.abs(cut - midpoint) < Math.abs(best - midpoint) ? cut : best, null);
  });
  // A long unbreakable row would either lose text or force the narrower view
  // back to the original width. Keep the entire block intact in that case.
  if (!cuts.some((cut) => cut !== null) || ordered.some((row, index) => row.rect[2] - row.rect[0] > midpoint && cuts[index] === null)) return null;

  const heights = ordered.map((row) => row.rect[3] - row.rect[1]).sort((a, b) => a - b);
  const padding = heights[Math.floor(heights.length / 2)] * 0.1;
  const pieces: SplitLinePiece[] = [];
  const cut_regions: SplitLineCut[] = [];
  let display_top = 0;
  let display_width = 0;
  const append = (source_rect: SplitLineRect, top: number) => {
    if (!validRect(source_rect)) return;
    const piece_width = source_rect[2] - source_rect[0];
    const piece_height = source_rect[3] - source_rect[1];
    pieces.push({ source_rect, display_rect: [0, top, piece_width, top + piece_height] });
    display_width = Math.max(display_width, piece_width);
  };

  ordered.forEach((row, index) => {
    const band_top = index === 0 ? 0 : (ordered[index - 1].rect[3] + row.rect[1]) / 2;
    const band_bottom = index === ordered.length - 1 ? height : (row.rect[3] + ordered[index + 1].rect[1]) / 2;
    const band_height = band_bottom - band_top;
    const cut = cuts[index];
    if (cut === null) {
      append([0, band_top, row.rect[2], band_bottom], display_top);
      display_top += band_height;
      return;
    }

    // Retain the first half's original vertical band, but insert the second
    // half before its trailing gutter. Only the inserted line gets a bounded
    // amount of padding, so paragraph gaps are retained once, not doubled.
    const second_top = Math.max(band_top, row.rect[1] - padding);
    const second_bottom = Math.min(band_bottom, row.rect[3] + padding);
    const second_height = second_bottom - second_top;
    const first_height = second_bottom - band_top;
    const first_piece_index = pieces.length;
    append([0, band_top, cut, second_bottom], display_top);
    append([cut, second_top, row.rect[2], second_bottom], display_top + first_height);
    const trailing_piece_index = second_bottom < band_bottom ? pieces.length : null;
    append([0, second_bottom, cut, band_bottom], display_top + first_height + second_height);
    const row_height = row.rect[3] - row.rect[1];
    cut_regions.push({ first_piece_index, continuation_piece_index: first_piece_index + 1, trailing_piece_index,
      search_radius: Math.max(1, row_height * 0.45), minimum_gap: Math.max(0.4, row_height * 0.12) });
    display_top += band_height + second_height;
  });

  return Number.isFinite(display_top) ? { width: display_width, height: display_top, pieces, cuts: cut_regions } : null;
}

function mapPoint(layout: SplitLineLayout, point: SplitLinePoint, from: 'source_rect' | 'display_rect'): SplitLinePoint | null {
  if (!point.every(Number.isFinite) || !layout.pieces.length) return null;
  let piece = layout.pieces.find((candidate) => contains(candidate[from], point));
  if (!piece) {
    // Discarded trailing whitespace still has a useful navigation destination.
    // Clamp to the nearest retained region instead of inventing a linear map.
    let nearest_distance = Infinity;
    for (const candidate of layout.pieces) {
      const clamped = clampPoint(point, candidate[from]);
      const distance = Math.hypot(point[0] - clamped[0], point[1] - clamped[1]);
      if (distance < nearest_distance) { piece = candidate; nearest_distance = distance; }
    }
  }
  if (!piece) return null;
  const origin = piece[from];
  const destination = piece[from === 'source_rect' ? 'display_rect' : 'source_rect'];
  const clamped = clampPoint(point, origin);
  return [destination[0] + clamped[0] - origin[0], destination[1] + clamped[1] - origin[1]];
}

export function mapSplitSourcePoint(layout: SplitLineLayout, point: SplitLinePoint): SplitLinePoint | null {
  return mapPoint(layout, point, 'source_rect');
}

export function mapSplitDisplayPoint(layout: SplitLineLayout, point: SplitLinePoint): SplitLinePoint | null {
  return mapPoint(layout, point, 'display_rect');
}

function mapRect(layout: SplitLineLayout, rect: SplitLineRect, from: 'source_rect' | 'display_rect'): SplitLineRect[] {
  if (!validRect(rect)) return [];
  return layout.pieces.flatMap((piece) => {
    const origin = piece[from];
    const clipped: SplitLineRect = [Math.max(rect[0], origin[0]), Math.max(rect[1], origin[1]), Math.min(rect[2], origin[2]), Math.min(rect[3], origin[3])];
    if (!validRect(clipped)) return [];
    const destination = piece[from === 'source_rect' ? 'display_rect' : 'source_rect'];
    const dx = destination[0] - origin[0];
    const dy = destination[1] - origin[1];
    return [[clipped[0] + dx, clipped[1] + dy, clipped[2] + dx, clipped[3] + dy] as SplitLineRect];
  });
}

/** Clip a source highlight/link at each cut, then translate its visible parts. */
export function mapSplitSourceRect(layout: SplitLineLayout, rect: SplitLineRect): SplitLineRect[] {
  return mapRect(layout, rect, 'source_rect');
}

/** Recover source selection rectangles independently for every display line. */
export function mapSplitDisplayRect(layout: SplitLineLayout, rect: SplitLineRect): SplitLineRect[] {
  return mapRect(layout, rect, 'display_rect');
}

function validRaster(raster: SplitLineRaster, scale: number): boolean {
  return Number.isFinite(scale) && scale > 0 && Number.isInteger(raster.width) && Number.isInteger(raster.height)
    && raster.width > 0 && raster.height > 0 && raster.data.length >= raster.width * raster.height * 4;
}

/**
 * Substitute-font character positions can drift from the printed PDF. Keep the
 * chosen word boundary, but snap its cut to a nearby real white gutter before
 * composing the two halves. Fragment ownership and original quads stay intact.
 */
export function refineSplitLineCuts(layout: SplitLineLayout, raster: SplitLineRaster, scale: number): SplitLineLayout | null {
  if (!validRaster(raster, scale) || !layout.cuts?.length) return null;
  const { width, height, data } = raster;
  let refined: SplitLinePiece[] | null = null;
  for (const cut of layout.cuts) {
    const first = layout.pieces[cut.first_piece_index];
    const continuation = layout.pieces[cut.continuation_piece_index];
    if (!first || !continuation || !validRect(continuation.source_rect) || !Number.isFinite(cut.search_radius)
      || !Number.isFinite(cut.minimum_gap) || cut.search_radius <= 0 || cut.minimum_gap <= 0
      || (cut.trailing_piece_index !== null && !layout.pieces[cut.trailing_piece_index])) return null;
    const boundary = continuation.source_rect[0];
    if (first.source_rect[2] !== boundary) return null;
    const radius = cut.search_radius * scale;
    const minimum_gap = Math.max(2, Math.ceil(cut.minimum_gap * scale));
    const top = Math.max(0, Math.floor(continuation.source_rect[1] * scale));
    const bottom = Math.min(height, Math.ceil(continuation.source_rect[3] * scale));
    const left = Math.max(0, Math.floor(boundary * scale - radius - minimum_gap));
    const right = Math.min(width, Math.ceil(boundary * scale + radius + minimum_gap));
    if (top >= bottom || left >= right) return null;
    const gaps: Array<[number, number]> = [];
    let start: number | null = null;
    for (let x = left; x <= right; x++) {
      let blank = x < right;
      for (let y = top; blank && y < bottom; y++) {
        const offset = (y * width + x) * 4;
        if (data[offset + 3] >= 16 && Math.min(data[offset], data[offset + 1], data[offset + 2]) < 230) blank = false;
      }
      if (blank && start === null) start = x;
      if (!blank && start !== null) {
        if (x - start >= minimum_gap) gaps.push([start, x]);
        start = null;
      }
    }
    // Keep an already safe cut stable across repeated renders and zoom changes.
    if (gaps.some(([begin, end]) => boundary * scale >= begin + 0.5 && boundary * scale <= end - 0.5)) continue;
    const candidates = gaps.map(([begin, end]) => (begin + end) / (2 * scale))
      .filter((candidate) => candidate > first.source_rect[0] && candidate < continuation.source_rect[2]
        && Math.abs(candidate - boundary) <= cut.search_radius)
      .sort((a, b) => Math.abs(a - boundary) - Math.abs(b - boundary));
    const snapped = candidates[0];
    if (snapped === undefined) return null;
    refined ??= layout.pieces.map((piece) => ({ source_rect: [...piece.source_rect], display_rect: [...piece.display_rect] }));
    const first_piece = refined[cut.first_piece_index];
    const second_piece = refined[cut.continuation_piece_index];
    first_piece.source_rect[2] = snapped;
    first_piece.display_rect[2] = first_piece.display_rect[0] + snapped - first_piece.source_rect[0];
    second_piece.source_rect[0] = snapped;
    second_piece.display_rect[2] = second_piece.display_rect[0] + second_piece.source_rect[2] - snapped;
    if (cut.trailing_piece_index !== null) {
      const trailing = refined[cut.trailing_piece_index];
      trailing.source_rect[2] = snapped;
      trailing.display_rect[2] = trailing.display_rect[0] + snapped - trailing.source_rect[0];
    }
  }
  return refined ? { ...layout, width: Math.max(layout.width, ...refined.map((piece) => piece.display_rect[2])), pieces: refined } : layout;
}

/**
 * Reject a split before displaying it if retained strips would discard ink.
 * A one-raster-pixel guard tolerates antialiasing and subpixel crop rounding;
 * it does not grow into several discarded pixels when the reader zooms in.
 */
export function splitLineInkCovered(layout: SplitLineLayout, raster: SplitLineRaster, scale: number): boolean {
  const { width, height, data } = raster;
  if (!validRaster(raster, scale) || !layout.pieces.length) return false;
  type Interval = [number, number];
  const events: Array<{ row: number; index: number; interval?: Interval }> = [];
  for (let index = 0; index < layout.pieces.length; index++) {
    const rect = layout.pieces[index].source_rect;
    if (!validRect(rect)) return false;
    // Pixel centers determine coverage; extend each edge by exactly one source
    // raster pixel, then clamp to the actual rendered bitmap.
    const left = Math.max(0, Math.ceil(rect[0] * scale - 1.5));
    const top = Math.max(0, Math.ceil(rect[1] * scale - 1.5));
    const right = Math.min(width, Math.ceil(rect[2] * scale + 0.5));
    const bottom = Math.min(height, Math.ceil(rect[3] * scale + 0.5));
    if (left >= right || top >= bottom) continue;
    events.push({ row: top, index, interval: [left, right] }, { row: bottom, index });
  }
  events.sort((first, second) => first.row - second.row);
  const active = new Map<number, Interval>();
  let event_index = 0;
  let row = 0;
  while (row < height) {
    while (event_index < events.length && events[event_index].row <= row) {
      const event = events[event_index++];
      if (event.interval) active.set(event.index, event.interval);
      else active.delete(event.index);
    }
    const next_row = Math.min(height, events[event_index]?.row ?? height);
    const merged: Interval[] = [];
    for (const interval of [...active.values()].sort((first, second) => first[0] - second[0])) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    // Coverage only changes at a strip edge. Merge once for this vertical band
    // and inspect uncovered columns, avoiding a per-pixel scan of every piece.
    let left = 0;
    for (const [right, covered_end] of [...merged, [width, width] as Interval]) {
      for (let y = row; y < next_row; y++) {
        for (let offset = (y * width + left) * 4; offset < (y * width + right) * 4; offset += 4) {
          if (data[offset + 3] >= 16 && Math.min(data[offset], data[offset + 1], data[offset + 2]) < 230) return false;
        }
      }
      left = covered_end;
    }
    row = next_row;
  }
  return true;
}
