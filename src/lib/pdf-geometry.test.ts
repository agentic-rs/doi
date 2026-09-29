import { describe, expect, it } from 'vitest';
import { anchorViewportPosition, normalizePdfText, quadToSvgPoints, rectToPdfQuad, safeReferenceUrl, textQuote } from './pdf-geometry';

describe('PDF anchor geometry', () => {
  it('clips a browser selection to the page and stores PDF-space visual corner order', () => {
    const viewport = {
      convertToPdfPoint: (x: number, y: number) => [x / 2 + 15, 800 - y / 2],
      convertToViewportPoint: (x: number, y: number) => [(x - 15) * 2, (800 - y) * 2],
    };
    const quad = rectToPdfQuad({ left: 80, top: 230, right: 180, bottom: 250 }, { left: 100, top: 200, right: 700, bottom: 1000 }, viewport);
    expect(quad).toEqual([15, 785, 55, 785, 55, 775, 15, 775]);
    expect(quadToSvgPoints(quad!, viewport)).toBe('0,30 80,30 80,50 0,50');
    expect(rectToPdfQuad({ left: 0, top: 0, right: 20, bottom: 20 }, { left: 100, top: 200, right: 700, bottom: 1000 }, viewport)).toBeNull();
  });

  it('preserves quads under rotated page transforms', () => {
    const viewport = {
      convertToPdfPoint: (x: number, y: number) => [y / 2, x / 2],
      convertToViewportPoint: (x: number, y: number) => [y * 2, x * 2],
    };
    const quad = rectToPdfQuad({ left: 20, top: 40, right: 100, bottom: 60 }, { left: 0, top: 0, right: 800, bottom: 1200 }, viewport);
    expect(quad).toEqual([20, 10, 20, 50, 30, 50, 30, 10]);
    expect(quadToSvgPoints(quad!, viewport)).toBe('20,40 100,40 100,60 20,60');
  });

  it('focuses the same annotation passage at different zoom levels', () => {
    const quads = [[50, 400, 150, 400, 150, 380, 50, 380] as const];
    const unscaled = { convertToPdfPoint: (x: number, y: number) => [x, 800 - y], convertToViewportPoint: (x: number, y: number) => [x, 800 - y] };
    const scaled = { convertToPdfPoint: (x: number, y: number) => [x / 2, 800 - y / 2], convertToViewportPoint: (x: number, y: number) => [x * 2, (800 - y) * 2] };
    const mutable = quads.map((quad) => [...quad] as [number, number, number, number, number, number, number, number]);
    expect(anchorViewportPosition(mutable, unscaled, 600, 800)).toEqual(anchorViewportPosition(mutable, scaled, 1200, 1600));
    expect(anchorViewportPosition(mutable, unscaled, 600, 800)[1]).toBe(0.45);
  });
});

describe('PDF quote anchors', () => {
  it('normalizes ligatures, discretionary hyphens, and whitespace consistently', () => {
    expect(normalizePdfText('  A ﬁrst\n line\u00adbreak  ')).toBe('A first linebreak');
    expect(textQuote('ﬁrst\n line', 'A first line with context.')).toEqual({
      exact_text: 'first line', prefix: 'A ', suffix: ' with context.', normalization_version: 1,
    });
  });

  it('uses a selection offset to distinguish repeated phrases', () => {
    expect(textQuote('attention', 'attention in the title; attention in the body', 24).prefix).toBe('attention in the title; ');
  });

  it('never manufactures context when a quote is absent', () => {
    expect(textQuote('equation', 'A scanned figure.').prefix).toBe('');
  });

  it('allows only regular web URLs for external PDF links', () => {
    expect(safeReferenceUrl('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/abs/1706.03762');
    expect(safeReferenceUrl('javascript:alert(1)')).toBeNull();
    expect(safeReferenceUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects embedded credentials and missing hosts', () => {
    expect(safeReferenceUrl('https://username:password@example.org/paper')).toBeNull();
    expect(safeReferenceUrl('https://username@example.org/paper')).toBeNull();
    expect(safeReferenceUrl('https://:password@example.org/paper')).toBeNull();
    expect(safeReferenceUrl('https://')).toBeNull();
    expect(safeReferenceUrl('http://example.org:8080/paper')).toBe('http://example.org:8080/paper');
  });

  it('bounds both the original UTF-8 input and the canonical URL for native opening', () => {
    const prefix = 'https://example.org/';
    const limit = `${prefix}${'a'.repeat(8192 - prefix.length)}`;
    expect(safeReferenceUrl(limit)).toBe(limit);
    expect(safeReferenceUrl(`${limit}a`)).toBeNull();
    expect(safeReferenceUrl(`${prefix}${'界'.repeat(2800)}`)).toBeNull();
    expect(safeReferenceUrl(`${prefix}${'界'.repeat(1000)}`)).toBeNull();
    expect(safeReferenceUrl(`${prefix}文章`)).toBe(`${prefix}%E6%96%87%E7%AB%A0`);
  });
});
