// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { SelectionPage } from '../lib/pdf-selection';
import type { Annotation } from '../lib/types';
import { PdfPage } from './PdfPage';
import { createSplitLineLayout, refineSplitLineCuts, splitLineInkCovered } from '../lib/pdf-line-layout';
import { regionGeometry } from '../lib/pdf-region';
import type { PreparedSplitText } from '../lib/pdf-split-text';

const split = vi.hoisted(() => ({ prepare: vi.fn(), create: vi.fn(), refine: vi.fn() }));
vi.mock('../lib/pdf-split-text', () => ({ prepareSplitPdfText: split.prepare, createSplitTextLayer: split.create, refinePreparedSplitText: split.refine }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  RenderingCancelledException: class extends Error {},
  TextLayer: class {
    constructor({ textContentSource, container }: { textContentSource: { items: Array<{ str: string }> }; container: HTMLElement }) {
      for (const item of textContentSource.items) {
        const span = document.createElement('span');
        span.textContent = item.str;
        container.append(span);
      }
    }
    render() { return Promise.resolve(); }
    cancel() {}
  },
}));

function pageFixture() {
  const render_page = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const text = (str: string, y: number) => ({ str, transform: [10, 0, 0, 10, 100, y], width: 90, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
  const page = {
    pageNumber: 3, rotate: 0, userUnit: 1,
    getViewport: ({ scale, offsetX = 0, offsetY = 0 } = { scale: 1 }) => {
      const toViewport = (x: number, y: number) => [x * scale + offsetX, (800 - y) * scale + offsetY];
      return {
        width: 600 * scale, height: 800 * scale, scale, rotation: 0,
        convertToViewportPoint: toViewport,
        convertToViewportRectangle: (rect: number[]) => [...toViewport(rect[0], rect[1]), ...toViewport(rect[2], rect[3])],
        convertToPdfPoint: (x: number, y: number) => [(x - offsetX) / scale, 800 - (y - offsetY) / scale],
      } as PageViewport;
    },
    streamTextContent: () => new ReadableStream({ start(controller) {
      controller.enqueue({ items: [text('Inside crop', 450), text('Outside crop', 650)], styles: {}, lang: null });
      controller.close();
    } }),
    getAnnotations: async () => [
      { subtype: 'Link', id: 'inside', rect: [180, 430, 260, 450], url: 'https://example.com/inside' },
      { subtype: 'Link', id: 'outside', rect: [180, 630, 260, 650], url: 'https://example.com/outside' },
    ],
    render: render_page,
  } as unknown as PDFPageProxy;
  return { page, render_page };
}

beforeEach(() => {
  split.prepare.mockReset();
  split.create.mockReset();
  split.refine.mockReset();
  split.refine.mockImplementation((prepared: PreparedSplitText, raster, scale: number) => {
    const layout = refineSplitLineCuts(prepared.layout, raster, scale);
    if (!layout) throw new Error('A line break would cut through printed text. Its original lines are kept.');
    if (!splitLineInkCovered(layout, raster, scale)) throw new Error('The printed content could not be split without clipping. Its original lines are kept.');
    return layout === prepared.layout ? prepared : { ...prepared, layout };
  });
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
});

function splitFixture(page: PDFPageProxy) {
  const crop: [number, number, number, number] = [80, 400, 220, 500];
  const prepared: PreparedSplitText = {
    layout: createSplitLineLayout(140, 100, [{ rect: [20, 40, 110, 60], breaks: [70] }])!,
    viewport: regionGeometry(page, 1, 0, crop).render_viewport,
    text: 'Inside crop', text_style: '', font_scale: 1, fragments: [],
  };
  const quads_for_range = vi.fn(() => [[160, 450, 190, 450, 190, 440, 160, 440]]);
  split.prepare.mockResolvedValue(prepared);
  split.create.mockImplementation(() => {
    const element = document.createElement('div');
    element.className = 'split-text-fixture';
    const first = document.createElement('span');
    first.textContent = 'Inside ';
    const second = document.createElement('span');
    second.textContent = 'crop';
    element.append(first, second);
    return { element, quads_for_range };
  });
  return { crop, prepared, quads_for_range };
}

describe('split PDF line rendering', () => {
  it('renders the source crop once, composites its strips, and registers exact source mappings', async () => {
    const { page, render_page } = pageFixture();
    const { crop, prepared, quads_for_range } = splitFixture(page);
    const props = { page, source_rect: crop, block_id: 'content-3', split_lines: true, zoom: 2, rotation: 0,
      render_paused: false, scroll_root: document.createElement('div'), annotations: [],
      register_page: vi.fn<(id: string, selection: SelectionPage | null) => void>(), on_link: vi.fn(), on_error: vi.fn(),
      on_split_status: vi.fn(), on_layout_change: vi.fn() };
    const view = render(<PdfPage {...props} />);
    await waitFor(() => {
      expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'ready');
      expect(view.container.querySelector('[data-split-preparing]')).toBeNull();
      expect(view.container.querySelector<HTMLElement>('.textLayer')?.hidden).toBe(false);
    });
    expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'preparing');
    expect(split.prepare).toHaveBeenCalledTimes(1);
    expect(split.create).toHaveBeenCalledWith(prepared, 4);
    expect(render_page).toHaveBeenCalledTimes(1);
    const rendered = (render_page.mock.calls[0] as unknown as [{ viewport: PageViewport }])[0].viewport;
    expect([rendered.width, rendered.height]).toEqual([560, 400]);
    const canvas = view.container.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([280, 496]);
    expect(canvas.getContext('2d')!.drawImage).toHaveBeenCalledTimes(prepared.layout.pieces.length);
    expect(canvas.getContext('2d')!.fillRect).toHaveBeenCalledWith(0, 0, 280, 496);
    const selection = props.register_page.mock.calls.find(([, value]) => value)?.[1];
    expect(selection?.text_layer).toBe(view.container.querySelector('.split-text-fixture'));
    expect(selection?.quads_for_range).toBe(quads_for_range);
    expect(selection?.source_point_for_position?.([10 / 70, 74 / 124])).toEqual([160, 450]);
    expect(selection?.position_for_source_point?.([160, 450])).toEqual([10 / 70, 74 / 124]);
    expect(props.on_layout_change).toHaveBeenCalledTimes(2);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('moves highlights and clickable PDF links into their corresponding display strips', async () => {
    const { page } = pageFixture();
    const { crop } = splitFixture(page);
    page.getAnnotations = async () => [{ subtype: 'Link', id: 'across', rect: [140, 440, 160, 450], dest: [1, { name: 'Fit' }] }];
    const annotation: Annotation = {
      schema_version: 1, annotation_id: 'note', created_at: '', updated_at: '', body: { kind: 'note', content: 'Note' },
      target: { paper_id: 'paper', pdf_hash: '', page_anchors: [{ page_number: 3,
        quad_points: [[140, 450, 160, 450, 160, 440, 140, 440]],
        text_quote: { exact_text: 'Inside crop', prefix: '', suffix: '', normalization_version: 1 } }] },
    };
    const on_link = vi.fn();
    const view = render(<PdfPage page={page} source_rect={crop} block_id="content-3" split_lines zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[annotation]}
      register_page={vi.fn()} on_link={on_link} on_error={vi.fn()} />);
    const links = await screen.findAllByRole('button', { name: 'Go to destination within this paper' });
    expect(links).toHaveLength(2);
    expect(links.map((link) => [link.style.left, link.style.top, link.style.width, link.style.height])).toEqual([
      ['240px', '200px', '40px', '40px'], ['0px', '296px', '40px', '40px'],
    ]);
    expect([...view.container.querySelectorAll('polygon')].map((polygon) => polygon.getAttribute('points'))).toEqual([
      '240,200 280,200 280,240 240,240', '0,296 40,296 40,336 0,336',
    ]);
    fireEvent.click(links[1]);
    expect(on_link).toHaveBeenCalledWith(expect.objectContaining({ link_id: 'across', destination: [1, { name: 'Fit' }] }), 3);
  });

  it('keeps the finished bitmap during preparation and safely falls back when a block cannot split', async () => {
    const { page, render_page } = pageFixture();
    const { crop } = splitFixture(page);
    let reject!: (error: Error) => void;
    split.prepare.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const props = { page, source_rect: crop, block_id: 'content-3', zoom: 2, rotation: 0,
      render_paused: false, scroll_root: document.createElement('div'), annotations: [],
      register_page: vi.fn(), on_link: vi.fn(), on_error: vi.fn(), on_split_status: vi.fn() };
    const view = render(<PdfPage {...props} />);
    await screen.findByRole('button', { name: 'Open in browser: https://example.com/inside' });
    const canvas = view.container.querySelector('canvas')!;
    view.rerender(<PdfPage {...props} split_lines />);
    await waitFor(() => expect(split.prepare).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector('.pdf-page')?.getAttribute('data-split-preparing')).toBe('true');
    expect([canvas.width, canvas.height]).toEqual([280, 200]);
    expect(render_page).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('A long word cannot be split safely.')); });
    await waitFor(() => expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'unavailable', 'A long word cannot be split safely.'));
    expect(view.container.querySelector('.textLayer')?.textContent).toBe('Inside crop');
    expect([canvas.width, canvas.height]).toEqual([280, 200]);
    expect(view.container.querySelector('[data-split-preparing]')).toBeNull();
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps the original bitmap when the source raster reveals ink outside the retained strips', async () => {
    const { page, render_page } = pageFixture();
    const { crop } = splitFixture(page);
    const context = document.createElement('canvas').getContext('2d')!;
    context.getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      const offset = (Math.floor(height / 2) * width + width - 2) * 4;
      data.set([0, 0, 0, 255], offset);
      return { width, height, data } as ImageData;
    });
    const props = { page, source_rect: crop, block_id: 'content-3', zoom: 2, rotation: 0,
      render_paused: false, scroll_root: document.createElement('div'), annotations: [],
      register_page: vi.fn<(id: string, selection: SelectionPage | null) => void>(), on_link: vi.fn(), on_error: vi.fn(), on_split_status: vi.fn() };
    const view = render(<PdfPage {...props} />);
    await screen.findByRole('button', { name: 'Open in browser: https://example.com/inside' });
    const canvas = view.container.querySelector('canvas')!;
    view.rerender(<PdfPage {...props} split_lines />);
    await waitFor(() => expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'unavailable',
      'Split lines could not be displayed: The printed content could not be split without clipping. Its original lines are kept.'));
    await waitFor(() => expect(view.container.querySelector('.textLayer')?.textContent).toBe('Inside crop'));
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, 560, 400);
    expect(render_page).toHaveBeenCalledTimes(3);
    expect([canvas.width, canvas.height]).toEqual([280, 200]);
    expect(view.container.querySelector('.textLayer')?.textContent).toBe('Inside crop');
    const restored = props.register_page.mock.calls.filter(([, value]) => value).at(-1)?.[1];
    expect(restored?.quads_for_range).toBeUndefined();
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('re-registers a completed split after a paused pinch without rendering it again', async () => {
    const { page, render_page } = pageFixture();
    const { crop } = splitFixture(page);
    const props = { page, source_rect: crop, block_id: 'content-3', split_lines: true, zoom: 2, rotation: 0,
      scroll_root: document.createElement('div'), annotations: [], register_page: vi.fn(),
      on_link: vi.fn(), on_error: vi.fn(), on_split_status: vi.fn(), on_layout_change: vi.fn() };
    const view = render(<PdfPage {...props} render_paused={false} />);
    await waitFor(() => expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'ready'));
    props.on_split_status.mockClear();
    props.on_layout_change.mockClear();
    view.rerender(<PdfPage {...props} render_paused />);
    expect(props.register_page).toHaveBeenLastCalledWith('content-3', null);
    view.rerender(<PdfPage {...props} render_paused={false} />);
    await waitFor(() => expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'ready'));
    expect(render_page).toHaveBeenCalledTimes(1);
    expect(props.register_page).toHaveBeenLastCalledWith('content-3', expect.objectContaining({ quads_for_range: expect.any(Function) }));
    expect(props.on_layout_change).not.toHaveBeenCalled();
  });

  it('commits mixed three-line and compact source rows at the same font scale after their mapping is ready', async () => {
    const { page, render_page } = pageFixture();
    const { crop, prepared } = splitFixture(page);
    prepared.layout.fit_width = 70;
    const final_prepared: PreparedSplitText = { ...prepared, layout: {
      width: 70, fit_width: 70, height: 100, line_counts: [1, 3, 1], pieces: [
        { source_rect: [0, 0, 140, 40], display_rect: [0, 0, 70, 20] },
        { source_rect: [0, 40, 40, 60], display_rect: [0, 20, 40, 40] },
        { source_rect: [40, 40, 80, 60], display_rect: [0, 40, 40, 60] },
        { source_rect: [80, 40, 140, 60], display_rect: [0, 60, 60, 80] },
        { source_rect: [0, 60, 140, 100], display_rect: [0, 80, 70, 100] },
      ],
    } };
    split.refine.mockReturnValue(final_prepared);
    const context = document.createElement('canvas').getContext('2d')!;
    context.getImageData = vi.fn((_x: number, _y: number, width: number, height: number) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }) as ImageData);
    let finish!: () => void;
    render_page.mockImplementationOnce(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    render_page.mockImplementationOnce(() => ({ promise: new Promise<void>((resolve) => { finish = resolve; }), cancel: vi.fn() }));
    const props = { page, source_rect: crop, block_id: 'content-3', split_lines: true, zoom: 2, rotation: 0,
      render_paused: false, scroll_root: document.createElement('div'), annotations: [],
      register_page: vi.fn<(id: string, selection: SelectionPage | null) => void>(), on_link: vi.fn(), on_error: vi.fn(), on_split_status: vi.fn() };
    const view = render(<PdfPage {...props} />);
    await waitFor(() => expect(render_page).toHaveBeenCalledTimes(2));
    expect(view.container.querySelector('[data-split-preparing]')).not.toBeNull();
    expect(props.on_split_status).not.toHaveBeenCalledWith('content-3', 'ready');
    expect(props.register_page.mock.calls.some(([, value]) => value)).toBe(false);
    await act(async () => { finish(); });
    await waitFor(() => {
      expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'ready');
      expect(view.container.querySelector('[data-split-preparing]')).toBeNull();
    });
    const scales = (render_page.mock.calls as unknown as Array<[{ viewport: PageViewport }]>).map(([options]) => options.viewport.scale);
    expect(scales).toEqual([4, 4]);
    expect(split.create).toHaveBeenCalledWith(final_prepared, 4);
    expect([view.container.querySelector('canvas')?.width, view.container.querySelector('canvas')?.height]).toEqual([280, 400]);
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, 560, 160, 0, 0, 280, 80);
    const selection = props.register_page.mock.calls.filter(([, value]) => value).at(-1)?.[1];
    expect(selection?.position_for_source_point?.([150, 480])).toEqual([35 / 70, 10 / 100]);
    expect(selection?.source_point_for_position?.([35 / 70, 10 / 100])).toEqual([150, 480]);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('restores normal sizing and source registration after resetting split lines', async () => {
    const { page, render_page } = pageFixture();
    const { crop } = splitFixture(page);
    const props = { page, source_rect: crop, block_id: 'content-3', zoom: 2, rotation: 0,
      render_paused: false, scroll_root: document.createElement('div'), annotations: [],
      register_page: vi.fn<(id: string, selection: SelectionPage | null) => void>(), on_link: vi.fn(), on_error: vi.fn(),
      on_split_status: vi.fn(), on_layout_change: vi.fn() };
    const view = render(<PdfPage {...props} split_lines />);
    await waitFor(() => expect(props.on_split_status).toHaveBeenCalledWith('content-3', 'ready'));
    props.on_layout_change.mockClear();
    view.rerender(<PdfPage {...props} />);
    await waitFor(() => expect(view.container.querySelector('canvas')?.height).toBe(200));
    expect(view.container.querySelector('canvas')?.width).toBe(280);
    expect(render_page).toHaveBeenCalledTimes(2);
    const restored = props.register_page.mock.calls.filter(([, selection]) => selection).at(-1)?.[1];
    expect(restored?.quads_for_range).toBeUndefined();
    expect(restored?.source_point_for_position).toBeUndefined();
    expect(restored?.viewport.convertToPdfPoint(40, 100)).toEqual([100, 450]);
    expect(props.on_layout_change).toHaveBeenCalledTimes(2);
  });

  it('falls back at nonzero rotation without attempting split preparation', async () => {
    const { page } = pageFixture();
    const { crop } = splitFixture(page);
    const on_split_status = vi.fn();
    render(<PdfPage page={page} source_rect={crop} block_id="content-3" split_lines zoom={1} rotation={90}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={vi.fn()} on_link={vi.fn()} on_error={vi.fn()} on_split_status={on_split_status} />);
    await waitFor(() => expect(on_split_status).toHaveBeenCalledWith('content-3', 'unavailable', 'Set the page rotation to 0° to split lines.'));
    expect(split.prepare).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Open in browser: https://example.com/inside' })).toBeDefined();
  });

  it('discards preparation completed after the block was closed', async () => {
    const { page, render_page } = pageFixture();
    const { crop, prepared } = splitFixture(page);
    let complete!: (value: PreparedSplitText) => void;
    split.prepare.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const register_page = vi.fn();
    const on_split_status = vi.fn();
    const view = render(<PdfPage page={page} source_rect={crop} block_id="content-3" split_lines zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={register_page} on_link={vi.fn()} on_error={vi.fn()} on_split_status={on_split_status} />);
    await waitFor(() => expect(split.prepare).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { complete(prepared); });
    expect(render_page).not.toHaveBeenCalled();
    expect(register_page).not.toHaveBeenCalledWith('content-3', expect.any(Object));
    expect(on_split_status).not.toHaveBeenCalledWith('content-3', 'ready');
  });

  it('snaps a drifting word cut to printed whitespace without another render when the width fits', async () => {
    const { page, render_page } = pageFixture();
    const { crop, prepared } = splitFixture(page);
    const context = document.createElement('canvas').getContext('2d')!;
    context.getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let y = 40 * 4; y < 60 * 4; y++) for (let x = 20 * 4; x < 110 * 4; x++) {
        if (x < 66 * 4 || x >= 69 * 4) data.set([0, 0, 0, 255], (y * width + x) * 4);
      }
      return { width, height, data } as ImageData;
    });
    const register_page = vi.fn<(id: string, selection: SelectionPage | null) => void>();
    const on_split_status = vi.fn();
    render(<PdfPage page={page} source_rect={crop} block_id="content-3" split_lines zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={register_page} on_link={vi.fn()} on_error={vi.fn()} on_split_status={on_split_status} />);
    await waitFor(() => expect(on_split_status).toHaveBeenCalledWith('content-3', 'ready'));
    expect(render_page).toHaveBeenCalledTimes(1);
    const refined = split.create.mock.calls[0][0] as PreparedSplitText;
    expect(refined.layout.pieces[1].source_rect[0]).toBe(67.5);
    expect(refined.layout.width).toBe(70);
    expect(prepared.layout.pieces[1].source_rect[0]).toBe(70);
    const selection = register_page.mock.calls.filter(([, value]) => value).at(-1)?.[1];
    expect(selection?.source_point_for_position?.([12.5 / 70, 74 / 124])).toEqual([160, 450]);
    expect(selection?.position_for_source_point?.([160, 450])).toEqual([12.5 / 70, 74 / 124]);
  });

  it('renders at the final fitting scale once more when the corrected gutter widens a half', async () => {
    const { page, render_page } = pageFixture();
    const { crop, prepared } = splitFixture(page);
    prepared.layout = createSplitLineLayout(140, 100, [{ rect: [0, 40, 140, 60], breaks: [70] }])!;
    let source_scale = 0;
    render_page.mockImplementation((...args: unknown[]) => {
      source_scale = (args[0] as { viewport: PageViewport }).viewport.scale;
      return { promise: Promise.resolve(), cancel: vi.fn() };
    });
    const context = document.createElement('canvas').getContext('2d')!;
    context.getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const source_x = (x + 0.5) / source_scale;
        const source_y = (y + 0.5) / source_scale;
        if (source_y >= 40 && source_y < 60 && (source_x < 66 || source_x >= 69)) data.set([0, 0, 0, 255], (y * width + x) * 4);
      }
      return { width, height, data } as ImageData;
    });
    const on_split_status = vi.fn();
    const view = render(<PdfPage page={page} source_rect={crop} block_id="content-3" split_lines zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={vi.fn()} on_link={vi.fn()} on_error={vi.fn()} on_split_status={on_split_status} />);
    await waitFor(() => expect(on_split_status).toHaveBeenCalledWith('content-3', 'ready'));
    expect(render_page).toHaveBeenCalledTimes(2);
    expect(split.create).toHaveBeenCalledTimes(1);
    const refined = split.create.mock.calls[0][0] as PreparedSplitText;
    expect(refined.layout.width).toBe(72.5);
    expect(split.create.mock.calls[0][1]).toBeCloseTo(280 / 72.5);
    expect(view.container.querySelector('canvas')?.width).toBe(280);
    expect(view.container.querySelector('[data-split-preparing]')).toBeNull();
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PDF region rendering', () => {
  it('allocates a highlight layer only for actual page marks and preserves their geometry', async () => {
    const { page } = pageFixture();
    const props = { page, zoom: 2, rotation: 0, render_paused: false, scroll_root: document.createElement('div'),
      register_page: vi.fn(), on_link: vi.fn(), on_error: vi.fn() };
    const mark: Annotation = {
      schema_version: 1, annotation_id: 'mark', created_at: '', updated_at: '', body: { kind: 'note', content: 'Note' },
      target: { paper_id: 'paper', pdf_hash: '', page_anchors: [{ page_number: 3, quad_points: [[100, 450, 190, 450, 190, 440, 100, 440]],
        text_quote: { exact_text: 'Inside crop', prefix: '', suffix: '', normalization_version: 1 } }] },
    };
    const view = render(<PdfPage {...props} annotations={[]} />);
    await waitFor(() => expect(props.register_page).toHaveBeenCalled());
    expect(view.container.querySelector('.pdf-highlight-layer')).toBeNull();
    view.rerender(<PdfPage {...props} annotations={[mark]} />);
    expect(view.container.querySelector('polygon')?.getAttribute('points')).toBe('200,700 380,700 380,720 200,720');
    view.rerender(<PdfPage {...props} annotations={[{ ...mark, target: { ...mark.target,
      page_anchors: [{ ...mark.target.page_anchors[0], quad_points: [] }] } }]} />);
    expect(view.container.querySelector('.pdf-highlight-layer')).toBeNull();
  });

  it('distinguishes PDF, app, and browser link hints without adding visible icons', async () => {
    const { page } = pageFixture();
    page.getAnnotations = async () => [
      { subtype: 'Link', id: 'pdf', rect: [100, 430, 120, 450], dest: [0, { name: 'Fit' }] },
      { subtype: 'Link', id: 'app', rect: [130, 430, 150, 450], url: 'https://arxiv.org/abs/1706.03762' },
      { subtype: 'Link', id: 'external', rect: [160, 430, 180, 450], url: 'https://example.com/paper' },
    ];
    render(<PdfPage page={page} zoom={1} rotation={0} render_paused={false}
      scroll_root={document.createElement('div')} annotations={[]} register_page={vi.fn()} on_link={vi.fn()} on_error={vi.fn()} />);
    const pdf = await screen.findByRole('button', { name: 'Go to destination within this paper' });
    const app = screen.getByRole('button', { name: 'Open paper in Paper Reader: https://arxiv.org/abs/1706.03762' });
    const external = screen.getByRole('button', { name: 'Open in browser: https://example.com/paper' });
    expect([pdf.dataset.linkKind, app.dataset.linkKind, external.dataset.linkKind]).toEqual(['pdf', 'app', 'external']);
    expect([pdf.title, app.title, external.title]).toEqual([
      'Within this paper', 'Open paper in Paper Reader: https://arxiv.org/abs/1706.03762', 'Open in browser: https://example.com/paper',
    ]);
    expect([pdf.childElementCount, app.childElementCount, external.childElementCount]).toEqual([0, 0, 0]);
  });

  it('renders only the crop canvas and registers matching source coordinates and text', async () => {
    const { page, render_page } = pageFixture();
    const register_page = vi.fn<(id: string, selection: SelectionPage | null) => void>();
    const result = render(<PdfPage page={page} source_rect={[80, 400, 220, 500]} block_id="p3-figure1" zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={register_page} on_link={vi.fn()} on_error={vi.fn()} />);
    await waitFor(() => expect(register_page).toHaveBeenCalledWith('p3-figure1', expect.any(Object)));
    const selection = register_page.mock.calls.find(([, value]) => value)?.[1];
    expect(selection?.text).toBe('Inside crop\n');
    expect(selection?.viewport.convertToPdfPoint(40, 100)).toEqual([100, 450]);
    expect(result.container.querySelector('.textLayer')?.textContent).toBe('Inside crop');
    const canvas = result.container.querySelector('canvas');
    expect([canvas?.width, canvas?.height]).toEqual([280, 200]);
    const viewport = (render_page.mock.calls[0] as unknown as [{ viewport: PageViewport }])[0].viewport;
    expect(viewport.convertToViewportPoint(100, 450)).toEqual([40, 100]);
    const link = screen.getByRole('button', { name: 'Open in browser: https://example.com/inside' });
    expect([link.style.left, link.style.top, link.style.width, link.style.height]).toEqual(['200px', '100px', '80px', '40px']);
    expect(screen.queryByRole('button', { name: 'Open in browser: https://example.com/outside' })).toBeNull();
    expect(result.container.querySelector('.pdf-page-label')).toBeNull();
  });
});
