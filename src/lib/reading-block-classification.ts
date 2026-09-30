import { isReferenceHeading, isReferenceSectionEnd } from './reference-section';
import type { ReadingBlock, ReadingBlockType } from './types';

type Rect = [number, number, number, number];

/** Temporary analysis evidence, in top-left viewport coordinates. */
export interface ReadingTextLine {
  rect: Rect;
  text: string;
  font_size: number;
  horizontal: boolean;
}

export interface ReadingRegionEvidence {
  rect: Rect;
  lines: ReadingTextLine[];
  graphic_pixels: number;
  graphic_rect: Rect | null;
}

export interface ReadingPageEvidence {
  page_number: number;
  width: number;
  height: number;
  scale: number;
  body_font_size: number;
  body_start: number;
}

const math_pattern = /[=≠≈≤≥∈∉∑∏∫√∞∂∇±×÷→↦∝⊤⊥]/u;
const numbered_heading = /^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)*)\s+\p{Lu}/u;
const named_heading = /^(?:abstract|introduction|background|related work|conclusions?|discussion|limitations?|acknowledg(?:e)?ments(?: and [\p{L} ]+)?|appendi(?:x|ces)(?:\s+[A-Z](?:\.|\s|$).*)?|supplementary material)$/iu;
const caption_pattern = /^(Table|Figure|Fig\.?)[ \t]+(?:[A-Z]\.?\d+|\d+|[IVX]+)[a-z]?(?:\.\d+)*\s*[:.]\s+/i;

function words(text: string): string[] {
  return text.match(/[\p{L}]{3,}/gu) ?? [];
}

function proseWords(text: string): string[] {
  return words(text).filter((word) => !/^(?:softmax|concat|attention|multihead|head|sin|cos|tan|log|exp|min|max|argmin|argmax|where|for|and|with|otherwise)$/i.test(word));
}

function isHeading(text: string): boolean {
  return text.length <= 180 && !/[?!;=]/u.test(text)
    && (isReferenceHeading(text) || named_heading.test(text)
      || (numbered_heading.test(text) && !/[,]|\b(?:18|19|20)\d{2}\b|[.!?]$/.test(text)));
}

/** Weight by printed characters so footers/superscripts cannot set the body size. */
export function readingPageEvidence(lines: ReadingTextLine[], page_number: number, width: number, height: number, scale: number): ReadingPageEvidence {
  const samples = lines.filter((line) => line.horizontal && words(line.text).length >= 5)
    .map((line) => ({ size: line.font_size, weight: line.text.length })).sort((a, b) => a.size - b.size);
  let remaining = samples.reduce((sum, sample) => sum + sample.weight, 0) / 2;
  let body_font_size = 10 * scale;
  for (const sample of samples) {
    body_font_size = sample.size;
    remaining -= sample.weight;
    if (remaining <= 0) break;
  }
  const body_start = Math.min(...lines.filter((line) => /^(?:Abstract\b|1\.?\s+Introduction\b)/i.test(line.text.trim())).map((line) => line.rect[1]));
  return { page_number, width, height, scale, body_font_size, body_start };
}

function tableGrid(lines: ReadingTextLine[], scale: number): boolean {
  // Combined lines retain separated cells. Repeated row/column alignment is
  // evidence of a table; font switches within a sentence are already joined.
  const rows: ReadingTextLine[][] = [];
  for (const line of lines.filter((line) => line.horizontal)) {
    const center = (line.rect[1] + line.rect[3]) / 2;
    const row = rows.find((items) => Math.abs((items[0].rect[1] + items[0].rect[3]) / 2 - center) < line.font_size * 0.5);
    if (row) row.push(line);
    else rows.push([line]);
  }
  const cells = rows.filter((row) => row.length >= 2 && row.every((line) => words(line.text).length <= 6));
  if (cells.length < 3) return false;
  const starts: Array<{ x: number; rows: Set<number> }> = [];
  cells.forEach((row, index) => row.forEach((cell) => {
    const column = starts.find((item) => Math.abs(item.x - cell.rect[0]) < 4 * scale);
    if (column) column.rows.add(index);
    else starts.push({ x: cell.rect[0], rows: new Set([index]) });
  }));
  const aligned_columns = starts.filter((column) => column.rows.size >= 3).length;
  const numeric = cells.flat().filter((cell) => /^(?:[+−-]?\d|[✓✗✔✘]|yes$|no$)/i.test(cell.text.trim())).length;
  return aligned_columns >= 2 && (aligned_columns >= 3 || numeric >= 3);
}

/** Label an existing crop without changing its geometry or rendering strategy. */
export function classifyReadingRegion(region: ReadingRegionEvidence, page: ReadingPageEvidence, figure_label: string | null): ReadingBlockType {
  if (figure_label) return 'graph';
  const lines = region.lines;
  const text = lines.map((line) => line.text.trim()).filter(Boolean).join(' ');
  const rect = region.rect;
  const area = Math.max(1, (rect[2] - rect[0]) * (rect[3] - rect[1]));
  const graphic = region.graphic_rect;
  const substantial_graphic = graphic !== null && region.graphic_pixels >= 24 * page.scale ** 2
    && graphic[2] - graphic[0] > 24 * page.scale && graphic[3] - graphic[1] > 18 * page.scale;
  if (!text) return substantial_graphic ? 'graph' : 'others';
  if (/^\d{1,4}$/.test(text) || /^arxiv\s*:/i.test(text)) return 'others';
  if (lines.some((line) => /^Algorithm\s+\d+\b/i.test(line.text.trim()))) return 'others';
  const ordinary_words = proseWords(text);
  const math = math_pattern.test(text);
  const prose_lines = lines.filter((line) => proseWords(line.text).length >= 7);
  const grid = region.graphic_pixels / area < 0.12 && tableGrid(lines, page.scale);
  const caption_index = lines.findIndex((line) => caption_pattern.test(line.text.trim()));
  // A wrapped prose mention can begin “Table 6. In this table ...”. A later
  // caption needs visual evidence and cannot swallow a preceding paragraph.
  if (caption_index >= 0 && (caption_index === 0 || ((grid || substantial_graphic)
    && !lines.slice(0, caption_index).some((line) => proseWords(line.text).length >= 7)))) {
    return /^table/i.test(lines[caption_index].text.trim()) ? 'table' : 'graph';
  }
  if (grid) return prose_lines.length ? 'others' : 'table';
  // A short connective such as “where” can belong to a displayed equation.
  // Paragraphs with inline math retain their prose classification.
  if (math && ordinary_words.length <= 12 && new Set(ordinary_words).size <= 6 && !prose_lines.length) return 'equation';

  const title_size = lines.every((line) => line.font_size >= page.body_font_size * 1.16);
  if (!substantial_graphic && lines.length <= 3 && text.length <= 180
    && !lines.slice(1).some((line) => proseWords(line.text).length >= 7 && /[.!?]$/.test(line.text.trim()))
    && (isHeading(text) || (title_size && !/[.!?;]$/.test(text) && ordinary_words.length >= 2))) return 'title';

  // Before the first abstract/introduction, ordinary-sized text usually holds
  // names, affiliations, correspondence, or the preprint's publication notice.
  if (page.page_number === 1 && rect[3] < page.body_start && page.body_start !== Infinity) return 'others';
  if (page.page_number === 1 && /@|\b(?:university|institute|department|equal contribution)\b/i.test(text)
    && !prose_lines.length) return 'others';
  if (rect[1] < page.height * 0.055 && lines.length <= 2 && !prose_lines.length) return 'others';
  if (rect[1] > page.height * 0.93 && lines.length <= 2) return 'others';
  if (lines.some((line) => !line.horizontal)) return 'others';

  // Embedded prose plus a sizeable plot or displayed equation is intentionally
  // left mixed. Tiny vector rules and glyph overhangs do not make prose a graph.
  if (substantial_graphic && region.graphic_pixels / area >= 0.035) return ordinary_words.length < 7 ? 'graph' : 'others';
  if (math && !prose_lines.length && ordinary_words.length < 10) return 'others';
  if (ordinary_words.length >= 4 || prose_lines.length) return 'content';
  return 'others';
}

/** Apply bibliography context in source order, before figures are relocated. */
export function classifyReadingDocument(blocks: ReadingBlock[], page_bounds: ReadonlyMap<number, readonly number[]> = new Map()): ReadingBlock[] {
  const first_on_page = new Map<number, ReadingBlock>();
  for (const block of blocks) if (!first_on_page.has(block.page_number)) first_on_page.set(block.page_number, block);
  const headers = new Map<string, ReadingBlock[]>();
  for (const block of first_on_page.values()) {
    const text = block.text.trim().replace(/\s+/g, ' ');
    if (block.page_number === 1 || !text || text.length > 180 || block.text.split('\n').length > 2
      || block.source_rect[3] - block.source_rect[1] > 40 || isHeading(text)) continue;
    const matching = headers.get(text) ?? [];
    matching.push(block);
    headers.set(text, matching);
  }
  const running_headers = new Set<string>();
  for (const matching of headers.values()) {
    for (const block of matching) {
      if (matching.some((other) => other !== block && Math.abs(other.source_rect[3] - block.source_rect[3]) < 12)) running_headers.add(block.block_id);
    }
  }
  let in_bibliography = false;
  return blocks.map<ReadingBlock>((block) => {
    if (running_headers.has(block.block_id)) return { ...block, block_type: 'others' };
    const lines = block.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const bounds = page_bounds.get(block.page_number);
    // Preserve a known footer even while bibliography context is active. Use
    // PDF coordinates (including a nonzero page origin), not the cropped height.
    if (block.block_type === 'others' && bounds && lines.length <= 2
      && block.source_rect[3] < bounds[1] + (bounds[3] - bounds[1]) * 0.07) return block;
    let reference_lines = 0;
    let other_lines = 0;
    let heading = false;
    for (const line of lines) {
      if (isReferenceHeading(line)) { in_bibliography = true; heading = true; continue; }
      if (in_bibliography && (isReferenceSectionEnd(line) || (block.block_type === 'title' && isHeading(line)))) in_bibliography = false;
      if (/^\d{1,4}$/.test(line)) continue;
      if (in_bibliography) reference_lines++;
      else other_lines++;
    }
    let block_type = block.block_type;
    if (heading && !reference_lines && !other_lines) block_type = 'title';
    else if (reference_lines && (heading || other_lines)) block_type = 'others';
    else if (reference_lines && ['content', 'others', 'title'].includes(block_type)
      && lines.some((line) => words(line).length >= 2)) block_type = 'reference';
    return block_type === block.block_type ? block : { ...block, block_type };
  });
}
