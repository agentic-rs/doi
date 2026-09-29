import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfContentLines, pdfContentText, pdfRangeText } from './pdf-text';

describe('PDF text source consistency', () => {
  it('retains bibliography line geometry across font splits and column changes', () => {
    const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
      str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL,
    });
    const content = { items: [
      item('[7] A ', 40, 700, 30), item('title.', 70, 700, 40, true),
      item('Wrapped citation', 55, 685, 110),
      item('[8] Second column', 320, 700, 150, true),
    ] } as Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
    expect(pdfContentLines(content)).toEqual([
      { text: '[7] A title.', source_rect: [40, 700, 110, 710] },
      { text: 'Wrapped citation', source_rect: [55, 685, 165, 695] },
      { text: '[8] Second column', source_rect: [320, 700, 470, 710] },
    ]);
  });
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
