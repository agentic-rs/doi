// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfReaderProps, ReadingLocation } from '../lib/types';
import { PdfReader } from './PdfReader';

interface MockRenderRequest {
  page_number: number;
  canvas: HTMLCanvasElement;
  viewport: { width: number; height: number; scale: number; rotation: number };
  transform: number[];
  cancelled: boolean;
  complete: () => void;
}

interface CanvasCopy {
  canvas: HTMLCanvasElement;
  source: HTMLCanvasElement;
  width: number;
  height: number;
}

const pdf_fixture = vi.hoisted(() => ({
  page_sizes: Array.from({ length: 4 }, () => ({ width: 600, height: 800 })),
  annotations: new Map<number, Array<{ subtype: string; id: string; rect: number[]; dest: unknown[] }>>(),
  defer_renders: false,
  defer_text: false,
  render_requests: [] as MockRenderRequest[],
  text_requests: [] as Array<{ page_number: number; complete: () => void }>,
  canvas_copies: [] as CanvasCopy[],
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return {
    GlobalWorkerOptions: {},
    RenderingCancelledException: class extends Error {},
    TextLayer: class {
      constructor({ container, viewport }: { container: HTMLElement; viewport: { rotation: number } }) {
        container.style.setProperty('--min-font-size', '1.4');
        container.setAttribute('data-main-rotation', String(viewport.rotation));
      }
      render() { return Promise.resolve(); }
      cancel() {}
    },
    getDocument: () => {
      const pages = pdf_fixture.page_sizes.map(({ width, height }, index) => ({
        pageNumber: index + 1, rotate: 0, userUnit: 1, view: [0, 0, width, height],
        getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
          const pointToViewport = (x: number, y: number): [number, number] => {
            switch (rotation) {
              case 90: return [y * scale, x * scale];
              case 180: return [(width - x) * scale, y * scale];
              case 270: return [(height - y) * scale, (width - x) * scale];
              default: return [x * scale, (height - y) * scale];
            }
          };
          return {
            width: (rotation % 180 ? height : width) * scale,
            height: (rotation % 180 ? width : height) * scale,
            scale, rotation,
            convertToPdfPoint: (x: number, y: number) => {
              switch (rotation) {
                case 90: return [y / scale, x / scale];
                case 180: return [width - x / scale, y / scale];
                case 270: return [width - y / scale, height - x / scale];
                default: return [x / scale, height - y / scale];
              }
            },
            convertToViewportPoint: pointToViewport,
            convertToViewportRectangle: (rect: number[]) => [...pointToViewport(rect[0], rect[1]), ...pointToViewport(rect[2], rect[3])],
          };
        },
        getTextContent: async () => ({ items: [], styles: {} }),
        streamTextContent: () => new ReadableStream({
          start(controller) {
            const complete = () => { controller.enqueue({ items: [], styles: {}, lang: null }); controller.close(); };
            pdf_fixture.text_requests.push({ page_number: index + 1, complete });
            if (!pdf_fixture.defer_text) complete();
          },
        }),
        getAnnotations: async () => pdf_fixture.annotations.get(index + 1) ?? [],
        render: ({ canvas, viewport, transform }: Pick<MockRenderRequest, 'canvas' | 'viewport' | 'transform'>) => {
          let complete = () => {};
          const promise = pdf_fixture.defer_renders ? new Promise<void>((resolve) => { complete = resolve; }) : Promise.resolve();
          const request: MockRenderRequest = { page_number: index + 1, canvas, viewport, transform, cancelled: false, complete };
          pdf_fixture.render_requests.push(request);
          return { promise, cancel: () => { request.cancelled = true; } };
        },
      }));
      return {
        promise: Promise.resolve({
          numPages: pages.length, getPage: async (number: number) => pages[number - 1],
          getOutline: async () => [], getPageIndex: async (ref: { num: number }) => ref.num - 1,
        }),
        destroy: async () => {},
      };
    },
  };
});

let viewport_width = 360;
let viewport_height = 760;
const page_padding = 10;
const page_top = 16;
const page_spacing = 36;
const page_bottom = 168;
const resize_callbacks = new Set<() => void>();
const original_scroll_to = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
const original_computed_style = window.getComputedStyle;

function pageLayout(scroll: HTMLElement) {
  let top = page_top;
  return [...scroll.querySelectorAll<HTMLElement>('[data-page-number]')].map((page) => {
    const width = parseFloat(page.style.width);
    const height = parseFloat(page.style.height);
    const layout = { page, width, height, top, left: page_padding + Math.max(0, (viewport_width - page_padding * 2 - width) / 2) };
    top += height + page_spacing;
    return layout;
  });
}

function contentDimensions(scroll: HTMLElement) {
  const pages = pageLayout(scroll);
  return {
    width: Math.max(viewport_width, ...pages.map((page) => page.left + page.width + page_padding)),
    height: pages.length ? pages.at(-1)!.top + pages.at(-1)!.height + page_bottom : viewport_height,
  };
}

function resizeViewport(width: number, height = viewport_height) {
  act(() => {
    viewport_width = width;
    viewport_height = height;
    document.querySelectorAll<HTMLElement>('.pdf-scroll').forEach((scroll) => scroll.scrollTo({ left: scroll.scrollLeft, top: scroll.scrollTop }));
    resize_callbacks.forEach((callback) => callback());
  });
}

function readerProps(location: ReadingLocation | null = null): PdfReaderProps {
  return {
    paper: {
      paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
      title: 'Example paper', authors: ['Author'], abstract: 'Abstract', pdf_url: '',
      pdf_hash: 'a'.repeat(64), downloaded_at: '2026-09-27T00:00:00Z', last_location: location,
    },
    pdf_data: new Uint8Array([1]), annotations: [], target_location: location,
    navigation_key: 1, initial_fit_width: !location, controls_visible: true,
    on_toggle_controls: vi.fn(), on_location_change: vi.fn(), on_navigate: vi.fn(),
    on_selection: vi.fn(), on_references: vi.fn(), on_error: vi.fn(),
  };
}

beforeEach(() => {
  viewport_width = 360;
  viewport_height = 760;
  pdf_fixture.page_sizes = Array.from({ length: 4 }, () => ({ width: 600, height: 800 }));
  pdf_fixture.annotations.clear();
  pdf_fixture.defer_renders = false;
  pdf_fixture.defer_text = false;
  pdf_fixture.render_requests = [];
  pdf_fixture.text_requests = [];
  pdf_fixture.canvas_copies = [];
  vi.stubGlobal('devicePixelRatio', 1);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: (source: HTMLCanvasElement) => {
      pdf_fixture.canvas_copies.push({ canvas: this, source, width: source.width, height: source.height });
    } } as unknown as CanvasRenderingContext2D;
  });
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = original_computed_style(element);
    if (element.classList.contains('pdf-pages')) {
      Object.defineProperties(style, { paddingLeft: { value: '10px' }, paddingRight: { value: '10px' } });
    }
    return style;
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
      this.isPrimary = options.isPrimary ?? true;
    }
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; resize_callbacks.add(callback); }
    observe() {}
    disconnect() { resize_callbacks.delete(this.callback); }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pdf-scroll') ? viewport_width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pdf-scroll') ? viewport_height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pdf-scroll') ? contentDimensions(this).width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pdf-scroll') ? contentDimensions(this).height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroll = this.closest<HTMLElement>('.pdf-scroll');
    const page = scroll ? pageLayout(scroll).find((candidate) => candidate.page === this) : null;
    const width = page?.width ?? viewport_width;
    const height = page?.height ?? (this.classList.contains('pdf-toolbar') ? 56 : viewport_height);
    const top = page ? page.top - scroll!.scrollTop : 0;
    const left = page ? page.left - scroll!.scrollLeft : 0;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
    const left = typeof options === 'number' ? options : options?.left ?? this.scrollLeft;
    const top = typeof options === 'number' ? y ?? 0 : options?.top ?? this.scrollTop;
    this.scrollLeft = Math.max(0, Math.min(left, this.scrollWidth - this.clientWidth));
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
  } });
});

afterEach(async () => {
  await act(async () => {
    cleanup();
    pdf_fixture.render_requests.forEach((request) => request.complete());
    if (pdf_fixture.defer_text) {
      pdf_fixture.defer_text = false;
      pdf_fixture.text_requests.forEach((request) => request.complete());
    }
  });
  vi.useRealTimers();
  resize_callbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (original_scroll_to) Object.defineProperty(HTMLElement.prototype, 'scrollTo', original_scroll_to);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

function latestLocation(props: PdfReaderProps): ReadingLocation {
  return vi.mocked(props.on_location_change).mock.calls.at(-1)![0];
}

function expectActualPosition(props: PdfReaderProps) {
  const location = latestLocation(props);
  const scroll = screen.getByLabelText('Scrollable PDF pages');
  const page = [...scroll.querySelectorAll<HTMLElement>('[data-page-number]')].find((candidate) => candidate.getBoundingClientRect().bottom > 26)!;
  const bounds = page.getBoundingClientRect();
  expect(location.page_number).toBe(Number(page.dataset.pageNumber));
  expect(location.page_position[0]).toBeCloseTo(Math.max(0, Math.min(1, (20 - bounds.left) / bounds.width)));
  expect(location.page_position[1]).toBeCloseTo(Math.max(0, Math.min(1, (20 - bounds.top) / bounds.height)));
}

function firstCanvas(): HTMLCanvasElement {
  return screen.getByLabelText('Page 1').querySelector<HTMLCanvasElement>('canvas')!;
}

function latestRender(page_number = 1): MockRenderRequest {
  return pdf_fixture.render_requests.filter((request) => request.page_number === page_number).at(-1)!;
}

function latestCopy(canvas: HTMLCanvasElement): CanvasCopy {
  return pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas).at(-1)!;
}

async function expectReadyPage() {
  await waitFor(() => {
    expect(firstCanvas().width).toBeGreaterThan(0);
    expect(screen.getByLabelText('Page 1').querySelector<HTMLElement>('.textLayer')!.hidden).toBe(false);
  });
}

function pdfPointAt(page: HTMLElement, client_x: number, client_y: number): [number, number] {
  const bounds = page.getBoundingClientRect();
  return [(client_x - bounds.left) / bounds.width * 600, 800 - (client_y - bounds.top) / bounds.height * 800];
}

function expectPdfPointAt(page: HTMLElement, point: [number, number], client_x: number, client_y: number) {
  const actual = pdfPointAt(page, client_x, client_y);
  expect(actual[0]).toBeCloseTo(point[0]);
  expect(actual[1]).toBeCloseTo(point[1]);
}

function dispatchTouch(element: HTMLElement, type: string, touches: Array<{ identifier: number; clientX: number; clientY: number }>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  fireEvent(element, event);
  return event;
}

function dispatchSafariGesture(element: HTMLElement, type: string, scale: number, client_x = 180, client_y = 180): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: client_x, clientY: client_y });
  fireEvent(element, event);
  return event;
}

function dispatchZoomWheel(element: HTMLElement, delta_y = -100, client_x = 180, client_y = 180): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: delta_y, clientX: client_x, clientY: client_y });
  fireEvent(element, event);
  return event;
}

describe('immersive PDF view', () => {
  it('fits a new paper, refits on resize, and preserves manual zoom', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(336 / 600));
    expect(latestLocation(props).zoom_mode).toBe('fit_width');

    resizeViewport(840);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(816 / 600));
    const fitted = latestLocation(props);
    expect(fitted.page_number).toBe(1);
    expectActualPosition(props);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(816 / 600 + 0.15));
    expect(latestLocation(props).zoom_mode).toBe('custom');
    resizeViewport(390);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(816 / 600 + 0.15));

    fireEvent.click(screen.getByRole('button', { name: 'Fit page width' }));
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(366 / 600));
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('restores saved page, position, and zoom without auto-fitting', async () => {
    const saved: ReadingLocation = { paper_id: '1706.03762v7', page_number: 2, page_position: [0.2, 0.5], zoom: 1.4, rotation: 0 };
    const props = readerProps(saved);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props)).toEqual({ ...saved, zoom_mode: 'custom' }));
    const reports_before_resize = vi.mocked(props.on_location_change).mock.calls.length;
    resizeViewport(840);
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(reports_before_resize));
    expect(latestLocation(props)).toMatchObject({ page_number: 2, zoom: saved.zoom, zoom_mode: 'custom', rotation: 0 });
    expect(latestLocation(props).page_position[1]).toBeCloseTo(saved.page_position[1]);
    expectActualPosition(props);
  });

  it('reopens a persisted width fit at the current viewport width', async () => {
    const saved: ReadingLocation = {
      paper_id: '1706.03762v7', page_number: 2, page_position: [0, 0.3],
      zoom: 1.36, zoom_mode: 'fit_width', rotation: 0,
    };
    const props = readerProps(saved);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(336 / 600));
    expect(latestLocation(props)).toMatchObject({ page_number: 2, zoom_mode: 'fit_width' });
    expectActualPosition(props);
    resizeViewport(840);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(816 / 600));
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
    expectActualPosition(props);
  });

  it('applies same-scale page and passage navigation and retains width fit', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const next = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    expect(next.kind).toBe('internal');
    if (next.kind !== 'internal') throw new Error('Expected a page destination');
    expect(next.location).toMatchObject({ page_number: 2, zoom_mode: 'fit_width' });
    view.rerender(<PdfReader {...props} target_location={next.location} navigation_key={2} />);
    await waitFor(() => expect(latestLocation(props).page_number).toBe(2));
    expectActualPosition(props);

    const passage = { ...latestLocation(props), page_position: [0, 0.25] as [number, number] };
    const before_jump = vi.mocked(props.on_location_change).mock.calls.length;
    view.rerender(<PdfReader {...props} target_location={passage} navigation_key={3} />);
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(before_jump));
    expect(latestLocation(props).page_position[1]).toBeCloseTo(0.25);
    expectActualPosition(props);

    resizeViewport(840);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(816 / 600));
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
  });

  it('recomputes width fit when PDF pages rotate', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(336 / 600));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
    await waitFor(() => expect(latestLocation(props)).toMatchObject({ rotation: 90, zoom_mode: 'fit_width' }));
    expect(latestLocation(props).zoom).toBeCloseTo(336 / 800);
    expect(parseFloat(screen.getByLabelText('Page 1').style.width)).toBeCloseTo(336);
    expect(parseFloat(screen.getByLabelText('Page 1').style.height)).toBeCloseTo(252);
    expectActualPosition(props);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
    await waitFor(() => expect(latestLocation(props).rotation).toBe(180));
    expect(latestLocation(props).zoom).toBeCloseTo(336 / 600);
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
  });

  it('keeps custom zoom when pages rotate and the viewport grows', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(336 / 600));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('custom'));
    const custom_zoom = latestLocation(props).zoom;
    fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
    await waitFor(() => expect(latestLocation(props).rotation).toBe(90));
    expect(latestLocation(props).zoom).toBe(custom_zoom);
    expect(parseFloat(screen.getByLabelText('Page 1').style.width)).toBeCloseTo(800 * custom_zoom);
    const before_resize = vi.mocked(props.on_location_change).mock.calls.length;
    resizeViewport(840);
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(before_resize));
    expect(latestLocation(props)).toMatchObject({ zoom: custom_zoom, zoom_mode: 'custom', rotation: 90 });
    expectActualPosition(props);
  });

  it('uses an explicit XYZ citation zoom as custom scaling', async () => {
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'explicit-zoom', rect: [10, 10, 100, 40], dest: [1, { name: 'XYZ' }, 0, 800, 1.2] }]);
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    fireEvent.click(await screen.findByRole('button', { name: 'Follow citation to its destination' }));
    await waitFor(() => expect(props.on_navigate).toHaveBeenCalled());
    const destination = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    if (destination.kind !== 'internal') throw new Error('Expected an internal citation');
    expect(destination.location).toMatchObject({ page_number: 2, zoom: 1.2, zoom_mode: 'custom' });
    view.rerender(<PdfReader {...props} target_location={destination.location} navigation_key={2} />);
    await waitFor(() => expect(latestLocation(props)).toMatchObject({ page_number: 2, zoom: 1.2, zoom_mode: 'custom' }));
    const before_resize = vi.mocked(props.on_location_change).mock.calls.length;
    resizeViewport(840);
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(before_resize));
    expect(latestLocation(props).zoom).toBe(1.2);
  });

  it('refits when navigating to a page with a different width', async () => {
    pdf_fixture.page_sizes[1] = { width: 1_600, height: 600 };
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const destination = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    if (destination.kind !== 'internal') throw new Error('Expected a page destination');
    view.rerender(<PdfReader {...props} target_location={destination.location} navigation_key={2} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(336 / 1_600));
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
    expect(parseFloat(screen.getByLabelText('Page 2').style.width)).toBeCloseTo(336);
    expectActualPosition(props);
  });

  it('reports the visible position when an end-of-paper destination is clamped', async () => {
    const requested: ReadingLocation = {
      paper_id: '1706.03762v7', page_number: 4, page_position: [1, 1],
      zoom: 0.4, zoom_mode: 'custom', rotation: 0,
    };
    const props = readerProps(requested);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_location_change).toHaveBeenCalled());
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    expect(scroll.scrollTop).toBeCloseTo(scroll.scrollHeight - scroll.clientHeight);
    expect(scroll.scrollLeft).toBe(0);
    expect(latestLocation(props).page_number).toBe(3);
    expectActualPosition(props);
  });

  it('keeps hidden controls accessible without remounting the PDF', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} controls_visible={false} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeLessThan(1));
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show reading controls' }));
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('Scrollable PDF pages'), { key: 'f' });
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(2);
    const page = screen.getByLabelText('Page 1');
    view.rerender(<PdfReader {...props} controls_visible />);
    expect(screen.getByLabelText('Page 1')).toBe(page);
    fireEvent.keyDown(screen.getByLabelText('Scrollable PDF pages'), { key: 'Escape' });
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(3);
  });

  it('reveals controls on taps while leaving drags and native text selection alone', async () => {
    const props = readerProps();
    render(<PdfReader {...props} controls_visible={false} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeLessThan(1));
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    vi.useFakeTimers();
    const pointer = { pointerId: 1, isPrimary: true, button: 0, clientX: 30, clientY: 40 };
    fireEvent.pointerDown(scroll, pointer);
    fireEvent.pointerUp(scroll, pointer);
    act(() => vi.advanceTimersByTime(180));
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(scroll, pointer);
    fireEvent.pointerMove(scroll, { ...pointer, clientY: 80 });
    fireEvent.pointerUp(scroll, pointer);
    act(() => vi.advanceTimersByTime(180));
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(scroll, pointer);
    fireEvent.pointerUp(scroll, pointer);
    const range = document.createRange();
    range.selectNodeContents(document.body);
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range } as unknown as Selection);
    fireEvent(document, new Event('selectionchange'));
    act(() => vi.advanceTimersByTime(180));
    expect(props.on_toggle_controls).toHaveBeenCalledTimes(1);
  });

  it('starts the tap hint after introductory panels close and shows it only once', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} controls_visible={false} reading_active={false} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeLessThan(1));
    const hint = 'Tap the page to show reading controls';
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText(hint)).toBeNull();

    view.rerender(<PdfReader {...props} controls_visible={false} reading_active />);
    expect(screen.getByText(hint)).toBeTruthy();
    act(() => vi.advanceTimersByTime(3_999));
    expect(screen.getByText(hint)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText(hint)).toBeNull();

    view.rerender(<PdfReader {...props} controls_visible={false} reading_active={false} />);
    view.rerender(<PdfReader {...props} controls_visible={false} reading_active />);
    expect(screen.queryByText(hint)).toBeNull();
  });
});

describe('PDF zoom gestures and rendering', () => {
  it('captures ctrl-wheel inside the PDF, anchors its point, and renders at the full native pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const canvas = firstCanvas();
    const toolbar = document.querySelector<HTMLElement>('.pdf-toolbar')!;
    const toolbar_height = toolbar.getBoundingClientRect().height;
    const anchor = pdfPointAt(page, 180, 180);
    const previous_zoom = latestLocation(props).zoom;
    const previous_pixels = canvas.width;
    const wheel = dispatchZoomWheel(scroll);

    expect(wheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(latestLocation(props).zoom).toBeGreaterThan(previous_zoom));
    await expectReadyPage();
    expect(latestLocation(props).zoom_mode).toBe('custom');
    expectPdfPointAt(page, anchor, 180, 180);
    expect(firstCanvas()).toBe(canvas);
    expect(canvas.width).toBeGreaterThan(previous_pixels);
    expect(latestRender().transform).toEqual([3, 0, 0, 3, 0, 0]);
    expect(canvas.width).toBe(Math.floor(latestRender().viewport.width * 3));
    expect(canvas.height).toBe(Math.floor(latestRender().viewport.height * 3));
    expect(latestCopy(canvas)).toMatchObject({ width: canvas.width, height: canvas.height });
    expect(latestCopy(canvas).source).not.toBe(canvas);
    expect(scroll.clientWidth).toBe(360);
    expect(scroll.clientHeight).toBe(760);
    expect(toolbar.getBoundingClientRect().height).toBe(toolbar_height);
    expect(page.closest<HTMLElement>('.pdf-reader')!.style.transform).toBe('');
    expect(props.on_toggle_controls).not.toHaveBeenCalled();

    const zoom_after_pdf_gesture = latestLocation(props).zoom;
    expect(dispatchZoomWheel(toolbar).defaultPrevented).toBe(false);
    fireEvent.wheel(scroll, { deltaY: -100 });
    expect(latestLocation(props).zoom).toBe(zoom_after_pdf_gesture);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps the same PDF point beneath a moving two-finger midpoint and never opens controls', async () => {
    const props = readerProps();
    render(<PdfReader {...props} controls_visible={false} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const anchor = pdfPointAt(page, 180, 180);
    const initial_zoom = latestLocation(props).zoom;
    const pointer = { pointerId: 1, isPrimary: true, button: 0, clientX: 140, clientY: 180 };
    fireEvent.pointerDown(scroll, pointer);
    const start = dispatchTouch(scroll, 'touchstart', [
      { identifier: 1, clientX: 140, clientY: 180 },
      { identifier: 2, clientX: 220, clientY: 180 },
    ]);
    const first_move = dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: 100, clientY: 180 },
      { identifier: 2, clientX: 260, clientY: 180 },
    ]);
    expect(start.defaultPrevented).toBe(true);
    expect(first_move.defaultPrevented).toBe(true);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2));
    expectPdfPointAt(page, anchor, 180, 180);

    const moved_midpoint = dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: 90, clientY: 220 },
      { identifier: 2, clientX: 310, clientY: 220 },
    ]);
    expect(moved_midpoint.defaultPrevented).toBe(true);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 220 / 80));
    expectPdfPointAt(page, anchor, 200, 220);
    dispatchTouch(scroll, 'touchend', []);
    fireEvent.pointerUp(scroll, pointer);
    await expectReadyPage();
    expect(firstCanvas().width).toBe(Math.floor(parseFloat(page.style.width)));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
    expect(latestLocation(props).zoom_mode).toBe('custom');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('captures Safari gesture events and restores the anchor at their current midpoint', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const anchor = pdfPointAt(page, 180, 180);
    const initial_zoom = latestLocation(props).zoom;
    expect(dispatchSafariGesture(scroll, 'gesturestart', 1).defaultPrevented).toBe(true);
    expect(dispatchSafariGesture(scroll, 'gesturechange', 2, 200, 220).defaultPrevented).toBe(true);
    expect(dispatchSafariGesture(scroll, 'gestureend', 2, 200, 220).defaultPrevented).toBe(true);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2));
    await expectReadyPage();
    expectPdfPointAt(page, anchor, 200, 220);
    expect(firstCanvas().width).toBe(Math.floor(parseFloat(page.style.width)));
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps the previous canvas while rendering and never commits a canceled older viewport', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const canvas = firstCanvas();
    const old_pixels = { width: canvas.width, height: canvas.height };
    const old_copy_count = pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas).length;
    const initial_zoom = latestLocation(props).zoom;
    pdf_fixture.defer_renders = true;
    dispatchZoomWheel(scroll);
    await waitFor(() => expect(latestRender().viewport.scale).toBeGreaterThan(initial_zoom));
    const canceled = latestRender();
    expect(canceled.canvas).not.toBe(canvas);
    expect(firstCanvas()).toBe(canvas);
    expect({ width: canvas.width, height: canvas.height }).toEqual(old_pixels);
    expect(pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas)).toHaveLength(old_copy_count);
    expect(page.querySelector<HTMLElement>('.textLayer')!.hidden).toBe(true);
    expect(page.querySelector('.pdf-page-placeholder')).toBeNull();

    dispatchZoomWheel(scroll);
    await waitFor(() => expect(latestRender().viewport.scale).toBeGreaterThan(canceled.viewport.scale));
    const newest = latestRender();
    expect(canceled.cancelled).toBe(true);
    await act(async () => { newest.complete(); });
    await expectReadyPage();
    expect(latestCopy(canvas).source).toBe(newest.canvas);
    expect(canvas.width).toBe(Math.floor(newest.viewport.width));
    expect(canvas.height).toBe(Math.floor(newest.viewport.height));
    expect(page.querySelector<HTMLElement>('.textLayer')!.getAttribute('data-main-rotation')).toBe('0');
    expect(page.querySelector<HTMLElement>('.textLayer')!.style.getPropertyValue('--min-font-size')).toBe('1.4');
    const newest_pixels = { width: canvas.width, height: canvas.height };
    const committed_copy_count = pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas).length;

    await act(async () => { canceled.complete(); });
    expect(firstCanvas()).toBe(canvas);
    expect({ width: canvas.width, height: canvas.height }).toEqual(newest_pixels);
    expect(pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas)).toHaveLength(committed_copy_count);
    expect(latestCopy(canvas).source).toBe(newest.canvas);
    expect(newest.canvas.width).toBe(0);
    expect(canceled.canvas.width).toBe(0);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('limits large-page raster buffers to sixteen million pixels', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    pdf_fixture.page_sizes[0] = { width: 2_000, height: 3_000 };
    const props = readerProps({
      paper_id: '1706.03762v7', page_number: 1, page_position: [0, 0],
      zoom: 3, zoom_mode: 'custom', rotation: 0,
    });
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBe(3));
    await expectReadyPage();
    const request = latestRender();
    const expected_ratio = Math.sqrt(16_000_000 / (6_000 * 9_000));
    expect(request.transform[0]).toBeCloseTo(expected_ratio);
    expect(firstCanvas().width).toBe(Math.floor(6_000 * expected_ratio));
    expect(firstCanvas().height).toBe(Math.floor(9_000 * expected_ratio));
    expect(firstCanvas().width * firstCanvas().height).toBeLessThanOrEqual(16_000_000);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('releases canceled settled buffers without waiting for pending cached text extraction', async () => {
    pdf_fixture.defer_text = true;
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const pending_text_count = pdf_fixture.text_requests.filter((request) => request.page_number === 1).length;
    expect(pending_text_count).toBeGreaterThan(0);
    for (let update = 0; update < 3; update += 1) {
      const previous = latestRender();
      dispatchZoomWheel(scroll);
      await waitFor(() => expect(latestRender().viewport.scale).toBeGreaterThan(previous.viewport.scale));
      await waitFor(() => expect(previous.canvas.width).toBe(0));
      expect(previous.cancelled).toBe(true);
      expect(previous.canvas.height).toBe(0);
    }
    expect(pdf_fixture.text_requests.filter((request) => request.page_number === 1)).toHaveLength(pending_text_count);
    expect(pdf_fixture.canvas_copies).toHaveLength(0);
    const newest = latestRender();
    expect(newest.canvas.width).toBeGreaterThan(0);
    await act(async () => {
      pdf_fixture.defer_text = false;
      pdf_fixture.text_requests.forEach((request) => request.complete());
    });
    await expectReadyPage();
    expect(latestCopy(firstCanvas()).source).toBe(newest.canvas);
    expect(firstCanvas().width).toBe(Math.floor(newest.viewport.width));
    expect(newest.canvas.width).toBe(0);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('does not capture zoom gestures while reading is obstructed', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} reading_active={false} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const zoom_before_gestures = latestLocation(props).zoom;
    expect(dispatchZoomWheel(scroll).defaultPrevented).toBe(false);
    expect(dispatchSafariGesture(scroll, 'gesturestart', 1).defaultPrevented).toBe(false);
    expect(dispatchSafariGesture(scroll, 'gesturechange', 2).defaultPrevented).toBe(false);
    expect(dispatchTouch(scroll, 'touchstart', [
      { identifier: 1, clientX: 140, clientY: 180 },
      { identifier: 2, clientX: 220, clientY: 180 },
    ]).defaultPrevented).toBe(false);
    expect(dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: 100, clientY: 180 },
      { identifier: 2, clientX: 260, clientY: 180 },
    ]).defaultPrevented).toBe(false);
    expect(latestLocation(props).zoom).toBe(zoom_before_gestures);

    view.rerender(<PdfReader {...props} reading_active />);
    expect(dispatchZoomWheel(scroll).defaultPrevented).toBe(true);
    await waitFor(() => expect(latestLocation(props).zoom).toBeGreaterThan(zoom_before_gestures));
    expect(props.on_error).not.toHaveBeenCalled();
  });
});
