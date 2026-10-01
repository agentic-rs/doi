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
  /** Two-line fitting width; retained full-width rows never shrink the font. */
  fit_width?: number;
  /** Display line count for each source row, ordered from top to bottom. */
  line_counts?: Array<1 | 2 | 3>;
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
 * Make each long source line two or three display lines, preserving its printed pixels.
 * Short lines stay intact. The caller must provide complete, nonoverlapping
 * glyph rows and safe word boundaries; unsafe crops retain their original view.
 */
function orderedRows(width: number, height: number, rows: readonly SplitLineRow[]): SplitLineRow[] | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !rows.length) return null;
  const ordered = [...rows].sort((first, second) => first.rect[1] - second.rect[1]);
  for (let index = 0; index < ordered.length; index++) {
    const rect = ordered[index].rect;
    if (!validRect(rect) || rect[0] < 0 || rect[1] < 0 || rect[2] > width || rect[3] > height
      || (index > 0 && rect[1] < ordered[index - 1].rect[3])) return null;
  }
  return ordered;
}

function rowCuts(width: number, row: SplitLineRow, line_count: 2 | 3): number[] | null {
  if (row.rect[2] - row.rect[0] <= width / 2) return null;
  const safe = [...new Set(row.breaks.filter((cut) => Number.isFinite(cut) && cut > row.rect[0] && cut < row.rect[2]))].sort((a, b) => a - b);
  if (line_count === 2) {
    const cut = safe.reduce<number | null>((best, candidate) => best === null || Math.abs(candidate - width / 2) < Math.abs(best - width / 2) ? candidate : best, null);
    return cut === null ? null : [cut];
  }
  // Choose the pair together: picking each third independently could select
  // the same word boundary twice and create an empty middle strip.
  let best: number[] | null = null;
  let best_distance = Infinity;
  for (let first = 0; first < safe.length - 1; first++) {
    for (let second = first + 1; second < safe.length; second++) {
      const distance = (safe[first] - width / 3) ** 2 + (safe[second] - width * 2 / 3) ** 2;
      if (distance < best_distance) {
        best = [safe[first], safe[second]];
        best_distance = distance;
      }
    }
  }
  return best;
}

function createRowLayout(row: SplitLineRow, band_top: number, band_bottom: number, padding: number,
  row_cuts: readonly number[] | null, unsplit_width: number): SplitLineLayout {
  const pieces: SplitLinePiece[] = [];
  const cut_regions: SplitLineCut[] = [];
  let display_width = 0;
  const append = (source_rect: SplitLineRect, top: number) => {
    if (!validRect(source_rect)) return;
    const piece_width = source_rect[2] - source_rect[0];
    const piece_height = source_rect[3] - source_rect[1];
    pieces.push({ source_rect, display_rect: [0, top, piece_width, top + piece_height] });
    display_width = Math.max(display_width, piece_width);
  };

  const band_height = band_bottom - band_top;
  if (row_cuts === null) {
    append([0, band_top, unsplit_width, band_bottom], 0);
    return { width: display_width, height: band_height, pieces, cuts: cut_regions, line_counts: [1] };
  }

  // Insert continuations before the original trailing gutter. Paragraph gaps
  // are retained exactly once, even for a three-line source row.
  const second_top = Math.max(band_top, row.rect[1] - padding);
  const second_bottom = Math.min(band_bottom, row.rect[3] + padding);
  const second_height = second_bottom - second_top;
  const first_height = second_bottom - band_top;
  append([0, band_top, row_cuts[0], second_bottom], 0);
  row_cuts.forEach((cut, continuation_index) => {
    append([cut, second_top, row_cuts[continuation_index + 1] ?? row.rect[2], second_bottom],
      first_height + continuation_index * second_height);
  });
  const trailing_piece_index = second_bottom < band_bottom ? pieces.length : null;
  append([0, second_bottom, row_cuts[0], band_bottom], first_height + row_cuts.length * second_height);
  const row_height = row.rect[3] - row.rect[1];
  row_cuts.forEach((_, cut_index) => {
    cut_regions.push({ first_piece_index: cut_index, continuation_piece_index: cut_index + 1,
      trailing_piece_index: cut_index === 0 ? trailing_piece_index : null,
      search_radius: Math.max(1, row_height * 0.45), minimum_gap: Math.max(0.4, row_height * 0.12) });
  });
  return { width: display_width, height: band_height + row_cuts.length * second_height, pieces, cuts: cut_regions,
    line_counts: [row_cuts.length === 1 ? 2 : 3] };
}

function rowBands(height: number, rows: readonly SplitLineRow[]): Array<[number, number]> {
  return rows.map((row, index) => [
    index === 0 ? 0 : (rows[index - 1].rect[3] + row.rect[1]) / 2,
    index === rows.length - 1 ? height : (row.rect[3] + rows[index + 1].rect[1]) / 2,
  ]);
}

function rowPadding(rows: readonly SplitLineRow[]): number {
  const heights = rows.map((row) => row.rect[3] - row.rect[1]).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] * 0.1;
}

function composeRowLayouts(layouts: readonly SplitLineLayout[]): SplitLineLayout | null {
  const pieces: SplitLinePiece[] = [];
  const cuts: SplitLineCut[] = [];
  let top = 0;
  let width = 0;
  for (const layout of layouts) {
    const offset = pieces.length;
    pieces.push(...layout.pieces.map((piece) => ({ source_rect: [...piece.source_rect] as SplitLineRect,
      display_rect: [piece.display_rect[0], piece.display_rect[1] + top, piece.display_rect[2], piece.display_rect[3] + top] as SplitLineRect })));
    cuts.push(...(layout.cuts ?? []).map((cut) => ({ ...cut, first_piece_index: cut.first_piece_index + offset,
      continuation_piece_index: cut.continuation_piece_index + offset,
      trailing_piece_index: cut.trailing_piece_index === null ? null : cut.trailing_piece_index + offset })));
    top += layout.height;
    width = Math.max(width, ...layout.pieces.map((piece) => piece.display_rect[2]));
  }
  return Number.isFinite(top) && Number.isFinite(width) ? { width, height: top, pieces, cuts } : null;
}

export function createSplitLineLayout(width: number, height: number, rows: readonly SplitLineRow[], line_count: 2 | 3 = 2): SplitLineLayout | null {
  if (line_count !== 2 && line_count !== 3) return null;
  const ordered = orderedRows(width, height, rows);
  if (!ordered) return null;
  const cuts = ordered.map((row) => rowCuts(width, row, line_count));
  if (!cuts.some((cut) => cut !== null) || ordered.some((row, index) => row.rect[2] - row.rect[0] > width / 2 && cuts[index] === null)) return null;
  const bands = rowBands(height, ordered);
  const padding = rowPadding(ordered);
  return composeRowLayouts(ordered.map((row, index) => createRowLayout(row, ...bands[index], padding, cuts[index], row.rect[2])));
}

function previousRowLayout(layout: SplitLineLayout | undefined, band: [number, number], row_index: number): SplitLineLayout | null {
  const line_count = layout?.line_counts?.[row_index];
  if (!layout || !line_count) return null;
  const indices = layout.pieces.flatMap((piece, index) => piece.source_rect[1] >= band[0] && piece.source_rect[3] <= band[1] ? [index] : []);
  if (!indices.length) return null;
  const index_map = new Map(indices.map((index, local) => [index, local]));
  const selected = indices.map((index) => layout.pieces[index]);
  const top = Math.min(...selected.map((piece) => piece.display_rect[1]));
  const bottom = Math.max(...selected.map((piece) => piece.display_rect[3]));
  const cuts = (layout.cuts ?? []).filter((cut) => index_map.has(cut.first_piece_index));
  if (cuts.length !== line_count - 1 || cuts.some((cut) => !index_map.has(cut.continuation_piece_index)
    || (cut.trailing_piece_index !== null && !index_map.has(cut.trailing_piece_index)))) return null;
  return { width: Math.max(...selected.map((piece) => piece.display_rect[2])), height: bottom - top,
    pieces: selected.map((piece) => ({ source_rect: [...piece.source_rect] as SplitLineRect,
      display_rect: [piece.display_rect[0], piece.display_rect[1] - top, piece.display_rect[2], piece.display_rect[3] - top] as SplitLineRect })),
    cuts: cuts.map((cut) => ({ ...cut, first_piece_index: index_map.get(cut.first_piece_index)!,
      continuation_piece_index: index_map.get(cut.continuation_piece_index)!,
      trailing_piece_index: cut.trailing_piece_index === null ? null : index_map.get(cut.trailing_piece_index)! })),
    line_counts: [line_count] };
}

function horizontalCutIsBlank(raster: SplitLineRaster, scale: number, source_width: number, boundary: number): boolean {
  const top = Math.max(0, Math.floor(boundary * scale - 0.5));
  const bottom = Math.min(raster.height, Math.ceil(boundary * scale + 0.5));
  const right = Math.min(raster.width, Math.ceil(source_width * scale));
  for (let y = top; y < bottom; y++) {
    for (let offset = y * raster.width * 4; offset < (y * raster.width + right) * 4; offset += 4) {
      if (raster.data[offset + 3] >= 16 && Math.min(raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]) < 230) return false;
    }
  }
  return true;
}

/**
 * Choose a safe layout independently for each source row. Two display lines
 * are preferred; a failed printed cut tries three, then retains that full row.
 * The fit width stays tied to the provisional two-line layout in every case.
 */
export function createAdaptiveSplitLineLayout(width: number, height: number, rows: readonly SplitLineRow[],
  raster?: SplitLineRaster, scale?: number, previous_layout?: SplitLineLayout): SplitLineLayout | null {
  const ordered = orderedRows(width, height, rows);
  if (!ordered || (raster && (scale === undefined || !validRaster(raster, scale)))) return null;
  const bands = rowBands(height, ordered);
  const padding = rowPadding(ordered);
  const proposed_cuts = ordered.map((row) => rowCuts(width, row, 2));
  const fit_width = ordered.reduce((fit, row, index) => {
    const cuts = proposed_cuts[index];
    return Math.max(fit, row.rect[2] - row.rect[0] > width / 2
      ? cuts ? Math.max(cuts[0], row.rect[2] - cuts[0]) : width / 2 : row.rect[2]);
  }, width / 2);
  const merged_boundaries = bands.slice(0, -1).map((band) => {
    // Never split a glyph horizontally when the measured vertical bounds drift
    // from the raster. Keep earlier retained groups stable across zoom changes.
    const previously_merged = previous_layout?.pieces.some((piece) => piece.source_rect[0] === 0 && piece.source_rect[2] === width
      && piece.source_rect[1] < band[1] && piece.source_rect[3] > band[1]
      && piece.display_rect[2] - piece.display_rect[0] < width);
    return Boolean(previously_merged || (raster && !horizontalCutIsBlank(raster, scale!, width, band[1])));
  });
  const layouts: SplitLineLayout[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const row = ordered[index];
    let last = index;
    while (merged_boundaries[last]) last++;
    if (last > index) {
      const band: [number, number] = [bands[index][0], bands[last][1]];
      const retained = createRowLayout(row, ...band, padding, null, width);
      const ratio = fit_width / width;
      layouts.push({ ...retained, width: fit_width, height: retained.height * ratio,
        pieces: retained.pieces.map((piece) => ({ ...piece,
          display_rect: piece.display_rect.map((value) => value * ratio) as SplitLineRect })),
        line_counts: Array<1>(last - index + 1).fill(1) });
      index = last;
      continue;
    }
    const long = row.rect[2] - row.rect[0] > width / 2;
    const cuts = proposed_cuts[index];
    const original = (full_band = long) => {
      const retained = createRowLayout(row, ...bands[index], padding, null, full_band ? width : row.rect[2]);
      if (!full_band) return retained;
      const ratio = fit_width / width;
      return { ...retained, width: fit_width, height: retained.height * ratio,
        pieces: retained.pieces.map((piece) => ({ ...piece,
          display_rect: piece.display_rect.map((value) => value * ratio) as SplitLineRect })) };
    };
    if (!raster) {
      layouts.push(cuts ? createRowLayout(row, ...bands[index], padding, cuts, row.rect[2]) : original());
      continue;
    }
    const source_band: SplitLineRect = [0, bands[index][0], width, bands[index][1]];
    const previous = previousRowLayout(previous_layout, bands[index], index);
    let chosen: SplitLineLayout | null = null;
    if (previous && previous.width <= fit_width) {
      const refined = previous.cuts?.length ? refineSplitLineCuts(previous, raster, scale!) : previous;
      if (refined && refined.width <= fit_width && splitLineInkCoveredInRegion(refined, raster, scale!, source_band)) chosen = refined;
    }
    if (!chosen && long) {
      for (const count of [2, 3] as const) {
        const candidate_cuts = count === 2 ? cuts : rowCuts(width, row, count);
        if (!candidate_cuts) continue;
        const candidate = createRowLayout(row, ...bands[index], padding, candidate_cuts, row.rect[2]);
        const refined = refineSplitLineCuts(candidate, raster, scale!);
        if (refined && refined.width <= fit_width && splitLineInkCoveredInRegion(refined, raster, scale!, source_band)) {
          chosen = refined;
          break;
        }
      }
    }
    const retained = original();
    // A short row can still contain substitute-font drift or unmodelled marks
    // in its right gutter. Retain that complete band instead of dropping ink.
    layouts.push(chosen ?? (splitLineInkCoveredInRegion(retained, raster, scale!, source_band) ? retained : original(true)));
  }
  const layout = composeRowLayouts(layouts);
  return layout ? { ...layout, fit_width, line_counts: layouts.flatMap((row) => row.line_counts ?? []) } : null;
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
  return [destination[0] + (clamped[0] - origin[0]) * (destination[2] - destination[0]) / (origin[2] - origin[0]),
    destination[1] + (clamped[1] - origin[1]) * (destination[3] - destination[1]) / (origin[3] - origin[1])];
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
    const sx = (destination[2] - destination[0]) / (origin[2] - origin[0]);
    const sy = (destination[3] - destination[1]) / (origin[3] - origin[1]);
    return [[destination[0] + (clipped[0] - origin[0]) * sx, destination[1] + (clipped[1] - origin[1]) * sy,
      destination[0] + (clipped[2] - origin[0]) * sx, destination[1] + (clipped[3] - origin[1]) * sy] as SplitLineRect];
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
 * composing the translated strips. Fragment ownership and original quads stay intact.
 */
export function refineSplitLineCuts(layout: SplitLineLayout, raster: SplitLineRaster, scale: number): SplitLineLayout | null {
  if (!validRaster(raster, scale) || !layout.cuts?.length) return null;
  const { width, height, data } = raster;
  let refined: SplitLinePiece[] | null = null;
  for (const cut of layout.cuts) {
    const current = refined ?? layout.pieces;
    const first = current[cut.first_piece_index];
    const continuation = current[cut.continuation_piece_index];
    if (!first || !continuation || !validRect(first.source_rect) || !validRect(continuation.source_rect) || !Number.isFinite(cut.search_radius)
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
  return splitLineInkCoveredInRegion(layout, raster, scale);
}

function splitLineInkCoveredInRegion(layout: SplitLineLayout, raster: SplitLineRaster, scale: number, region?: SplitLineRect): boolean {
  const { width, height, data } = raster;
  if (!validRaster(raster, scale) || !layout.pieces.length || (region && !validRect(region))) return false;
  const region_left = region ? Math.max(0, Math.floor(region[0] * scale)) : 0;
  const region_top = region ? Math.max(0, Math.floor(region[1] * scale)) : 0;
  const region_right = region ? Math.min(width, Math.ceil(region[2] * scale)) : width;
  const region_bottom = region ? Math.min(height, Math.ceil(region[3] * scale)) : height;
  type Interval = [number, number];
  const events: Array<{ row: number; index: number; interval?: Interval }> = [];
  for (let index = 0; index < layout.pieces.length; index++) {
    const rect = layout.pieces[index].source_rect;
    if (!validRect(rect)) return false;
    // Pixel centers determine coverage; extend each edge by exactly one source
    // raster pixel, then clamp to the actual rendered bitmap.
    const left = Math.max(region_left, Math.ceil(rect[0] * scale - 1.5));
    const top = Math.max(region_top, Math.ceil(rect[1] * scale - 1.5));
    const right = Math.min(region_right, Math.ceil(rect[2] * scale + 0.5));
    const bottom = Math.min(region_bottom, Math.ceil(rect[3] * scale + 0.5));
    if (left >= right || top >= bottom) continue;
    events.push({ row: top, index, interval: [left, right] }, { row: bottom, index });
  }
  events.sort((first, second) => first.row - second.row);
  const active = new Map<number, Interval>();
  let event_index = 0;
  let row = region_top;
  while (row < region_bottom) {
    while (event_index < events.length && events[event_index].row <= row) {
      const event = events[event_index++];
      if (event.interval) active.set(event.index, event.interval);
      else active.delete(event.index);
    }
    const next_row = Math.min(region_bottom, events[event_index]?.row ?? region_bottom);
    const merged: Interval[] = [];
    for (const interval of [...active.values()].sort((first, second) => first[0] - second[0])) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    // Coverage only changes at a strip edge. Merge once for this vertical band
    // and inspect uncovered columns, avoiding a per-pixel scan of every piece.
    let left = region_left;
    for (const [right, covered_end] of [...merged, [region_right, region_right] as Interval]) {
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
