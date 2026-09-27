// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfReaderProps, ReadingLocation } from '../lib/types';
import { PdfReader } from './PdfReader';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const pages = [1, 2].map((page_number) => ({
    pageNumber: page_number, rotate: 0, userUnit: 1, view: [0, 0, 600, 800],
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale, height: 800 * scale, scale,
      convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
      convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
      convertToViewportRectangle: (rect: number[]) => rect.map((value) => value * scale),
    }),
    getTextContent: async () => ({ items: [], styles: {} }),
    streamTextContent: () => new ReadableStream({ start(controller) { controller.enqueue({ items: [], styles: {}, lang: null }); controller.close(); } }),
    getAnnotations: async () => [],
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  }));
  return {
    GlobalWorkerOptions: {},
    RenderingCancelledException: class extends Error {},
    TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 2, getPage: async (number: number) => pages[number - 1], getOutline: async () => [] }),
      destroy: async () => {},
    }),
  };
});

let viewport_width = 360;
const resize_callbacks = new Set<() => void>();
const original_scroll_to = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

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
    return this.classList.contains('pdf-scroll') ? 760 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroll = this.closest<HTMLElement>('.pdf-scroll');
    const page_number = Number(this.dataset.pageNumber ?? 1);
    const width = this.classList.contains('pdf-page') ? parseFloat(this.style.width) : viewport_width;
    const height = this.classList.contains('pdf-page') ? parseFloat(this.style.height) : 760;
    const top = this.classList.contains('pdf-page') ? 24 + (page_number - 1) * (height + 24) - (scroll?.scrollTop ?? 0) : 0;
    const left = this.classList.contains('pdf-page') ? -(scroll?.scrollLeft ?? 0) : 0;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
    if (typeof options === 'number') { this.scrollLeft = options; this.scrollTop = y ?? 0; }
    else { this.scrollLeft = options?.left ?? this.scrollLeft; this.scrollTop = options?.top ?? this.scrollTop; }
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

describe('immersive PDF view', () => {
  it('fits a new paper, refits on resize, and preserves manual zoom', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(356 / 600));

    act(() => { viewport_width = 840; resize_callbacks.forEach((callback) => callback()); });
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(836 / 600));
    const fitted = latestLocation(props);
    expect(fitted.page_number).toBe(1);
    expect(fitted.page_position).toEqual([0, 0]);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(836 / 600 + 0.15));
    act(() => { viewport_width = 390; resize_callbacks.forEach((callback) => callback()); });
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(836 / 600 + 0.15));

    fireEvent.click(screen.getByRole('button', { name: 'Fit page width' }));
    await waitFor(() => expect(latestLocation(props).zoom).toBeCloseTo(386 / 600));
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('restores saved page, position, and zoom without auto-fitting', async () => {
    const saved: ReadingLocation = { paper_id: '1706.03762v7', page_number: 2, page_position: [0.2, 0.5], zoom: 1.4, rotation: 0 };
    const props = readerProps(saved);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props)).toEqual(saved));
    const reports_before_resize = vi.mocked(props.on_location_change).mock.calls.length;
    act(() => { viewport_width = 840; resize_callbacks.forEach((callback) => callback()); });
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(reports_before_resize));
    expect(latestLocation(props)).toEqual(saved);
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
