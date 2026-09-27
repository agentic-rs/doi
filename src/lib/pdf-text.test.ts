import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfContentText, pdfRangeText } from './pdf-text';

describe('PDF text source consistency', () => {
  it('preserves real word spacing, font splits, and line breaks', () => {
    const content = { items: [
      { str: 'The best', hasEOL: true },
      { str: 'perform', hasEOL: false },
      { str: 'ing', hasEOL: false },
      { str: ' ', hasEOL: false },
      { str: 'model', hasEOL: true },
    ] } as Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
    expect(pdfContentText(content)).toBe('The best\nperforming model\n');
  });

  it('includes PDF.js line breaks when reading a cloned selection', () => {
    let replacement = '';
    const fragment = {
      querySelectorAll: () => [{ replaceWith: (value: string) => { replacement = value; } }],
      get textContent() { return `The best${replacement}performing model`; },
    };
    const range = { cloneContents: () => fragment } as unknown as Range;
    expect(pdfRangeText(range)).toBe('The best\nperforming model');
  });
});
