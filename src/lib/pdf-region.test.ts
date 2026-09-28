import { describe, expect, it } from 'vitest';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { rectToPdfQuad } from './pdf-geometry';
import { regionGeometry, regionTextContent } from './pdf-region';

function fixturePage(): PDFPageProxy {
  return {
    rotate: 0,
    getViewport: ({ scale, rotation = 0, offsetX = 0, offsetY = 0 } = { scale: 1 }) => {
      const rotated = rotation % 180 !== 0;
      const toViewport = (x: number, y: number) => {
        const point = rotation === 90 ? [y - 20, x - 10] : [x - 10, 820 - y];
        return [point[0] * scale + offsetX, point[1] * scale + offsetY];
      };
      return {
        width: (rotated ? 800 : 600) * scale,
        height: (rotated ? 600 : 800) * scale,
        scale, rotation,
        convertToViewportPoint: toViewport,
        convertToViewportRectangle: (rect: number[]) => [...toViewport(rect[0], rect[1]), ...toViewport(rect[2], rect[3])],
        convertToPdfPoint: (x: number, y: number) => rotation === 90
          ? [(y - offsetY) / scale + 10, (x - offsetX) / scale + 20]
          : [(x - offsetX) / scale + 10, 820 - (y - offsetY) / scale],
      } as PageViewport;
    },
  } as PDFPageProxy;
}

describe('cropped PDF source geometry', () => {
  it('keeps the existing viewport unchanged for original PDF pages', () => {
    const region = regionGeometry(fixturePage(), 2, 0);
    expect(region.render_viewport).toBe(region.viewport);
    expect([region.left, region.top, region.width, region.height]).toEqual([0, 0, 1200, 1600]);
  });

  it('maps a cropped selection back to its exact source despite crop-box offsets and zoom', () => {
    const region = regionGeometry(fixturePage(), 2, 0, [100, 200, 300, 500]);
    expect([region.left, region.top, region.width, region.height]).toEqual([180, 640, 400, 600]);
    const quad = rectToPdfQuad(
      { left: 50, top: 80, right: 150, bottom: 100 },
      { left: 10, top: 20, right: 410, bottom: 620 },
      region.render_viewport,
    );
    expect(quad).toEqual([120, 470, 170, 470, 170, 460, 120, 460]);
    expect(region.viewport.convertToViewportPoint(120, 470)).toEqual([220, 700]);
    expect(region.render_viewport.convertToViewportPoint(120, 470)).toEqual([40, 60]);
  });

  it('preserves source quads after rotation and clamps crop bounds to the page', () => {
    const region = regionGeometry(fixturePage(), 2, 90, [100, 200, 300, 500]);
    expect([region.left, region.top, region.width, region.height]).toEqual([360, 180, 600, 400]);
    expect(region.render_viewport.convertToPdfPoint(40, 60)).toEqual([130, 220]);
    expect(region.render_viewport.convertToViewportPoint(130, 220)).toEqual([40, 60]);
    const clamped = regionGeometry(fixturePage(), 1, 0, [-50, -50, 300, 900]);
    expect([clamped.left, clamped.top, clamped.width, clamped.height]).toEqual([0, 0, 290, 800]);
  });

  it('falls back to an intact page when an invalid crop cannot contain content', () => {
    const region = regionGeometry(fixturePage(), 1, 0, [900, 900, 1000, 1000]);
    expect(region.render_viewport).toBe(region.viewport);
  });
});

describe('cropped PDF text', () => {
  it('retains figure labels and captions while removing selectable text in surrounding blocks', () => {
    const text = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: 80, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    const content = {
      items: [text('earlier paragraph', 20, 300), text('graph axis', 20, 200), text('Figure 1: caption', 20, 150), text('later paragraph', 20, 100), text('other column', 250, 200)],
      styles: { body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' } },
      lang: 'en',
    };
    const result = regionTextContent(content, [10, 140, 200, 240]);
    expect(result.items.map((item) => 'str' in item ? item.str : '')).toEqual(['graph axis', 'Figure 1: caption']);
    expect(result.styles).toBe(content.styles);
    expect(content.items).toHaveLength(5);
  });

  it('assigns text at a shared cut to one region only', () => {
    const content = {
      items: [{ str: 'boundary', transform: [10, 0, 0, 10, 20, 197], width: 80, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true }],
      styles: { body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' } },
      lang: null,
    };
    expect(regionTextContent(content, [0, 0, 200, 200]).items).toHaveLength(0);
    expect(regionTextContent(content, [0, 200, 200, 400]).items).toHaveLength(1);
  });
});
