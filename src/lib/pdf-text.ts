import type { PDFPageProxy } from 'pdfjs-dist';

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
