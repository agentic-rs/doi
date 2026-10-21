import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from './pdf-compatibility';
import { pdfFontMetrics } from './pdf-font-metrics';
import { isReferenceSectionEnd } from './reference-section';
import { classifyReadingDocument, classifyReadingRegion, readingPageEvidence } from './reading-block-classification';
import type { ReadingTextLine } from './reading-block-classification';
import type { PdfSourceRect, ReadingBlock, ReadingLayout } from './types';

export const READING_LAYOUT_VERSION = 5;

type Rect = [number, number, number, number];
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

type TextBox = ReadingTextLine;

interface Region {
  rect: Rect;
  lines: TextBox[];
  graphic_pixels: number;
  graphic_rect: Rect | null;
}

/** Raster and text geometry share the viewport's top-left coordinate system. */
export interface ReadingPageInput {
  page_number: number;
  viewport: Pick<PageViewport, 'width' | 'height' | 'scale' | 'rotation' | 'transform' | 'convertToPdfPoint'>;
  text_content: TextContent;
  raster: { width: number; height: number; data: Uint8ClampedArray };
}

function intersect(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function inset(rect: Rect, amount: number, width: number, height: number): Rect {
  return [Math.max(0, rect[0] - amount), Math.max(0, rect[1] - amount),
    Math.min(width, rect[2] + amount), Math.min(height, rect[3] + amount)];
}

function textGeometry(input: ReadingPageInput): { boxes: TextBox[]; horizontal: boolean } {
  const { text_content, viewport } = input;
  const [a, b, c, d, e, f] = viewport.transform;
  const boxes: TextBox[] = [];
  let horizontal = true;
  for (const item of text_content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [ia, ib, ic, id, ix, iy] = item.transform;
    const x = a * ix + c * iy + e;
    const y = b * ix + d * iy + f;
    const normal_x = a * ic + c * id;
    const normal_y = b * ic + d * id;
    const font_size = Math.hypot(normal_x, normal_y);
    const baseline_x = a * ia + c * ib;
    const baseline_y = b * ia + d * ib;
    const style = text_content.styles[item.fontName];
    const is_horizontal = !style?.vertical && Math.abs(baseline_y) <= Math.abs(baseline_x) * 0.05 && baseline_x > 0;
    if (!is_horizontal) horizontal = false;
    const scale = Math.hypot(a, b);
    const { ascent, descent } = pdfFontMetrics(style);
    const baseline_length = Math.hypot(baseline_x, baseline_y);
    const advance_x = baseline_x / baseline_length * item.width * scale;
    const advance_y = baseline_y / baseline_length * item.width * scale;
    const corners = [[x + normal_x * ascent, y + normal_y * ascent],
      [x + advance_x + normal_x * ascent, y + advance_y + normal_y * ascent],
      [x + normal_x * descent, y + normal_y * descent],
      [x + advance_x + normal_x * descent, y + advance_y + normal_y * descent]];
    const rect: Rect = [Math.min(...corners.map(([cx]) => cx)), Math.min(...corners.map(([, cy]) => cy)),
      Math.max(...corners.map(([cx]) => cx)), Math.max(...corners.map(([, cy]) => cy))];
    if (rect.every(Number.isFinite) && font_size > 0 && intersect(rect, [0, 0, viewport.width, viewport.height])) {
      boxes.push({ rect: [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(viewport.width, rect[2]), Math.min(viewport.height, rect[3])],
        text: item.str, font_size, horizontal: is_horizontal });
    }
  }
  return { boxes, horizontal };
}

function combineLines(boxes: TextBox[]): TextBox[] {
  const lines: TextBox[] = [];
  const rows: Array<{ rect: Rect; boxes: TextBox[] }> = [];
  const sorted = [...boxes].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  for (const box of sorted) {
    if (!box.horizontal) {
      lines.push({ ...box, rect: [...box.rect] });
      continue;
    }
    // Font switches can change ascent while keeping the same baseline. Group
    // visual rows before sorting left-to-right so a bold “3” never precedes
    // the earlier “Figure” on the same printed line.
    const row = rows.slice(-8).find((candidate) => {
      const vertical_overlap = Math.min(candidate.rect[3], box.rect[3]) - Math.max(candidate.rect[1], box.rect[1]);
      const shorter_height = Math.min(candidate.rect[3] - candidate.rect[1], box.rect[3] - box.rect[1]);
      return vertical_overlap > shorter_height * 0.55;
    });
    if (row) {
      row.boxes.push(box);
      row.rect = union(row.rect, box.rect);
    } else rows.push({ rect: box.rect, boxes: [box] });
  }
  for (const row of rows) {
    let line: TextBox | undefined;
    for (const box of row.boxes.sort((a, b) => a.rect[0] - b.rect[0])) {
      const gap = line ? box.rect[0] - line.rect[2] : Infinity;
      // Join adjacent PDF font runs while retaining an ordinary column gutter.
      if (!line || gap < -box.font_size * 0.5 || gap >= box.font_size * 1.25) {
        line = { ...box, rect: [...box.rect] };
        lines.push(line);
        continue;
      }
      line.text += `${gap > box.font_size * 0.12 && !/\s$/.test(line.text) ? ' ' : ''}${box.text}`;
      line.rect = union(line.rect, box.rect);
      line.font_size = Math.max(line.font_size, box.font_size);
    }
  }
  return lines.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
}

function captionLabel(text: string): string | null {
  // Requiring punctuation avoids treating prose such as “Figure 2 shows ...”
  // as a caption, and deliberately leaves unusual caption styles in place.
  return /^(?:Figure|Fig\.?)[ \t]+(\d+[a-z]?)[ \t]*[:.][ \t]+/i.exec(text.trim())?.[1].toLowerCase() ?? null;
}

function isProse(line: TextBox, region_width: number): boolean {
  return line.horizontal && !captionLabel(line.text) && (line.text.match(/[\p{L}]{2,}/gu)?.length ?? 0) >= 6
    && line.rect[2] - line.rect[0] >= region_width * 0.4;
}

function textOf(lines: TextBox[]): string {
  return lines.map((line) => line.text.trim()).filter(Boolean).join('\n');
}

/** Pure geometry entry point, also used by synthetic layout regression tests. */
export function extractReadingPage(input: ReadingPageInput): ReadingBlock[] {
  return analyzeReadingPage(input).blocks;
}

function analyzeReadingPage(input: ReadingPageInput): { blocks: ReadingBlock[]; section_endings: Set<string> } {
  const { page_number, viewport, raster } = input;
  const { width, height, data } = raster;
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const { boxes, horizontal } = textGeometry(input);
  const lines = combineLines(boxes);
  const page_evidence = readingPageEvidence(lines, page_number, viewport.width, viewport.height, scale);
  const section_endings = new Set(lines.filter((line) =>
    isReferenceSectionEnd(line.text, line.font_size, page_evidence.body_font_size)).map((line) => line.text.trim()));
  const ink = new Uint8Array(width * height);
  let bounds: Rect | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 16 || Math.min(data[offset], data[offset + 1], data[offset + 2]) >= 245) continue;
      ink[y * width + x] = 1;
      if (!bounds) bounds = [x, y, x + 1, y + 1];
      else {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x + 1);
        bounds[3] = Math.max(bounds[3], y + 1);
      }
    }
  }
  // Text metrics conservatively protect faint glyphs or descenders that the
  // low-resolution raster misses. Blank pages remain represented in the flow.
  for (const box of boxes) bounds = bounds ? union(bounds, box.rect) : box.rect;
  const page_rect: Rect = [0, 0, viewport.width, viewport.height];
  const crop = bounds ? inset(bounds, 3 * scale, viewport.width, viewport.height) : page_rect;

  function sourceRect(rect: Rect): PdfSourceRect {
    const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]
      .map(([x, y]) => viewport.convertToPdfPoint(x, y));
    return [Math.min(...corners.map(([x]) => x)), Math.min(...corners.map(([, y]) => y)),
      Math.max(...corners.map(([x]) => x)), Math.max(...corners.map(([, y]) => y))];
  }

  const original = (): ReadingBlock[] => [{ block_id: `p${page_number}-b0`, page_number,
    source_rect: sourceRect(crop), kind: 'original', block_type: 'others', text: textOf(lines), figure_label: null }];
  if (!bounds || !boxes.length || viewport.rotation % 360 !== 0) return { blocks: original(), section_endings };

  // Protect complete text boxes, not just their dark pixels. Every split below
  // must pass through genuinely empty space in both the raster and text layer.
  const graphics = ink.slice();
  for (const box of boxes) {
    const rect = inset(box.rect, scale, width, height);
    for (let y = Math.max(0, Math.floor(rect[1])); y < Math.min(height, Math.ceil(rect[3])); y++) {
      for (let x = Math.max(0, Math.floor(rect[0])); x < Math.min(width, Math.ceil(rect[2])); x++) {
        ink[y * width + x] = 1;
        graphics[y * width + x] = 0;
      }
    }
  }
  if (!horizontal) {
    // A plot-only page can travel intact even when it contains rotated labels.
    // Other pages use the protected rotated bounds in whitespace checks below;
    // only regions with horizontal prose become text blocks.
    const captions = lines.filter((line) => line.horizontal && captionLabel(line.text));
    const caption = captions.length === 1 ? captions[0] : null;
    let figure_crop = crop;
    let footer: TextBox | undefined;
    if (caption) {
      footer = lines.find((line) => line.horizontal && /^\d{1,4}$/.test(line.text.trim())
        && line.rect[1] > viewport.height * 0.9 && line.rect[0] > viewport.width * 0.35
        && line.rect[2] < viewport.width * 0.65);
      if (footer) {
        let content_bottom = 0;
        for (let y = 0; y < Math.floor(footer.rect[1] - 2 * scale); y++) {
          for (let x = 0; x < width; x++) if (ink[y * width + x]) content_bottom = y + 1;
        }
        for (const line of lines) if (line !== footer) content_bottom = Math.max(content_bottom, line.rect[3]);
        if (content_bottom + 12 * scale < footer.rect[1]) figure_crop = [crop[0], crop[1], crop[2], content_bottom + 3 * scale];
        else footer = undefined;
      }
    }
    const has_body_above = caption && lines.some((line) => line.horizontal
      && line.rect[3] < caption.rect[1] && isProse(line, crop[2] - crop[0]));
    const graphic_pixels = graphics.reduce((sum, pixel) => sum + pixel, 0);
    if (caption && !has_body_above && graphic_pixels >= Math.max(20, 24 * scale * scale)
      && caption.rect[1] > figure_crop[1] + (figure_crop[3] - figure_crop[1]) * 0.6) {
      const figure: ReadingBlock = { ...original()[0], source_rect: sourceRect(figure_crop),
        kind: 'figure', block_type: 'graph', text: textOf(lines.filter((line) => line !== footer)), figure_label: captionLabel(caption.text) };
      return { section_endings, blocks: footer ? [figure, { ...original()[0], block_id: `p${page_number}-b1`,
        source_rect: sourceRect([crop[0], footer.rect[1] - 3 * scale, crop[2], crop[3]]),
        kind: 'text', text: footer.text }] : [figure] };
    }
  }

  // Summed areas make corridor checks independent of page area. Repeatedly
  // scanning each candidate title/column partition causes visible UI stalls.
  const stride = width + 1;
  const sums = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row_sum = 0;
    for (let x = 0; x < width; x++) {
      row_sum += ink[y * width + x];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row_sum;
    }
  }
  function inkCount(x0: number, y0: number, x1: number, y1: number): number {
    return sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0];
  }
  function projection(rect: Rect, axis: 0 | 1): number[] {
    const values = new Array<number>(axis === 0 ? width : height).fill(0);
    const x0 = Math.max(0, Math.floor(rect[0]));
    const y0 = Math.max(0, Math.floor(rect[1]));
    const x1 = Math.min(width, Math.ceil(rect[2]));
    const y1 = Math.min(height, Math.ceil(rect[3]));
    if (axis === 0) {
      for (let x = x0; x < x1; x++) values[x] = inkCount(x, y0, x + 1, y1);
    } else {
      for (let y = y0; y < y1; y++) values[y] = inkCount(x0, y, x1, y + 1);
    }
    return values;
  }

  function gaps(rect: Rect, axis: 0 | 1, minimum: number): Array<[number, number]> {
    const values = projection(rect, axis);
    const start = Math.max(0, Math.ceil(rect[axis]));
    const end = Math.min(values.length, Math.floor(rect[axis + 2]));
    const result: Array<[number, number]> = [];
    let gap_start = start;
    for (let index = start; index <= end; index++) {
      if (index < end && !values[index]) continue;
      if (gap_start > start && index < end && index - gap_start >= minimum) result.push([gap_start, index]);
      gap_start = index + 1;
    }
    return result;
  }

  function region(rect: Rect): Region {
    let graphic_pixels = 0;
    let graphic_rect: Rect | null = null;
    for (let y = Math.max(0, Math.floor(rect[1])); y < Math.min(height, Math.ceil(rect[3])); y++) {
      for (let x = Math.max(0, Math.floor(rect[0])); x < Math.min(width, Math.ceil(rect[2])); x++) {
        graphic_pixels += graphics[y * width + x];
        if (!graphics[y * width + x]) continue;
        if (!graphic_rect) graphic_rect = [x, y, x + 1, y + 1];
        else {
          graphic_rect[0] = Math.min(graphic_rect[0], x);
          graphic_rect[1] = Math.min(graphic_rect[1], y);
          graphic_rect[2] = Math.max(graphic_rect[2], x + 1);
          graphic_rect[3] = Math.max(graphic_rect[3], y + 1);
        }
      }
    }
    // A narrow gutter can resemble a space between font runs before columns
    // are known. Recombine only this crop's items so neighboring column text
    // cannot leak into its caption, classification, or reference list.
    return { rect, graphic_pixels, graphic_rect, lines: combineLines(boxes.filter((box) => intersect(box.rect, rect))) };
  }

  function columnGap(rect: Rect): [number, number] | undefined {
    const rect_width = rect[2] - rect[0];
    const minimum = Math.max(4 * scale, page_evidence.body_font_size * 0.5);
    return gaps(rect, 0, minimum).filter(([start, end]) => {
      const center = (start + end) / 2;
      if (center < rect[0] + rect_width * 0.3 || center > rect[0] + rect_width * 0.7) return false;
      // Charts, equations, tables and two side-by-side figure panels often
      // contain vertical gaps too; require substantial prose on both sides.
      // Evaluate each side independently: combineLines may already have joined
      // runs across this gutter when its width is close to an ordinary space.
      const left = combineLines(boxes.filter((box) => intersect(box.rect, rect) && box.rect[2] <= start))
        .filter((line) => isProse(line, start - rect[0]));
      const right = combineLines(boxes.filter((box) => intersect(box.rect, rect) && box.rect[0] >= end))
        .filter((line) => isProse(line, rect[2] - end));
      return left.length >= 3 && right.length >= 3;
    }).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  }

  let leaves = 0;
  function divide(rect: Rect, depth: number): Region[] {
    if (depth > 16 || leaves > 100) return [region(rect)];
    const vertical_gap = columnGap(rect);
    if (vertical_gap) {
      // Keep the column's horizontal extent for every paragraph, heading and
      // page marker. Fitting a short heading to its ink width would enlarge it.
      const [start, end] = vertical_gap;
      // Leave room for italic overhang and antialiasing when the display is
      // rendered more sharply than the small analysis bitmap.
      const padding = Math.min(2 * scale, (end - start) / 3);
      return [...divide([rect[0], rect[1], start + padding, rect[3]], depth + 1),
        ...divide([end - padding, rect[1], rect[2], rect[3]], depth + 1)];
    }
    const local_fonts = lines.filter((line) => intersect(line.rect, rect)).map((line) => line.font_size).sort((a, b) => a - b);
    const font_size = local_fonts[Math.floor(local_fonts.length / 2)] ?? 10 * scale;
    const horizontal_gaps = gaps(rect, 1, Math.max(4 * scale, font_size * 0.45));
    if (!horizontal_gaps.length) {
      leaves++;
      return [region(rect)];
    }
    // Prefer the gap that exposes a real column gutter. This lets a full-width
    // title sit above two columns without reading across the columns by row.
    const candidates = horizontal_gaps.map((gap) => {
      const above: Rect = [rect[0], rect[1], rect[2], gap[0]];
      const below: Rect = [rect[0], gap[1], rect[2], rect[3]];
      const column_height = (columnGap(above) ? above[3] - above[1] : 0)
        + (columnGap(below) ? below[3] - below[1] : 0);
      return { gap, score: column_height + gap[1] - gap[0] };
    });
    candidates.sort((a, b) => b.score - a.score);
    const [start, end] = candidates[0].gap;
    const padding = Math.min(2 * scale, (end - start) / 3);
    return [...divide([rect[0], rect[1], rect[2], start + padding], depth + 1),
      ...divide([rect[0], end - padding, rect[2], rect[3]], depth + 1)];
  }

  // A tall, rotated margin stamp must not bridge every horizontal corridor in
  // the body. Isolate it only through a blank strip outside all horizontal text;
  // rotated plot labels inside a figure remain part of their source region.
  const margin_gap = !horizontal ? gaps(crop, 0, 4 * scale).find(([start, end]) => {
    const left = boxes.filter((box) => box.rect[2] <= start);
    const right = boxes.filter((box) => box.rect[0] >= end);
    const marginal = (margin: TextBox[], body: TextBox[], outer: boolean) => {
      if (!outer || !margin.length || margin.some((box) => box.horizontal)
        || !margin.some((box) => box.rect[3] - box.rect[1] >= viewport.height * 0.25)) return false;
      const body_width = Math.max(...body.map((box) => box.rect[2])) - Math.min(...body.map((box) => box.rect[0]));
      return combineLines(body).filter((line) => isProse(line, body_width)).length >= 3;
    };
    return marginal(left, right, end <= viewport.width * 0.15)
      || marginal(right, left, start >= viewport.width * 0.85);
  }) : undefined;
  let regions: Region[];
  if (margin_gap) {
    const [start, end] = margin_gap;
    const left_margin = boxes.filter((box) => box.rect[2] <= start).every((box) => !box.horizontal);
    const margin_rect: Rect = left_margin ? [crop[0], crop[1], start + scale, crop[3]] : [end - scale, crop[1], crop[2], crop[3]];
    const margin = region(margin_rect);
    const occupied = margin.graphic_rect ? [margin.graphic_rect, ...margin.lines.map((line) => line.rect)] : margin.lines.map((line) => line.rect);
    // The stamp is independent metadata. Keep its actual vertical extent and
    // show it after the page body, rather than inserting a page-height strip
    // before the title or making it the nearest top-of-page destination.
    margin.rect = [margin_rect[0], Math.max(crop[1], Math.min(...occupied.map((rect) => rect[1])) - 2 * scale),
      margin_rect[2], Math.min(crop[3], Math.max(...occupied.map((rect) => rect[3])) + 2 * scale)];
    const body_rect: Rect = left_margin ? [end - scale, crop[1], crop[2], crop[3]] : [crop[0], crop[1], start + scale, crop[3]];
    regions = [...divide(body_rect, 0), margin];
  } else regions = divide(crop, 0);
  const grouped: Array<{ region: Region; figure_label: string | null }> = [];
  for (const current of regions) {
    const label = captionLabel(current.lines[0]?.text ?? '');
    if (!label) {
      grouped.push({ region: current, figure_label: null });
      continue;
    }
    let start = grouped.length;
    let combined = current;
    while (start > 0) {
      const preceding = grouped[start - 1];
      const same_column = Math.abs(preceding.region.rect[0] - current.rect[0]) < scale
        && Math.abs(preceding.region.rect[2] - current.rect[2]) < scale;
      if (!same_column || preceding.figure_label || preceding.region.lines.some((line) => isProse(line, current.rect[2] - current.rect[0]))) break;
      if (!preceding.region.graphic_pixels && preceding.region.lines.some((line) =>
        /^(?:\d+(?:\.\d+)*\s+\p{L}|Abstract\b|References\b|Acknowledg)/u.test(line.text)
        || line.font_size > current.lines[0].font_size * 1.2)) break;
      // Do not reach upward across a large unrelated blank area or another
      // numbered caption. Multi-panel diagrams may have small internal gaps.
      if (combined.rect[1] - preceding.region.rect[3] > 36 * scale
        || preceding.region.lines.some((line) => captionLabel(line.text))) break;
      combined = { rect: union(combined.rect, preceding.region.rect),
        lines: [...preceding.region.lines, ...combined.lines],
        graphic_pixels: combined.graphic_pixels + preceding.region.graphic_pixels,
        graphic_rect: combined.graphic_rect && preceding.region.graphic_rect
          ? union(combined.graphic_rect, preceding.region.graphic_rect) : combined.graphic_rect ?? preceding.region.graphic_rect };
      start--;
    }
    const has_graphics = combined.graphic_pixels >= Math.max(20, 24 * scale * scale) && combined.graphic_rect
      && combined.graphic_rect[2] - combined.graphic_rect[0] >= 25 * scale
      && combined.graphic_rect[3] - combined.graphic_rect[1] >= 20 * scale;
    const caption_index = current.lines.findIndex((line) => captionLabel(line.text));
    const another_caption = combined.lines.filter((line) => captionLabel(line.text)).length > 1;
    // A caption alone is not a figure. Leave uncertain captions and surrounding
    // content in their original order rather than inventing a figure boundary.
    if (!has_graphics || another_caption || caption_index !== 0) {
      grouped.push({ region: current, figure_label: null });
      continue;
    }
    grouped.splice(start, grouped.length - start, { region: combined, figure_label: label });
  }

  return { section_endings, blocks: grouped.map(({ region: value, figure_label }, index): ReadingBlock => ({
    block_id: `p${page_number}-b${index}`,
    page_number,
    source_rect: sourceRect(value.rect),
    kind: figure_label ? 'figure' : value.lines.length && value.lines.every((line) => line.horizontal)
      && value.graphic_pixels < Math.max(20, 24 * scale * scale) ? 'text' : 'original',
    block_type: classifyReadingRegion(value, page_evidence, figure_label),
    text: textOf(value.lines),
    figure_label,
  })) };
}

/** Move only uniquely numbered figures with a single-number prose reference. */
export function placeFiguresNearReferences(blocks: ReadingBlock[]): ReadingBlock[] {
  const figures = new Map<string, ReadingBlock[]>();
  for (const block of blocks) {
    if (block.kind !== 'figure' || !block.figure_label) continue;
    const matching = figures.get(block.figure_label) ?? [];
    matching.push(block);
    figures.set(block.figure_label, matching);
  }
  const destinations = new Map<string, ReadingBlock[]>();
  const moving = new Set<string>();
  for (const [label, matching] of figures) {
    if (matching.length !== 1) continue;
    const destination = blocks.find((block) => {
      if (block.kind === 'figure') return false;
      const matches = block.text.matchAll(/\b(?:Figure|Fig\.)[ \t\n]+(\d+[a-z]?)(?![\w])/gi);
      for (const match of matches) {
        if (match[1].toLowerCase() !== label) continue;
        const following = block.text.slice((match.index ?? 0) + match[0].length);
        const preceding_line = block.text.slice(0, match.index).split('\n').at(-1) ?? '';
        if (/^\s*:/.test(following) || (!preceding_line.trim() && /^\s*\.\s/.test(following))) continue;
        // “Figure 1 and 2”, ranges and subpanel citations are ambiguous. They
        // stay where the author placed them until a clear mention is found.
        if (/^\s*(?:[-–—]\s*\d|,\s*(?:(?:Figure|Fig\.)\s+)?\d|\([a-z]\)|(?:and|or|to)\s+\d)/i.test(following)) continue;
        return true;
      }
      return false;
    });
    if (!destination) continue;
    const pending = destinations.get(destination.block_id) ?? [];
    pending.push(matching[0]);
    destinations.set(destination.block_id, pending);
    moving.add(matching[0].block_id);
  }
  return blocks.flatMap((block) => moving.has(block.block_id) ? [] : [block, ...destinations.get(block.block_id) ?? []]);
}

function checkCancellation(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Reading layout cancelled.', 'AbortError');
}

/** One small analysis bitmap at a time keeps long papers practical on iPhone. */
export async function buildReadingLayout(
  pages: PDFPageProxy[],
  pdf_hash: string,
  signal: AbortSignal,
  on_progress: (completed: number, total: number) => void,
): Promise<ReadingLayout> {
  const blocks: ReadingBlock[] = [];
  const section_endings = new Map<number, Set<string>>();
  on_progress(0, pages.length);
  for (const [index, page] of pages.entries()) {
    checkCancellation(signal);
    const full_viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.25, 900 / Math.max(full_viewport.width, full_viewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Reading view could not create a PDF analysis canvas.');
    const render = page.render({ canvas, viewport, background: 'rgb(255,255,255)' });
    const cancel = () => render.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const [text_content] = await Promise.all([readPdfTextContent(page), render.promise]);
      checkCancellation(signal);
      const raster = context.getImageData(0, 0, canvas.width, canvas.height);
      const analyzed = analyzeReadingPage({ page_number: page.pageNumber, viewport, text_content, raster });
      blocks.push(...analyzed.blocks);
      section_endings.set(page.pageNumber, analyzed.section_endings);
    } catch (error) {
      checkCancellation(signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      // PDF.js may still settle after text extraction rejects. Cancel first,
      // then release the backing bitmap only once its renderer has stopped.
      render.cancel();
      await render.promise.catch(() => {});
      canvas.width = canvas.height = 0;
    }
    on_progress(index + 1, pages.length);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  checkCancellation(signal);
  return { layout_version: READING_LAYOUT_VERSION, pdf_hash, page_count: pages.length,
    blocks: placeFiguresNearReferences(classifyReadingDocument(blocks, new Map(pages.map((page) => [page.pageNumber, page.view])), section_endings)) };
}
