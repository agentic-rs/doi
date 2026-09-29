import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfSourceRect } from './types';

/** Retain source geometry alongside PDF.js's line breaks for bibliography links. */
export function pdfContentLines(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>): Array<{ text: string; source_rect: PdfSourceRect }> {
  const lines: Array<{ text: string; source_rect: PdfSourceRect }> = [];
  let text = '';
  let bounds: PdfSourceRect | null = null;
  const flush = () => {
    if (text.trim() && bounds) lines.push({ text, source_rect: bounds });
    text = '';
    bounds = null;
  };
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const [a, b, , , x, y] = item.transform;
    const height = Math.abs(item.height) || Math.hypot(a, b);
    // Rotated writing cannot be assigned an ordinary horizontal line safely.
    if (Math.abs(b) > Math.abs(a) * 0.1) { flush(); continue; }
    if (bounds && (Math.abs(y - bounds[1]) > height * 0.6 || x < bounds[0] - 2 || x - bounds[2] > height * 2)) flush();
    const rect: PdfSourceRect = [x, y, x + Math.abs(item.width), y + height];
    bounds = bounds ? [Math.min(bounds[0], rect[0]), Math.min(bounds[1], rect[1]), Math.max(bounds[2], rect[2]), Math.max(bounds[3], rect[3])] : rect;
    text += item.str;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

export function pdfContentText(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>): string {
  // PDF.js emits spaces as text items. Inventing a space between every item
  // would split words that are divided only because their font changes.
  return content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join('');
}

export function pdfRangeText(range: Range): string {
  // Range.toString() concatenates text nodes and ignores PDF.js's line-break
  // elements, which would merge the last and first words of adjacent lines.
  const fragment = range.cloneContents();
  for (const line_break of fragment.querySelectorAll('br')) line_break.replaceWith('\n');
  return fragment.textContent ?? '';
}
