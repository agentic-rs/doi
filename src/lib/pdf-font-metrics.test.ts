import { describe, expect, it } from 'vitest';
import { pdfFontMetrics } from './pdf-font-metrics';

describe('PDF font bounds', () => {
  it.each([
    undefined,
    {},
    { ascent: 0, descent: 0 },
    { ascent: 0.3, descent: 0.3 },
    { ascent: -0.2, descent: 0.8 },
    { ascent: NaN, descent: -0.2 },
    { ascent: 0.8, descent: Infinity },
  ])('uses a nonzero em box when font bounds are unavailable: %j', (style) => {
    expect(pdfFontMetrics(style)).toEqual({ ascent: 0.8, descent: -0.2 });
  });

  it.each([
    { ascent: 0.694, descent: -0.194 },
    { ascent: 1.2, descent: -0.4 },
    { ascent: 0, descent: -0.2 },
  ])('preserves valid font bounds: %j', (style) => {
    expect(pdfFontMetrics(style)).toEqual(style);
  });
});
