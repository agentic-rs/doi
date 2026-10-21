import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfSourceRect, QuadPoints } from './types';
import { readPdfTextContent } from './pdf-compatibility';
import { pdfFontMetrics } from './pdf-font-metrics';
import { regionGeometry, regionTextContent } from './pdf-region';
import { createAdaptiveSplitLineLayout } from './pdf-line-layout';
import type { SplitLineLayout, SplitLineRaster, SplitLineRect, SplitLineRow } from './pdf-line-layout';

interface SourceRun {
  text: string;
  style: string;
  left: number;
  top: number;
  baseline: number;
  rect: SplitLineRect;
  ink_rect: SplitLineRect;
  character_rects: SplitLineRect[];
}

interface SplitTextFragment {
  text: string;
  style: string;
  left: number;
  top: number;
  piece_index: number;
  row_index?: number;
  character_rects: SplitLineRect[];
}

export interface PreparedSplitText {
  layout: SplitLineLayout;
  viewport: PageViewport;
  text: string;
  text_style: string;
  font_scale: number;
  fragments: SplitTextFragment[];
}

const prepared_cache = new WeakMap<PDFPageProxy, Map<string, PreparedSplitText>>();
interface SplitSourceMeasurements {
  width: number;
  height: number;
  rows: SplitLineRow[];
  runs: SourceRun[][];
}
const source_measurements = new WeakMap<PreparedSplitText, SplitSourceMeasurements>();

function union(first: SplitLineRect, second: SplitLineRect): SplitLineRect {
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[2], second[2]), Math.max(first[3], second[3])];
}

function sourceRect(rect: DOMRect, bounds: DOMRect): SplitLineRect {
  return [rect.left - bounds.left, rect.top - bounds.top, rect.right - bounds.left, rect.bottom - bounds.top];
}

function pieceForCharacter(layout: SplitLineLayout, rect: SplitLineRect, row_y: number): number {
  const x = (rect[0] + rect[2]) / 2;
  // Browser em boxes can extend into a neighboring row. The measured printed
  // row owns every character, including inline superscripts and subscripts.
  return layout.pieces.findIndex(({ source_rect: box }) => x >= box[0] && x < box[2] && row_y >= box[1] && row_y < box[3]);
}

function splitFragments(layout: SplitLineLayout, measurements: SplitSourceMeasurements): SplitTextFragment[] {
  const fragments: SplitTextFragment[] = [];
  measurements.runs.forEach((runs, row_index) => {
    const row = measurements.rows[row_index].rect;
    const row_y = (row[1] + row[3]) / 2;
    for (const run of runs) {
      let start = 0;
      while (start < run.text.length) {
        const piece_index = pieceForCharacter(layout, run.character_rects[start], row_y);
        let end = start + 1;
        while (end < run.text.length && pieceForCharacter(layout, run.character_rects[end], row_y) === piece_index) end++;
        if (piece_index < 0) {
          if (run.text.slice(start, end).trim()) throw new Error('Some text could not be aligned with its source line.');
          start = end;
          continue;
        }
        const advance = run.character_rects[start][0] - run.character_rects[0][0];
        fragments.push({ text: run.text.slice(start, end), style: run.style, left: run.left + advance, top: run.top,
          piece_index, row_index, character_rects: run.character_rects.slice(start, end) });
        start = end;
      }
    }
  });
  return fragments.sort((a, b) => a.piece_index - b.piece_index || (a.row_index ?? 0) - (b.row_index ?? 0) || a.left - b.left);
}

function sameLayout(first: SplitLineLayout, second: SplitLineLayout): boolean {
  // Rebase/compose can change the final floating-point bit of a strip offset.
  // Keep the completed bitmap, selectable layer, and mapping as one object
  // when their source/display geometry is indistinguishable.
  const same = (a: number | undefined, b: number | undefined) => a === b
    || (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-8);
  return same(first.width, second.width) && same(first.height, second.height) && same(first.fit_width, second.fit_width)
    && first.pieces.length === second.pieces.length && first.pieces.every((piece, index) => {
      const next = second.pieces[index];
      return piece.source_rect.every((value, edge) => same(value, next.source_rect[edge]))
        && piece.display_rect.every((value, edge) => same(value, next.display_rect[edge]));
    });
}

/** Rebuild character ownership after each source row chooses a safe layout. */
export function refinePreparedSplitText(prepared: PreparedSplitText, raster: SplitLineRaster, scale: number): PreparedSplitText {
  const measurements = source_measurements.get(prepared);
  if (!measurements) throw new Error('The source lines are unavailable. Its original lines are kept.');
  const layout = createAdaptiveSplitLineLayout(measurements.width, measurements.height, measurements.rows, raster, scale, prepared.layout);
  if (!layout) throw new Error('The printed lines could not be safely arranged. Its original lines are kept.');
  if (sameLayout(prepared.layout, layout)) return prepared;
  const refined = { ...prepared, layout, fragments: splitFragments(layout, measurements) };
  // A later zoom must reconsider the original runs, never fragments already
  // divided by an earlier two-line or three-line choice.
  source_measurements.set(refined, measurements);
  return refined;
}

/** Measure the real PDF.js text layer; character counts cannot locate a safe cut. */
async function measureSplitText(page: PDFPageProxy, source_rect: PdfSourceRect, host: HTMLElement): Promise<PreparedSplitText> {
  const geometry = regionGeometry(page, 1, 0, source_rect);
  if (geometry.viewport.rotation !== 0) throw new Error('Split lines is available with the page upright.');
  const content = regionTextContent(await readPdfTextContent(page), source_rect);
  const items = content.items.filter((item) => 'str' in item);
  if (!items.length || items.some((item) => item.dir !== 'ltr' || content.styles[item.fontName]?.vertical
    || Math.abs(item.transform[1]) > Math.abs(item.transform[0]) * 0.02)) {
    throw new Error('This block does not have reliably aligned horizontal text.');
  }
  const probe = document.createElement('div');
  probe.className = 'pdf-page pdf-line-probe';
  probe.style.cssText = `position:fixed;left:0;top:0;width:${geometry.viewport.width}px;height:${geometry.viewport.height}px;visibility:hidden;pointer-events:none;box-shadow:none;`;
  probe.style.setProperty('--total-scale-factor', String(page.userUnit));
  const text = document.createElement('div');
  text.className = 'textLayer';
  probe.append(text);
  // A pinch transforms the reader article. Measure outside that ancestor so an
  // in-flight preparation always observes unit-scale source coordinates.
  document.body.append(probe);
  const layer = new TextLayer({ textContentSource: content, container: text, viewport: geometry.viewport });
  try {
    await layer.render();
    if (!host.isConnected) throw new Error('The paper was closed while preparing its lines.');
    const origin = probe.getBoundingClientRect();
    // Measure in the full page's coordinate system, then subtract the crop.
    const crop_origin = new DOMRect(origin.left + geometry.left, origin.top + geometry.top, geometry.width, geometry.height);
    const runs: SourceRun[] = [];
    for (let index = 0; index < layer.textDivs.length; index++) {
      const span = layer.textDivs[index];
      const node = span.firstChild;
      const value = span.textContent ?? '';
      if (!(node instanceof Text) || !value) continue;
      const range = document.createRange();
      range.selectNodeContents(span);
      const rect = sourceRect(range.getBoundingClientRect(), crop_origin);
      if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) throw new Error('The text positions could not be measured.');
      const character_rects = Array.from({ length: value.length }, (_, offset) => {
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        return sourceRect(range.getBoundingClientRect(), crop_origin);
      });
      const style = getComputedStyle(span);
      if (![parseFloat(style.left), parseFloat(style.top)].every(Number.isFinite)) throw new Error('The source text positions could not be measured.');
      const item = items[index];
      const baseline = item ? geometry.render_viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1] : rect[3];
      const font = content.styles[item.fontName];
      const { ascent, descent } = pdfFontMetrics(font);
      const top = geometry.render_viewport.convertToViewportPoint(item.transform[4], item.transform[5] + item.transform[3] * ascent)[1];
      const bottom = geometry.render_viewport.convertToViewportPoint(item.transform[4], item.transform[5] + item.transform[3] * descent)[1];
      const ink_rect: SplitLineRect = [rect[0], Math.min(top, bottom), rect[2], Math.max(top, bottom)];
      runs.push({ text: value, style: span.style.cssText, left: parseFloat(style.left) - geometry.left,
        top: parseFloat(style.top) - geometry.top, baseline, rect, ink_rect, character_rects });
    }
    if (!runs.length) throw new Error('This block has no selectable text lines.');
    const rows: Array<{ rect: SplitLineRect; ink_rect: SplitLineRect; baseline: number; runs: SourceRun[] }> = [];
    for (const run of runs.filter((candidate) => candidate.text.trim()).sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const row = rows.slice().reverse().find((candidate) => {
        const overlap = Math.min(candidate.rect[3], run.rect[3]) - Math.max(candidate.rect[1], run.rect[1]);
        const height = Math.min(candidate.rect[3] - candidate.rect[1], run.rect[3] - run.rect[1]);
        const line_height = Math.max(candidate.rect[3] - candidate.rect[1], run.rect[3] - run.rect[1]);
        // Inline subscripts/superscripts share their surrounding printed line.
        return Math.abs(candidate.baseline - run.baseline) <= Math.max(1, line_height * 0.65) && overlap > height * 0.15;
      });
      if (row) { row.rect = union(row.rect, run.rect); row.ink_rect = union(row.ink_rect, run.ink_rect); row.runs.push(run); }
      else rows.push({ rect: [...run.rect], ink_rect: [...run.ink_rect], baseline: run.baseline, runs: [run] });
    }
    // Preserve explicit PDF spaces even when the font's gap is visually tiny.
    for (const run of runs.filter((candidate) => !candidate.text.trim())) {
      const row = rows.find((candidate) => Math.abs(candidate.baseline - run.baseline) <= 1);
      row?.runs.push(run);
    }
    rows.sort((a, b) => a.rect[1] - b.rect[1]);
    const measured_rows: SplitLineRow[] = rows.map((row) => {
      row.runs.sort((a, b) => a.rect[0] - b.rect[0]);
      const breaks: number[] = [];
      row.runs.forEach((run, index) => {
        for (const match of run.text.matchAll(/\s+/g)) {
          if (match.index === 0 || match.index + match[0].length === run.text.length) continue;
          const first = run.character_rects[match.index];
          const last = run.character_rects[match.index + match[0].length - 1];
          breaks.push((first[0] + last[2]) / 2);
        }
        const previous = row.runs[index - 1];
        if (previous) {
          const gap = run.rect[0] - previous.rect[2];
          const height = Math.min(run.rect[3] - run.rect[1], previous.rect[3] - previous.rect[1]);
          if (/\s$/.test(previous.text) || /^\s/.test(run.text) || gap >= height * 0.18) breaks.push((previous.rect[2] + run.rect[0]) / 2);
        }
      });
      // A small guard keeps ink overhangs and descenders inside their strips.
      const guard = Math.min(0.5, (row.rect[3] - row.rect[1]) * 0.04);
      return { rect: [Math.max(0, row.rect[0] - guard), Math.max(0, row.ink_rect[1] - guard),
        Math.min(geometry.width, row.rect[2] + guard), Math.min(geometry.height, row.ink_rect[3] + guard)], breaks };
    });
    // DOM ranges enclose the font's em box, which can overlap the next line
    // despite distinct baselines and disjoint printed ink. Partition that
    // shared leading once; keep each character's original source quad intact.
    for (let index = 1; index < measured_rows.length; index++) {
      const previous = measured_rows[index - 1].rect;
      const current = measured_rows[index].rect;
      if (current[1] < previous[3]) {
        const boundary = (current[1] + previous[3]) / 2;
        previous[3] = boundary;
        current[1] = boundary;
      }
    }
    const layout = createAdaptiveSplitLineLayout(geometry.width, geometry.height, measured_rows);
    if (!layout) throw new Error('This block has no safely aligned text lines. Its original lines are kept.');
    const measurements = { width: geometry.width, height: geometry.height, rows: measured_rows, runs: rows.map((row) => row.runs) };
    const fragments = splitFragments(layout, measurements);
    const source_text = rows.map((row) => row.runs.map((run, index) => {
      const previous = row.runs[index - 1];
      const gap = previous ? run.rect[0] - previous.rect[2] : 0;
      const space = previous && gap > (run.rect[3] - run.rect[1]) * 0.18 && !/\s$/.test(previous.text) && !/^\s/.test(run.text) ? ' ' : '';
      return space + run.text;
    }).join('')).join('\n');
    const prepared = { layout, viewport: geometry.render_viewport, text: source_text, text_style: text.style.cssText,
      font_scale: page.userUnit, fragments };
    source_measurements.set(prepared, measurements);
    return prepared;
  } finally { layer.cancel(); probe.remove(); }
}

export function prepareSplitPdfText(page: PDFPageProxy, source_rect: PdfSourceRect, host: HTMLElement): Promise<PreparedSplitText> {
  let cache = prepared_cache.get(page);
  if (!cache) { cache = new Map(); prepared_cache.set(page, cache); }
  const key = source_rect.join(',');
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  // In-flight probes belong to their live host. A remounted crop must not
  // inherit a pending measurement that is about to fail for a closed reader.
  return measureSplitText(page, source_rect, host).then((prepared) => {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, prepared);
    return prepared;
  });
}

/** Split text runs at real character offsets, with one selectable copy each. */
export function createSplitTextLayer(prepared: PreparedSplitText, scale: number) {
  const element = document.createElement('div');
  element.className = 'textLayer';
  element.style.cssText = prepared.text_style;
  element.style.width = `${prepared.layout.width * scale}px`;
  element.style.height = `${prepared.layout.height * scale}px`;
  element.style.setProperty('--total-scale-factor', String(scale * prepared.font_scale));
  const spans: Array<{ span: HTMLSpanElement; fragment: SplitTextFragment }> = [];
  let previous_piece = -1;
  let previous_fragment: SplitTextFragment | null = null;
  for (const fragment of prepared.fragments) {
    const same_row = previous_fragment?.row_index === fragment.row_index;
    if (previous_piece !== -1 && (previous_piece !== fragment.piece_index || !same_row)) element.append(document.createElement('br'));
    const piece = prepared.layout.pieces[fragment.piece_index];
    const source_width = piece.source_rect[2] - piece.source_rect[0];
    const source_height = piece.source_rect[3] - piece.source_rect[1];
    const piece_scale_x = (piece.display_rect[2] - piece.display_rect[0]) / source_width;
    const piece_scale_y = (piece.display_rect[3] - piece.display_rect[1]) / source_height;
    const span = document.createElement('span');
    span.style.cssText = fragment.style;
    span.style.left = `${(piece.display_rect[0] + (fragment.left - piece.source_rect[0]) * piece_scale_x) * scale}px`;
    span.style.top = `${(piece.display_rect[1] + (fragment.top - piece.source_rect[1]) * piece_scale_y) * scale}px`;
    span.style.setProperty('--total-scale-factor', String(scale * piece_scale_y * prepared.font_scale));
    // Custom-property values are resolved where declared. Redefine this on
    // the span so a smaller retained row updates PDF.js's actual font size.
    span.style.setProperty('--text-scale-factor', 'calc(var(--total-scale-factor) * var(--min-font-size))');
    span.textContent = fragment.text;
    if (previous_fragment && same_row && previous_piece === fragment.piece_index && !/\s$/.test(previous_fragment.text) && !/^\s/.test(fragment.text)) {
      const last = previous_fragment.character_rects.at(-1)!;
      const first = fragment.character_rects[0];
      if (first[0] - last[2] > (first[3] - first[1]) * 0.18) {
        const space = span.cloneNode(false) as HTMLSpanElement;
        space.textContent = ' ';
        element.append(space);
      }
    }
    element.append(span);
    spans.push({ span, fragment });
    previous_piece = fragment.piece_index;
    previous_fragment = fragment;
  }
  const quads_for_range = (range: Range): QuadPoints[] => spans.flatMap(({ span, fragment }) => {
    if (!range.intersectsNode(span)) return [];
    const node = span.firstChild!;
    const local = document.createRange();
    local.selectNodeContents(span);
    // Element endpoints can select zero characters at a span boundary.
    if (range.compareBoundaryPoints(Range.END_TO_START, local) >= 0 || range.compareBoundaryPoints(Range.START_TO_END, local) <= 0) return [];
    if (range.startContainer === node) local.setStart(node, range.startOffset);
    if (range.endContainer === node) local.setEnd(node, range.endOffset);
    const start = local.startContainer === node ? local.startOffset : 0;
    const end = local.endContainer === node ? local.endOffset : fragment.text.length;
    const rects = fragment.character_rects.slice(start, end).filter((rect, index) => fragment.text[start + index].trim() && rect[2] > rect[0] && rect[3] > rect[1]);
    if (!rects.length) return [];
    const rect = rects.reduce(union);
    const points = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    return [points.flatMap(([x, y]) => prepared.viewport.convertToPdfPoint(x, y)) as QuadPoints];
  });
  return { element, quads_for_range };
}
