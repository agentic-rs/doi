// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingBlock } from '../lib/types';
import { FigureDialog } from './FigureDialog';

const jobs = vi.hoisted(() => ({ text: 0 }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  RenderingCancelledException: class extends Error {},
  TextLayer: class {
    constructor() { jobs.text++; }
    render() { return Promise.resolve(); }
    cancel() {}
  },
}));

let viewport_width = 640;
let viewport_height = 480;
const resize_callbacks = new Set<() => void>();
const scroll_descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
const show_descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
let styles: HTMLStyleElement;
const figure_styles = ['pdf-reader.css', 'reading-view.css']
  .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');

function viewport(scale: number, offset_x = 0, offset_y = 0): PageViewport {
  const point = (x: number, y: number) => [x * scale + offset_x, (800 - y) * scale + offset_y];
  return {
    scale, rotation: 0, width: 600 * scale, height: 800 * scale,
    convertToViewportPoint: point,
    convertToViewportRectangle: (rect: number[]) => [...point(rect[0], rect[1]), ...point(rect[2], rect[3])],
    convertToPdfPoint: (x: number, y: number) => [(x - offset_x) / scale, 800 - (y - offset_y) / scale],
  } as PageViewport;
}

function fixture(tall = false) {
  const render_page = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const page = {
    pageNumber: 2, rotate: 0, userUnit: 1,
    getViewport: ({ scale, offsetX = 0, offsetY = 0 }: { scale: number; offsetX?: number; offsetY?: number }) => viewport(scale, offsetX, offsetY),
    getAnnotations: async () => [
      { subtype: 'Link', id: 'citation', rect: [100, 400, 200, 420], dest: [0, { name: 'Fit' }] },
      { subtype: 'Link', id: 'external', rect: [100, 450, 200, 470], url: 'https://arxiv.org/abs/1706.03762' },
    ],
    streamTextContent: () => new ReadableStream({ start(controller) {
      controller.enqueue({ items: [], styles: {}, lang: null });
      controller.close();
    } }),
    render: render_page,
  } as unknown as PDFPageProxy;
  const block: ReadingBlock = {
    block_id: 'p2-figure', page_number: 2,
    source_rect: tall ? [60, 50, 300, 750] : [60, 380, 540, 700],
    kind: 'figure', text: 'Figure 1. A graph.', figure_label: '1',
  };
  return { page, block, annotations: [], on_close: vi.fn(), on_source: vi.fn(), on_link: vi.fn(), on_error: vi.fn(), render_page };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

function figureLayout(element: HTMLElement) {
  const scroll = element.closest<HTMLElement>('.figure-dialog-scroll')!;
  const page = element.classList.contains('pdf-page') ? element : element.querySelector<HTMLElement>('.pdf-page')!;
  const width = Number.parseFloat(page.style.width);
  const height = Number.parseFloat(page.style.height);
  const wrapper = page.parentElement!;
  const style = getComputedStyle(wrapper);
  const available_width = viewport_width - 32;
  // jsdom has no layout engine. Model this column-flex layout from its actual
  // CSS, including the negative overflow of a centered oversized child.
  const wrapper_width = style.width === 'max-content'
    ? Math.max(width, style.minWidth === '100%' ? available_width : 0) : available_width;
  const page_offset = style.alignItems === 'center' ? (wrapper_width - width) / 2 : 0;
  const left = 30 + 16 + Math.max(0, (available_width - wrapper_width) / 2) - scroll.scrollLeft;
  const top = 70 + 16 - scroll.scrollTop;
  return { page, wrapper, width, height, wrapper_width, page_offset, left, top };
}

function pageBounds(element: HTMLElement): DOMRect {
  const { page, wrapper, width, height, wrapper_width, page_offset, left, top } = figureLayout(element);
  const match = /translate3d\(([-\d.e+]+)px, ([-\d.e+]+)px, 0\) scale\(([-\d.e+]+)\)/.exec(wrapper.style.transform);
  const scale = match ? Number(match[3]) : 1;
  return rect(left + (match ? Number(match[1]) : 0) + (element === page ? page_offset * scale : 0),
    top + (match ? Number(match[2]) : 0), (element === page ? width : wrapper_width) * scale, height * scale);
}

beforeEach(() => {
  viewport_width = 640;
  viewport_height = 480;
  jobs.text = 0;
  styles = document.createElement('style');
  styles.textContent = figure_styles;
  document.head.append(styles);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resize_callbacks.add(callback); }
    observe() {}
    disconnect() { resize_callbacks.delete(this.callback); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('figure-dialog-scroll') ? viewport_width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('figure-dialog-scroll') ? viewport_height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('figure-dialog-scroll')) return rect(30, 70, viewport_width, viewport_height);
    if (this.classList.contains('pdf-page') || this.classList.contains('pdf-page-wrap')) return pageBounds(this);
    return rect(30, 20, viewport_width, 50);
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    const page = this.querySelector<HTMLElement>('.pdf-page');
    const layout = page ? figureLayout(page) : null;
    const content_width = layout ? Math.max(layout.wrapper_width, layout.page_offset + layout.width) : 0;
    this.scrollLeft = Math.min(Math.max(0, content_width + 32 - viewport_width), Math.max(0, options.left ?? this.scrollLeft));
    this.scrollTop = Math.min(Math.max(0, Number.parseFloat(page?.style.height ?? '0') + 32 - viewport_height), Math.max(0, options.top ?? this.scrollTop));
  } });
});

afterEach(() => {
  cleanup();
  styles.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (scroll_descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scroll_descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  if (show_descriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show_descriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  resize_callbacks.clear();
});

async function ready() {
  await waitFor(() => expect(screen.getByLabelText('Page 2').querySelector<HTMLCanvasElement>('canvas')?.width).toBeGreaterThan(0));
}

function touch(type: string, points: Array<[number, number]>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY })) });
  fireEvent(screen.getByLabelText('Enlarged figure'), event);
  return event;
}

function sourcePoint(client_x: number, client_y: number) {
  const bounds = screen.getByLabelText('Page 2').getBoundingClientRect();
  return [(client_x - bounds.left) / bounds.width, (client_y - bounds.top) / bounds.height];
}

describe('enlarged PDF figures', () => {
  it('fits the entire figure initially and preserves the viewport point with zoom buttons', async () => {
    const props = fixture(true);
    render(<FigureDialog {...props} />);
    await ready();
    const page = screen.getByLabelText('Page 2');
    expect(getComputedStyle(page.parentElement!).alignItems).toBe('center');
    expect(Number.parseFloat(page.style.height)).toBeCloseTo(viewport_height - 32);
    expect(Number.parseFloat(page.style.width)).toBeLessThan(viewport_width - 32);
    expect((page.getBoundingClientRect().left + page.getBoundingClientRect().right) / 2).toBeCloseTo(350);
    const point = sourcePoint(350, 310);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in figure' }));
    await ready();
    expect(Number.parseFloat(page.style.height)).toBeCloseTo((viewport_height - 32) * 1.5);
    expect(sourcePoint(350, 310)[0]).toBeCloseTo(point[0]);
    expect(sourcePoint(350, 310)[1]).toBeCloseTo(point[1]);
  });

  it('previews pinch zoom on the figure alone and renders once after the gesture', async () => {
    const props = fixture();
    render(<FigureDialog {...props} />);
    await ready();
    const renders_before = props.render_page.mock.calls.length;
    const text_before = jobs.text;
    const point = sourcePoint(350, 310);
    vi.useFakeTimers();
    expect(touch('touchstart', [[250, 310], [450, 310]]).defaultPrevented).toBe(true);
    expect(touch('touchmove', [[190, 320], [510, 320]]).defaultPrevented).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(props.render_page).toHaveBeenCalledTimes(renders_before);
    expect(jobs.text).toBe(text_before);
    const wrapper = screen.getByLabelText('Page 2').parentElement!;
    expect(wrapper.style.transform).toContain('scale(1.6)');
    expect(document.querySelector<HTMLElement>('.figure-dialog-toolbar')!.style.transform).toBe('');
    touch('touchend', []);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(props.render_page).toHaveBeenCalledTimes(renders_before + 1);
    expect(jobs.text).toBe(text_before + 1);
    expect(wrapper.style.transform).toBe('');
    expect(sourcePoint(350, 320)[0]).toBeCloseTo(point[0]);
    expect(sourcePoint(350, 320)[1]).toBeCloseTo(point[1]);
  });

  it('forwards embedded citation and external link destinations without substituting the source action', async () => {
    const props = fixture();
    render(<FigureDialog {...props} />);
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    expect(props.on_link).toHaveBeenCalledWith(expect.objectContaining({ destination: [0, { name: 'Fit' }], url: null }), 2);
    fireEvent.click(screen.getByRole('button', { name: 'Open paper in Papertrail: https://arxiv.org/abs/1706.03762' }));
    expect(props.on_link).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://arxiv.org/abs/1706.03762' }), 2);
    expect(props.on_source).not.toHaveBeenCalled();
    const source_button = screen.getByRole('button', { name: 'View in PDF' });
    expect(source_button.textContent).toBe('');
    expect(source_button.title).toBe('View in PDF');
    fireEvent.click(source_button);
    expect(props.on_source).toHaveBeenCalledOnce();
  });

  it('allows both horizontal edges to be reached after the figure exceeds the viewport', async () => {
    render(<FigureDialog {...fixture()} />);
    await ready();
    const scroll = screen.getByLabelText('Enlarged figure');
    const page = screen.getByLabelText('Page 2');
    for (let count = 0; count < 6; count++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in figure' }));
    expect(Number.parseFloat(page.style.width)).toBeGreaterThan(viewport_width * 3);

    act(() => scroll.scrollTo({ left: 0 }));
    expect(page.getBoundingClientRect().left).toBeCloseTo(scroll.getBoundingClientRect().left + 16);
    act(() => scroll.scrollTo({ left: 100_000 }));
    expect(scroll.scrollLeft).toBeGreaterThan(viewport_width);
    expect(page.getBoundingClientRect().right).toBeCloseTo(scroll.getBoundingClientRect().right - 16);
    act(() => scroll.scrollTo({ left: 0 }));
    expect(page.getBoundingClientRect().left).toBeCloseTo(scroll.getBoundingClientRect().left + 16);
  });

  it('keeps the same source point when a centered zoomed figure starts overflowing after resize', async () => {
    render(<FigureDialog {...fixture(true)} />);
    await ready();
    for (let count = 0; count < 4; count++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in figure' }));
    const point = sourcePoint(350, 310);
    act(() => {
      viewport_width = 400;
      resize_callbacks.forEach((callback) => callback());
    });
    expect(sourcePoint(230, 310)[0]).toBeCloseTo(point[0]);
    expect(sourcePoint(230, 310)[1]).toBeCloseTo(point[1]);
  });

  it('cancels a preview on resize and detaches pending gestures when closed', async () => {
    const props = fixture();
    const view = render(<FigureDialog {...props} />);
    await ready();
    vi.useFakeTimers();
    touch('touchstart', [[250, 310], [450, 310]]);
    touch('touchmove', [[150, 310], [550, 310]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    act(() => {
      viewport_width = 500;
      resize_callbacks.forEach((callback) => callback());
    });
    const scroll = screen.getByLabelText('Enlarged figure');
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(screen.getByLabelText('Page 2').parentElement!.style.transform).toBe('');
    expect((screen.getByRole('button', { name: 'Zoom out figure' }) as HTMLButtonElement).disabled).toBe(true);
    touch('touchend', []);
    touch('touchstart', [[200, 310], [400, 310]]);
    touch('touchmove', [[100, 310], [500, 310]]);
    view.unmount();
    const renders_after_close = props.render_page.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(props.render_page).toHaveBeenCalledTimes(renders_after_close);
    expect(resize_callbacks.size).toBe(0);
  });
});
