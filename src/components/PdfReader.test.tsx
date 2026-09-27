// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfReaderProps, ReadingLocation } from '../lib/types';
import { PdfReader } from './PdfReader';

const pdf_fixture = vi.hoisted(() => ({
  page_sizes: Array.from({ length: 4 }, () => ({ width: 600, height: 800 })),
  annotations: new Map<number, Array<{ subtype: string; id: string; rect: number[]; dest: unknown[] }>>(),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return {
    GlobalWorkerOptions: {},
    RenderingCancelledException: class extends Error {},
    TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
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
        streamTextContent: () => new ReadableStream({ start(controller) { controller.enqueue({ items: [], styles: {}, lang: null }); controller.close(); } }),
        getAnnotations: async () => pdf_fixture.annotations.get(index + 1) ?? [],
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
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
    const height = page?.height ?? viewport_height;
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

afterEach(() => {
  cleanup();
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
