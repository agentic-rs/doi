// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Annotation, PdfReaderProps, PdfSourceRect, ReadingBlock, ReadingLayout, ReadingLocation } from '../lib/types';
import type { PreparedSplitText } from '../lib/pdf-split-text';
import type { SplitLineRect } from '../lib/pdf-line-layout';
import { regionGeometry } from '../lib/pdf-region';
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
  annotations: new Map<number, Array<{ subtype: string; id: string; rect: number[]; dest?: unknown[] | string; url?: string; action?: string }>>(),
  destinations: new Map<string, unknown[] | null | Promise<unknown[] | null>>(),
  page_indices: new Map<number, number | Promise<number>>(),
  outline: [] as Array<{ title: string; dest?: unknown[] | string; url?: string; items: [] }>,
  defer_renders: false,
  defer_text: false,
  fail_text_page: null as number | null,
  defer_text_page: null as number | null,
  render_requests: [] as MockRenderRequest[],
  text_requests: [] as Array<{ page_number: number; complete: () => void }>,
  text_layer_starts: [] as Array<{ scale: number; rotation: number }>,
  canvas_copies: [] as CanvasCopy[],
  text_content: new Map<number, Array<{ str: string; transform: number[]; width: number; height: number; fontName: string; dir: string; hasEOL: boolean }>>(),
}));

const reading_fixture = vi.hoisted(() => ({ layout: null as ReadingLayout | null }));
const split_fixture = vi.hoisted(() => ({
  initial_ids: new Set<string>(), loading: false, load_failed: false, error: null as string | null,
  change: vi.fn(), change_all: vi.fn(), retry: vi.fn(), prepare: vi.fn(),
}));

vi.mock('../lib/use-reading-block-preferences', () => ({
  useReadingBlockPreferences: () => {
    const [split_ids, setSplitIds] = useState(() => new Set(split_fixture.initial_ids));
    const [busy, setBusy] = useState<string | null>(null);
    const [busy_all, setBusyAll] = useState(false);
    return {
      isSplit: (block: ReadingBlock) => split_ids.has(block.block_id),
      loading: split_fixture.loading, load_failed: split_fixture.load_failed, busy, error: split_fixture.error, retry: split_fixture.retry,
      busy_all, saving: busy !== null || busy_all,
      setSplit: async (block: ReadingBlock, split: boolean) => {
        setBusy(block.block_id);
        const accepted = await split_fixture.change(block, split);
        if (accepted) setSplitIds((current) => {
          const next = new Set(current);
          if (split) next.add(block.block_id);
          else next.delete(block.block_id);
          return next;
        });
        setBusy(null);
        return accepted;
      },
      setAllSplit: async (blocks: ReadingBlock[], split: boolean) => {
        setBusyAll(true);
        const accepted = await split_fixture.change_all(blocks, split);
        if (accepted) setSplitIds((current) => {
          const next = new Set(current);
          for (const block of blocks) {
            if (split) next.add(block.block_id);
            else next.delete(block.block_id);
          }
          return next;
        });
        setBusyAll(false);
        return accepted;
      },
    };
  },
}));

vi.mock('../lib/pdf-split-text', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pdf-split-text')>(),
  prepareSplitPdfText: split_fixture.prepare,
}));

vi.mock('../lib/use-reading-layout', () => ({
  useReadingLayout: (pages: unknown, _hash: string, _paper_id: string, enabled: boolean) => ({
    layout: pages && enabled ? reading_fixture.layout : null,
    progress: { completed: 0, total: 4 }, error: null, retry: vi.fn(),
  }),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return {
    GlobalWorkerOptions: {},
    RenderingCancelledException: class extends Error {},
    TextLayer: class {
      constructor({ container, viewport, textContentSource }: { container: HTMLElement; viewport: { scale: number; rotation: number }; textContentSource: { items: Array<{ str: string }> } }) {
        pdf_fixture.text_layer_starts.push({ scale: viewport.scale, rotation: viewport.rotation });
        container.style.setProperty('--min-font-size', '1.4');
        container.setAttribute('data-main-rotation', String(viewport.rotation));
        for (const item of textContentSource.items) {
          const span = document.createElement('span');
          span.textContent = item.str;
          container.append(span);
        }
      }
      render() { return Promise.resolve(); }
      cancel() {}
    },
    getDocument: () => {
      const pages = pdf_fixture.page_sizes.map(({ width, height }, index) => ({
        pageNumber: index + 1, rotate: 0, userUnit: 1, view: [0, 0, width, height],
        getViewport: ({ scale, rotation = 0, offsetX = 0, offsetY = 0 }: { scale: number; rotation?: number; offsetX?: number; offsetY?: number }) => {
          const pointToViewport = (x: number, y: number): [number, number] => {
            let point: [number, number];
            switch (rotation) {
              case 90: point = [y * scale, x * scale]; break;
              case 180: point = [(width - x) * scale, y * scale]; break;
              case 270: point = [(height - y) * scale, (width - x) * scale]; break;
              default: point = [x * scale, (height - y) * scale];
            }
            return [point[0] + offsetX, point[1] + offsetY];
          };
          return {
            width: (rotation % 180 ? height : width) * scale,
            height: (rotation % 180 ? width : height) * scale,
            scale, rotation,
            convertToPdfPoint: (x: number, y: number) => {
              x -= offsetX;
              y -= offsetY;
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
            if (pdf_fixture.fail_text_page === index + 1) { controller.error(new Error("Unreadable text")); return; }
            const complete = () => { controller.enqueue({ items: pdf_fixture.text_content.get(index + 1) ?? [], styles: {}, lang: null }); controller.close(); };
            pdf_fixture.text_requests.push({ page_number: index + 1, complete });
            if (!pdf_fixture.defer_text && pdf_fixture.defer_text_page !== index + 1) complete();
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
          getOutline: async () => pdf_fixture.outline,
          getDestination: async (name: string) => pdf_fixture.destinations.get(name) ?? null,
          getPageIndex: async (ref: { num: number }) => pdf_fixture.page_indices.get(ref.num) ?? ref.num - 1,
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
// Match the late shared PDF import from global styles in the production bundle.
const reader_styles = ['reading-view.css', 'reference-components.css', 'note-card.css', 'pdf-reader.css']
  .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');

function pageLayout(scroll: HTMLElement) {
  let top = page_top;
  return [...scroll.querySelectorAll<HTMLElement>('[data-page-number]')].map((page) => {
    const width = parseFloat(page.style.width);
    const height = parseFloat(page.style.height);
    const left = page_padding + Math.max(0, (viewport_width - page_padding * 2 - width) / 2);
    const zoom = Number(page.closest<HTMLElement>('.reading-pages')?.style.getPropertyValue('--reading-zoom') || 1);
    const article_top = top;
    const label_height = page.closest('.reading-block')?.querySelector('.reading-block-type') ? 20 * zoom : 0;
    top += label_height;
    const note_top = top + height;
    let note_height = 0;
    const notes = [...(page.closest('.reading-block')?.querySelectorAll<HTMLElement>('.note-card') ?? [])].map((element) => {
      // Simulate card reflow so restoration tests observe actual height changes.
      const content = element.querySelector('.note-card-content');
      const height = (content ? 170 + (content.textContent?.length ?? 0) : 44) * zoom;
      const note = { element, height, top: note_top + 8 * zoom + note_height, left, width };
      note_height += height + 6 * zoom;
      return note;
    });
    if (notes.length) note_height += 16 * zoom;
    const layout = { page, width, height, top, left, notes, note_height, article_top, label_height };
    top += height + page_spacing + note_height;
    return layout;
  });
}

function contentDimensions(scroll: HTMLElement) {
  const pages = pageLayout(scroll);
  return {
    width: Math.max(viewport_width, ...pages.map((page) => page.left + page.width + page_padding)),
    height: pages.length ? pages.at(-1)!.top + pages.at(-1)!.height + pages.at(-1)!.note_height + page_bottom : viewport_height,
  };
}

function previewTransform(wrapper: HTMLElement | null) {
  const transform = wrapper?.style.transform ?? '';
  const match = transform.match(/^translate3d\(([-\d.e+]+)px,\s*([-\d.e+]+)px,\s*0(?:px)?\)\s*scale\(([-\d.e+]+)\)$/);
  return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : { x: 0, y: 0, scale: 1 };
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
  pdf_fixture.destinations.clear();
  pdf_fixture.page_indices.clear();
  pdf_fixture.outline = [];
  pdf_fixture.defer_renders = false;
  pdf_fixture.defer_text = false;
  pdf_fixture.fail_text_page = null;
  pdf_fixture.defer_text_page = null;
  pdf_fixture.render_requests = [];
  pdf_fixture.text_requests = [];
  pdf_fixture.text_layer_starts = [];
  pdf_fixture.canvas_copies = [];
  pdf_fixture.text_content.clear();
  reading_fixture.layout = null;
  split_fixture.initial_ids.clear();
  split_fixture.loading = false;
  split_fixture.load_failed = false;
  split_fixture.error = null;
  split_fixture.change.mockReset().mockResolvedValue(true);
  split_fixture.change_all.mockReset().mockResolvedValue(true);
  split_fixture.retry.mockReset();
  split_fixture.prepare.mockReset().mockImplementation((page: PDFPageProxy, source_rect: PdfSourceRect) => Promise.resolve(preparedSplit(page, source_rect)));
  vi.stubGlobal('devicePixelRatio', 1);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { fillRect: vi.fn(), drawImage: (source: HTMLCanvasElement) => {
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
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      if (reading_fixture.layout) this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() {}
  });
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
    const wrapper_page = scroll ? pageLayout(scroll).find((candidate) => candidate.page.parentElement === this) : null;
    const article_page = scroll ? pageLayout(scroll).find((candidate) => candidate.page.closest('.reading-block') === this) : null;
    const note = scroll ? pageLayout(scroll).flatMap((candidate) => candidate.notes).find((candidate) => candidate.element === this) : null;
    const layout = page ?? wrapper_page ?? article_page;
    const pages_container = Boolean(scroll && this.classList.contains('pdf-pages'));
    const preview = previewTransform(layout?.page.closest<HTMLElement>('.reading-block') ?? layout?.page.parentElement ?? null);
    const width = layout ? layout.width * preview.scale : note?.width ?? viewport_width;
    const height = layout ? (layout.height + (wrapper_page ? 24 : 0) + (article_page ? layout.note_height + layout.label_height : 0)) * preview.scale : note?.height ?? (pages_container
      ? contentDimensions(scroll!).height : this.classList.contains('pdf-toolbar') ? 56 : viewport_height);
    const top = layout ? layout.article_top + (article_page ? 0 : layout.label_height * preview.scale) + preview.y - scroll!.scrollTop : note ? note.top - scroll!.scrollTop : pages_container ? -scroll!.scrollTop : 0;
    const left = layout ? layout.left + preview.x - scroll!.scrollLeft : note ? note.left - scroll!.scrollLeft : pages_container ? -scroll!.scrollLeft : 0;
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

function dispatchTouch(element: HTMLElement, type: string, touches: Array<{ identifier: number; clientX: number; clientY: number }>, changed_touches = touches): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: changed_touches });
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

function heavyWork(props: PdfReaderProps) {
  return {
    page_renders: pdf_fixture.render_requests.length,
    text_layers: pdf_fixture.text_layer_starts.length,
    canvas_copies: pdf_fixture.canvas_copies.length,
    location_reports: vi.mocked(props.on_location_change).mock.calls.length,
  };
}

async function advancePreviewFrame(duration = 16) {
  await act(async () => { await vi.advanceTimersByTimeAsync(duration); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

function readingProps(block_id = 'p1-body'): PdfReaderProps {
  reading_fixture.layout = {
    layout_version: 5, pdf_hash: 'a'.repeat(64), page_count: 4,
    blocks: [
      { block_id: 'p1-intro', page_number: 1, source_rect: [60, 540, 300, 740], kind: 'text', block_type: 'title', text: 'Introduction', figure_label: null },
      { block_id: 'p2-figure', page_number: 2, source_rect: [60, 380, 540, 700], kind: 'figure', block_type: 'graph', text: 'Figure 1', figure_label: 'Figure 1' },
      { block_id: 'p1-body', page_number: 1, source_rect: [320, 100, 560, 700], kind: 'text', block_type: 'content', text: 'Body paragraph', figure_label: null },
      { block_id: 'p2-body', page_number: 2, source_rect: [60, 80, 300, 330], kind: 'text', block_type: 'content', text: 'Later paragraph', figure_label: null },
      { block_id: 'p3-original', page_number: 3, source_rect: [0, 0, 600, 800], kind: 'original', block_type: 'others', text: '', figure_label: null },
    ],
  };
  return readerProps({
    paper_id: '1706.03762v7', page_number: 1, reader_mode: 'reading', reading_block_id: block_id,
    page_position: block_id === 'p1-body' ? [320 / 600, 0.5] : [60 / 600, 60 / 800],
    zoom: 1, zoom_mode: 'fit_width', rotation: 0,
  });
}

function readingBlock(block_id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-block-id="${block_id}"]`)!;
}

function preparedSplit(page: PDFPageProxy, source_rect: PdfSourceRect): PreparedSplitText {
  const geometry = regionGeometry(page, 1, 0, source_rect);
  const half_width = geometry.width / 2;
  const row_height = geometry.height / 6;
  const pieces = Array.from({ length: 6 }, (_, row) => [0, 1].map((half) => ({
    source_rect: [half * half_width, row * row_height, (half + 1) * half_width, (row + 1) * row_height] as SplitLineRect,
    display_rect: [0, (row * 2 + half) * row_height, half_width, (row * 2 + half + 1) * row_height] as SplitLineRect,
  }))).flat();
  return {
    layout: { width: half_width, height: geometry.height * 2, pieces },
    viewport: geometry.render_viewport, text: 'First half second half', text_style: '', font_scale: 1,
    fragments: pieces.map((piece, piece_index) => ({
      text: 'Text', style: '', piece_index, left: piece.source_rect[0], top: piece.source_rect[1],
      character_rects: Array.from({ length: 4 }, (_, index) => [
        piece.source_rect[0] + index * 5, piece.source_rect[1], piece.source_rect[0] + (index + 1) * 5, piece.source_rect[1] + 10,
      ] as SplitLineRect),
    })),
  };
}

function splitReadingProps(): PdfReaderProps {
  const props = readingProps();
  reading_fixture.layout!.blocks[2].source_rect = [320, 500, 560, 620];
  props.target_location = {
    ...props.target_location!, page_position: [460 / 600, 230 / 800], zoom: 3, zoom_mode: 'custom',
  };
  return props;
}

function expectSplitSource(location: ReadingLocation) {
  expect(location).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', page_number: 1 });
  expect(location.page_position[0]).toBeCloseTo(460 / 600);
  expect(location.page_position[1]).toBeCloseTo(230 / 800);
}

async function expectSplitReady() {
  await waitFor(() => {
    expect(readingBlock('p1-body').querySelector('.textLayer > .textLayer')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore original lines in block on page 1' }) as HTMLButtonElement).disabled).toBe(false);
  });
}

describe('split lines in Reading view', () => {
  it('keeps an isolated narrow margin stamp compact instead of fitting it to full width', async () => {
    const props = readingProps('p1-intro');
    reading_fixture.layout!.blocks.push({ block_id: 'p1-stamp', page_number: 1,
      source_rect: [20, 220, 46, 575], kind: 'original', block_type: 'others',
      text: 'arXiv:2606.05121v2 [cs.SD] 21 Aug 2026', figure_label: null });
    render(<PdfReader {...props} />);
    await waitFor(() => expect(readingBlock('p1-stamp')).toBeTruthy());
    expect(parseFloat(readingBlock('p1-stamp').style.height)).toBeLessThanOrEqual(760);
    expect(parseFloat(readingBlock('p1-stamp').style.width)).toBeLessThan(100);
  });
  it('splits all Content blocks, restores them together, and keeps individual overrides', async () => {
    const props = readingProps();
    split_fixture.initial_ids.add('p2-body');
    render(<PdfReader {...props} />);
    const split_all = await screen.findByRole('button', { name: 'Split lines in all Content blocks' });
    await waitFor(() => expect((split_all as HTMLButtonElement).disabled).toBe(false));
    expect(split_all.textContent).toBe('');
    expect(split_all.getAttribute('aria-pressed')).toBe('false');
    expect(split_all.closest('.pdf-toolbar')).toBeTruthy();
    fireEvent.click(split_all);
    const content = reading_fixture.layout!.blocks.filter((block) => block.block_type === 'content');
    expect(split_fixture.change_all).toHaveBeenCalledExactlyOnceWith(content, true);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore original lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getAllByRole('button', { name: /Restore original lines in block/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Restore original lines in block on page 2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Split lines in all Content blocks' }).getAttribute('aria-pressed')).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'Split lines in all Content blocks' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore original lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Restore original lines in all Content blocks' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Split lines in block/ })).toHaveLength(2));
    expect(split_fixture.change_all).toHaveBeenLastCalledWith(content, false);
    expect(readingBlock('p2-figure').querySelector('.textLayer > .textLayer')).toBeNull();
  });

  it('waits for the batch save and retains mixed block choices when it fails', async () => {
    const props = readingProps();
    split_fixture.initial_ids.add('p2-body');
    let finish_save!: (accepted: boolean) => void;
    split_fixture.change_all.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish_save = resolve; }));
    render(<PdfReader {...props} />);
    const button = await screen.findByRole('button', { name: 'Split lines in all Content blocks' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    const original_height = readingBlock('p1-body').style.height;
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('.pdf-spinner')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Split lines in block on page 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect(readingBlock('p1-body').style.height).toBe(original_height);
    await act(async () => finish_save(false));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Restore original lines in block on page 2' })).toBeTruthy();
    expect(readingBlock('p1-body').style.height).toBe(original_height);
  });

  it('preserves the visible source point when several blocks split or restore together', async () => {
    const props = splitReadingProps();
    // Include a block before the visible passage so its height changes too.
    reading_fixture.layout!.blocks[0].block_type = 'content';
    render(<PdfReader {...props} />);
    await waitFor(() => expectSplitSource(latestLocation(props)));
    fireEvent.click(screen.getByRole('button', { name: 'Split lines in all Content blocks' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore original lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => {
      expect(readingBlock('p1-body').querySelector('.textLayer > .textLayer')).toBeTruthy();
      expect(readingBlock('p1-body').dataset.splitPreparing).toBeUndefined();
      expect(readingBlock('p1-intro').querySelector('.textLayer > .textLayer')).toBeTruthy();
    });
    await waitFor(() => expectSplitSource(latestLocation(props)));
    fireEvent.click(screen.getByRole('button', { name: 'Restore original lines in all Content blocks' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Split lines in block on page 1' })).toHaveLength(2));
    await waitFor(() => expect(readingBlock('p1-body').querySelector('.textLayer > .textLayer')).toBeNull());
    await waitFor(() => expectSplitSource(latestLocation(props)));
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('can restore all lines while a lazy split preparation is still pending', async () => {
    const props = splitReadingProps();
    let finish_prepare!: () => void;
    split_fixture.prepare.mockImplementationOnce((page: PDFPageProxy, rect: PdfSourceRect) => new Promise<PreparedSplitText>((resolve) => {
      finish_prepare = () => resolve(preparedSplit(page, rect));
    }));
    render(<PdfReader {...props} />);
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const original_height = readingBlock('p1-body').style.height;
    fireEvent.click(screen.getByRole('button', { name: 'Split lines in all Content blocks' }));
    await waitFor(() => expect(readingBlock('p1-body').dataset.splitPreparing).toBe('true'));
    const restore = screen.getByRole('button', { name: 'Restore original lines in all Content blocks' });
    expect((restore as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(readingBlock('p1-body').dataset.splitPreparing).toBeUndefined());
    await act(async () => finish_prepare());
    expect(readingBlock('p1-body').style.height).toBe(original_height);
    expect(readingBlock('p1-body').querySelector('.textLayer > .textLayer')).toBeNull();
    await waitFor(() => expectSplitSource(latestLocation(props)));
  });

  it('disables the all-lines icon without Content blocks and hides it in original PDF mode', async () => {
    const props = readingProps();
    reading_fixture.layout!.blocks = reading_fixture.layout!.blocks.filter((block) => block.block_type !== 'content');
    const view = render(<PdfReader {...props} />);
    expect((screen.getByRole('button', { name: 'Split lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<PdfReader {...props} navigation_key={props.navigation_key + 1} target_location={{ ...props.target_location!, reader_mode: 'pdf' }} />);
    await screen.findByLabelText('Scrollable PDF pages');
    expect(screen.queryByRole('button', { name: 'Split lines in all Content blocks' })).toBeNull();
  });

  it('offers an icon only for Content blocks and waits for preferences to load', async () => {
    const props = readingProps('p1-intro');
    const types = ['content', 'equation', 'graph', 'table', 'reference', 'title', 'others'] as const;
    reading_fixture.layout!.blocks = types.map((block_type, index) => ({
      ...reading_fixture.layout!.blocks[0], block_id: index ? `p1-${block_type}` : 'p1-intro', block_type,
    }));
    split_fixture.loading = true;
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(readingBlock('p1-intro')).toBeTruthy());
    const buttons = screen.getAllByRole('button', { name: 'Split lines in block on page 1' });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('');
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Split lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[0].closest('article')?.querySelector('.reading-block-type')?.textContent).toBe('Content');
    split_fixture.loading = false;
    split_fixture.load_failed = true;
    split_fixture.error = 'Preferences could not be loaded';
    view.rerender(<PdfReader {...props} />);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Split lines in all Content blocks' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(split_fixture.retry).toHaveBeenCalledOnce();
    split_fixture.load_failed = false;
    split_fixture.error = null;
    view.rerender(<PdfReader {...props} />);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect(split_fixture.prepare).not.toHaveBeenCalled();
  });

  it('changes the icon and rendered layout only after the preference save/reset succeeds', async () => {
    const props = readingProps();
    let finish_save!: (accepted: boolean) => void;
    split_fixture.change.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish_save = resolve; }));
    render(<PdfReader {...props} />);
    const button = await screen.findByRole('button', { name: 'Split lines in block on page 1' });
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    const original_height = readingBlock('p1-body').style.height;
    fireEvent.click(button);
    expect(split_fixture.change).toHaveBeenCalledWith(reading_fixture.layout!.blocks[2], true);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(split_fixture.prepare).not.toHaveBeenCalled();
    expect(readingBlock('p1-body').style.height).toBe(original_height);
    await act(async () => finish_save(false));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await expectSplitReady();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(parseFloat(readingBlock('p1-body').style.height)).toBeGreaterThan(parseFloat(original_height));
    split_fixture.change.mockResolvedValueOnce(false);
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
    expect(split_fixture.change).toHaveBeenLastCalledWith(reading_fixture.layout!.blocks[2], false);
    expect(readingBlock('p1-body').style.height).toBe(original_height);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('preserves the visible source passage while preparing, splitting, and restoring original lines', async () => {
    const props = splitReadingProps();
    let finish_prepare!: () => void;
    split_fixture.prepare.mockImplementationOnce((page: PDFPageProxy, rect: PdfSourceRect) => new Promise<PreparedSplitText>((resolve) => {
      finish_prepare = () => resolve(preparedSplit(page, rect));
    }));
    render(<PdfReader {...props} />);
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const button = screen.getByRole('button', { name: 'Split lines in block on page 1' });
    const original_height = readingBlock('p1-body').style.height;
    fireEvent.click(button);
    await waitFor(() => expect(split_fixture.prepare).toHaveBeenCalledOnce());
    expect(readingBlock('p1-body').style.height).toBe(original_height);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish_prepare());
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    // The source point (460, 570) is in the second half of the third source
    // line. Its split display point is (20, 110), not a linear crop fraction.
    const split_bounds = readingBlock('p1-body').getBoundingClientRect();
    expect(split_bounds.left + 20 * 8.4).toBeCloseTo(20);
    expect(split_bounds.top + 110 * 8.4).toBeCloseTo(20);
    fireEvent.click(button);
    await waitFor(() => expect(readingBlock('p1-body').style.height).toBe(original_height));
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const original_bounds = readingBlock('p1-body').getBoundingClientRect();
    expect(original_bounds.left + 140 * 4.2).toBeCloseTo(20);
    expect(original_bounds.top + 50 * 4.2).toBeCloseTo(20);
  });

  it('retains a pending saved destination when another block split preference fails', async () => {
    const props = splitReadingProps();
    split_fixture.initial_ids.add('p1-body');
    let finish_prepare!: () => void;
    split_fixture.prepare.mockImplementationOnce((page: PDFPageProxy, rect: PdfSourceRect) => new Promise<PreparedSplitText>((resolve) => {
      finish_prepare = () => resolve(preparedSplit(page, rect));
    }));
    split_fixture.change.mockResolvedValueOnce(false);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(split_fixture.prepare).toHaveBeenCalledOnce());
    expect(readingBlock('p1-body').dataset.splitPreparing).toBe('true');
    expect(props.on_location_change).not.toHaveBeenCalled();

    // The saved second-half source point is still waiting for its mapping.
    // A failed operation on another block must not discard that destination.
    const other_block_button = screen.getByRole('button', { name: 'Split lines in block on page 2' });
    fireEvent.click(other_block_button);
    await waitFor(() => expect(split_fixture.change).toHaveBeenCalledWith(reading_fixture.layout!.blocks[3], true));
    await waitFor(() => expect((other_block_button as HTMLButtonElement).disabled).toBe(false));
    expect(other_block_button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => finish_prepare());
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const bounds = readingBlock('p1-body').getBoundingClientRect();
    expect(bounds.left + 20 * 8.4).toBeCloseTo(20);
    expect(bounds.top + 110 * 8.4).toBeCloseTo(20);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps an upward scroll made while split lines is preparing', async () => {
    const props = splitReadingProps();
    let finish_prepare!: () => void;
    split_fixture.prepare.mockImplementationOnce((page: PDFPageProxy, rect: PdfSourceRect) => new Promise<PreparedSplitText>((resolve) => {
      finish_prepare = () => resolve(preparedSplit(page, rect));
    }));
    render(<PdfReader {...props} />);
    await waitFor(() => expectSplitSource(latestLocation(props)));
    fireEvent.click(screen.getByRole('button', { name: 'Split lines in block on page 1' }));
    await waitFor(() => expect(split_fixture.prepare).toHaveBeenCalledOnce());
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: scroll.scrollTop - 100 }));
    fireEvent.scroll(scroll);
    await act(async () => finish_prepare());
    await expectSplitReady();
    await waitFor(() => expect(latestLocation(props).page_position[1]).toBeCloseTo((230 - 100 / 4.2) / 800));
    expect(latestLocation(props).page_position[0]).toBeCloseTo(460 / 600);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps scrolling upward while a split bitmap and its mapping are still rendering', async () => {
    const props = splitReadingProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expectSplitSource(latestLocation(props)));
    pdf_fixture.defer_renders = true;
    fireEvent.click(screen.getByRole('button', { name: 'Split lines in block on page 1' }));
    await waitFor(() => {
      expect(readingBlock('p1-body').style.height).toBe('2016px');
      expect(readingBlock('p1-body').dataset.splitPreparing).toBe('true');
      expect(pdf_fixture.render_requests.some((request) => !request.cancelled && request.viewport.scale === 8.4)).toBe(true);
    });
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: scroll.scrollTop - 100 }));
    fireEvent.scroll(scroll);
    const scrolled_top = scroll.scrollTop;
    await act(async () => pdf_fixture.render_requests.forEach((request) => request.complete()));
    await expectSplitReady();
    await waitFor(() => expect(scroll.scrollTop).toBeCloseTo(scrolled_top));
    expect(latestLocation(props).reading_block_id).toBe('p1-body');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('retains an explicit saved destination during scrolling while its split is preparing', async () => {
    const props = splitReadingProps();
    split_fixture.initial_ids.add('p1-body');
    let finish_prepare!: () => void;
    split_fixture.prepare.mockImplementationOnce((page: PDFPageProxy, rect: PdfSourceRect) => new Promise<PreparedSplitText>((resolve) => {
      finish_prepare = () => resolve(preparedSplit(page, rect));
    }));
    render(<PdfReader {...props} />);
    await waitFor(() => expect(split_fixture.prepare).toHaveBeenCalledOnce());
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: scroll.scrollTop - 100 }));
    fireEvent.scroll(scroll);
    await act(async () => finish_prepare());
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('retains a zoom control source anchor while a split bitmap rerenders', async () => {
    const props = splitReadingProps();
    split_fixture.initial_ids.add('p1-body');
    render(<PdfReader {...props} />);
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    pdf_fixture.defer_renders = true;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(readingBlock('p1-body').dataset.splitPreparing).toBe('true'));
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: scroll.scrollTop - 100 }));
    fireEvent.scroll(scroll);
    await act(async () => pdf_fixture.render_requests.forEach((request) => request.complete()));
    await expectSplitReady();
    await waitFor(() => {
      expectSplitSource(latestLocation(props));
      expect(latestLocation(props).zoom).toBe(2.85);
    });
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it.each([false, true])('restores the same split source passage after opening its PDF source and going Back (initially offscreen: %s)', async (initially_offscreen) => {
    const props = splitReadingProps();
    split_fixture.initial_ids.add('p1-body');
    const observers = new Map<HTMLElement, () => void>();
    if (initially_offscreen) vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: HTMLElement) {
        const notify = (isIntersecting: boolean) => {
          const bounds = target.getBoundingClientRect();
          this.callback([{
            target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
            boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null, time: 0,
          }], this as unknown as IntersectionObserver);
        };
        observers.set(target, () => notify(true));
        notify(target.dataset.blockId !== 'p1-body');
      }
      disconnect() {}
    });
    const reveal = async () => {
      if (!initially_offscreen) return;
      await waitFor(() => {
        const page = readingBlock('p1-body');
        expect(page).toBeTruthy();
        expect(page.getBoundingClientRect().top).toBeLessThan(viewport_height);
        expect(page.getBoundingClientRect().bottom).toBeGreaterThan(0);
        expect(observers.has(page)).toBe(true);
      });
      // Native IntersectionObserver runs after the approximate scroll reveals
      // the crop; preparation then supplies the exact source-point mapping.
      act(() => observers.get(readingBlock('p1-body'))!());
    };
    const view = render(<PdfReader {...props} />);
    await reveal();
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const reading_location = latestLocation(props);
    const source_button = readingBlock('p1-body').closest('article')!.querySelector<HTMLElement>('button[title="View in PDF"]')!;
    fireEvent.click(source_button);
    const navigation = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    if (navigation.kind !== 'pdf') throw new Error('Expected a PDF source destination');
    expect(navigation.location).toMatchObject({ reader_mode: 'pdf', page_number: 1, reading_block_id: null });
    view.rerender(<PdfReader {...props} target_location={navigation.location} navigation_key={2} />);
    await waitFor(() => expect(latestLocation(props).reader_mode).toBe('pdf'));
    view.rerender(<PdfReader {...props} target_location={reading_location} navigation_key={3} />);
    await reveal();
    await expectSplitReady();
    await waitFor(() => expectSplitSource(latestLocation(props)));
    const bounds = readingBlock('p1-body').getBoundingClientRect();
    expect(bounds.left + 20 * 8.4).toBeCloseTo(20);
    expect(bounds.top + 110 * 8.4).toBeCloseTo(20);
    expect(props.on_error).not.toHaveBeenCalled();
  });
});

describe('left-edge reader navigation', () => {
  const touch = (x: number, y = 240) => ({ identifier: 1, clientX: x, clientY: y });
  const feedback = () => document.querySelector<HTMLDivElement>('.pdf-edge-feedback')!;

  it.each(['pdf', 'reading'] as const)('previews Back without PDF work and navigates only on release in %s mode', async (mode) => {
    vi.useFakeTimers();
    const props = { ...(mode === 'reading' ? readingProps('p1-intro') : readerProps()), edge_navigation: 'back' as const, on_edge_navigation: vi.fn() };
    render(<PdfReader {...props} />);
    await advancePreviewFrame(40);
    await advancePreviewFrame(40);
    const scroll = screen.getByLabelText(mode === 'reading' ? 'Scrollable reading view' : 'Scrollable PDF pages');
    const baseline = heavyWork(props);
    dispatchTouch(scroll, 'touchstart', [touch(5)]);
    for (const x of [24, 50, 90, 150]) {
      expect(dispatchTouch(scroll, 'touchmove', [touch(x)]).defaultPrevented).toBe(true);
      await advancePreviewFrame();
    }
    expect(feedback().hidden).toBe(false);
    expect(feedback().textContent).toBe('Back');
    expect(feedback().dataset.ready).toBe('true');
    expect(feedback().closest('.pdf-pages')).toBeNull();
    expect(heavyWork(props)).toEqual(baseline);
    expect(props.on_edge_navigation).not.toHaveBeenCalled();
    dispatchTouch(scroll, 'touchend', [], [touch(150)]);
    expect(props.on_edge_navigation).toHaveBeenCalledExactlyOnceWith();
    expect(feedback().hidden).toBe(true);
    expect(props.on_location_change).toHaveBeenCalledTimes(baseline.location_reports + 1);
    expect(vi.mocked(props.on_location_change).mock.invocationCallOrder.at(-1)).toBeLessThan(props.on_edge_navigation.mock.invocationCallOrder[0]);
    await advancePreviewFrame(250);
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
    expect(heavyWork(props)).toEqual({ ...baseline, location_reports: baseline.location_reports + 1 });
  });

  it('cancels a short Close swipe without turning it into a reader tap', async () => {
    vi.useFakeTimers();
    const props = { ...readerProps(), edge_navigation: 'close' as const, on_edge_navigation: vi.fn() };
    render(<PdfReader {...props} />);
    await advancePreviewFrame(40);
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    fireEvent.pointerDown(scroll, { clientX: 5, clientY: 240 });
    dispatchTouch(scroll, 'touchstart', [touch(5)]);
    dispatchTouch(scroll, 'touchmove', [touch(30)]);
    await advancePreviewFrame();
    expect(feedback().textContent).toBe('Close');
    expect(feedback().dataset.ready).toBe('false');
    fireEvent.pointerUp(scroll, { clientX: 30, clientY: 240 });
    dispatchTouch(scroll, 'touchend', [], [touch(30)]);
    await advancePreviewFrame(250);
    expect(feedback().hidden).toBe(true);
    expect(props.on_edge_navigation).not.toHaveBeenCalled();
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
  });

  it.each(['deactivated', 'navigation', 'action', 'viewport'] as const)('cancels an in-flight swipe when the reader changes: %s', async (change) => {
    vi.useFakeTimers();
    const props: PdfReaderProps = { ...readerProps(), edge_navigation: 'back', on_edge_navigation: vi.fn() };
    const view = render(<PdfReader {...props} />);
    await advancePreviewFrame(40);
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    dispatchTouch(scroll, 'touchstart', [touch(5)]);
    dispatchTouch(scroll, 'touchmove', [touch(150)]);
    await advancePreviewFrame();
    expect(feedback().hidden).toBe(false);
    const changed = change === 'deactivated' ? { reading_active: false }
      : change === 'navigation' ? { navigation_key: props.navigation_key + 1 }
      : change === 'action' ? { edge_navigation: 'close' as const } : { viewport_key: 1 };
    view.rerender(<PdfReader {...props} {...changed} />);
    expect(feedback().hidden).toBe(true);
    dispatchTouch(scroll, 'touchend', [], [touch(150)]);
    expect(props.on_edge_navigation).not.toHaveBeenCalled();
  });

  it('leaves selection, focused editing, and ordinary interactive controls alone', async () => {
    vi.useFakeTimers();
    const props = { ...readerProps(), edge_navigation: 'back' as const, on_edge_navigation: vi.fn() };
    render(<PdfReader {...props} />);
    await advancePreviewFrame(40);
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const swipe = (target: HTMLElement) => {
      dispatchTouch(target, 'touchstart', [touch(5)]);
      expect(dispatchTouch(target, 'touchmove', [touch(150)]).defaultPrevented).toBe(false);
      dispatchTouch(target, 'touchend', [], [touch(150)]);
    };
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, rangeCount: 1 } as Selection);
    swipe(scroll);
    selection.mockRestore();
    const input = screen.getByRole('textbox', { name: 'Page number' });
    input.focus();
    swipe(scroll);
    input.blur();
    swipe(screen.getByRole('button', { name: 'Zoom in' }));
    expect(props.on_edge_navigation).not.toHaveBeenCalled();
    expect(feedback().hidden).toBe(true);
  });

  it('yields to a two-finger pinch after an edge swipe starts', async () => {
    vi.useFakeTimers();
    const props = { ...readerProps(), edge_navigation: 'back' as const, on_edge_navigation: vi.fn() };
    render(<PdfReader {...props} />);
    await advancePreviewFrame(40);
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    dispatchTouch(scroll, 'touchstart', [touch(5)]);
    dispatchTouch(scroll, 'touchmove', [touch(25)]);
    await advancePreviewFrame();
    const second = { identifier: 2, clientX: 120, clientY: 240 };
    dispatchTouch(scroll, 'touchstart', [touch(25), second]);
    expect(feedback().hidden).toBe(true);
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(true);
    dispatchTouch(scroll, 'touchmove', [touch(10), { ...second, clientX: 160 }]);
    await advancePreviewFrame();
    dispatchTouch(scroll, 'touchend', [], [touch(10), second]);
    await advancePreviewFrame();
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(props.on_edge_navigation).not.toHaveBeenCalled();
  });

  it('disables the edge gesture while an enlarged figure is open', async () => {
    vi.useFakeTimers();
    const show_modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    const props = { ...readingProps('p1-intro'), edge_navigation: 'back' as const, on_edge_navigation: vi.fn() };
    try {
      render(<PdfReader {...props} />);
      await advancePreviewFrame(40);
      fireEvent.click(screen.getByRole('button', { name: 'Enlarge Figure Figure 1' }));
      const scroll = screen.getByLabelText('Scrollable reading view');
      dispatchTouch(scroll, 'touchstart', [touch(5)]);
      expect(dispatchTouch(scroll, 'touchmove', [touch(150)]).defaultPrevented).toBe(false);
      dispatchTouch(scroll, 'touchend', [], [touch(150)]);
      expect(props.on_edge_navigation).not.toHaveBeenCalled();
      expect(feedback().hidden).toBe(true);
    } finally {
      if (show_modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show_modal);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  });
});

function croppedPdfPointAt(block_id: string, client_x: number, client_y: number): [number, number] {
  const bounds = readingBlock(block_id).getBoundingClientRect();
  const [left, bottom, right, top] = reading_fixture.layout!.blocks.find((block) => block.block_id === block_id)!.source_rect;
  return [left + (client_x - bounds.left) / bounds.width * (right - left), top - (client_y - bounds.top) / bounds.height * (top - bottom)];
}

function readingNote(block_id: string, content = 'Saved passage note', annotation_id = 'saved-note'): Annotation {
  const block = reading_fixture.layout!.blocks.find((item) => item.block_id === block_id)!;
  const [left, , , top] = block.source_rect;
  return {
    annotation_id, schema_version: 1,
    target: { paper_id: '1706.03762v7', pdf_hash: 'a'.repeat(64), page_anchors: [{
      page_number: block.page_number, quad_points: [[left + 1, top - 1, left + 20, top - 1, left + 20, top - 10, left + 1, top - 10]],
      text_quote: { exact_text: 'Selected text', prefix: '', suffix: '', normalization_version: 1 },
    }] },
    body: { kind: 'note', content }, created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z',
  };
}

describe('inline Reading notes', () => {
  it('preserves the caret when inserting into the middle of a controlled note draft', async () => {
    const props = readingProps('p1-intro');
    const annotation = readingNote('p1-intro', 'abcd');
    props.annotations = [annotation];
    function ControlledReader() {
      const [edit, setEdit] = useState<PdfReaderProps['annotation_edit']>({ annotation_id: annotation.annotation_id, content: 'abcd' });
      return <PdfReader {...props} inline_notes annotation_edit={edit}
        on_edit_annotation={(annotation, content) => setEdit(content === null ? null : { annotation_id: annotation.annotation_id, content })} />;
    }
    render(<ControlledReader />);
    const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Edit note' });
    editor.focus();
    editor.setSelectionRange(2, 2);
    fireEvent.change(editor, { target: { value: 'abXcd', selectionStart: 3, selectionEnd: 3 } });
    expect(editor.value).toBe('abXcd');
    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(3);
  });

  it('preserves the passage when controlled editing opens or closes and freezes draft changes during pinch', async () => {
    // The reader reports its restored position on a frame after mount. Control
    // that frame too, rather than racing a wall-clock wait in a parallel suite.
    vi.useFakeTimers();
    const props = readingProps();
    const annotation = readingNote('p1-intro', 'abcd');
    props.annotations = [annotation];
    props.on_edit_annotation = vi.fn();
    const view = render(<PdfReader {...props} inline_notes annotation_edit={null} />);
    for (let frame = 0; frame < 3 && !vi.mocked(props.on_location_change).mock.calls.length; frame++) await advancePreviewFrame();
    expect(props.on_location_change).toHaveBeenCalledWith(expect.objectContaining({ reading_block_id: 'p1-body' }));
    const point = croppedPdfPointAt('p1-body', 100, 100);
    const edit = { annotation_id: annotation.annotation_id, content: 'abcd' };
    view.rerender(<PdfReader {...props} inline_notes annotation_edit={edit} />);
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit note' });
    expect(croppedPdfPointAt('p1-body', 100, 100)[1]).toBeCloseTo(point[1]);
    const scroll = screen.getByLabelText('Scrollable reading view');
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    dispatchSafariGesture(scroll, 'gesturechange', 1.4);
    await advancePreviewFrame();
    view.rerender(<PdfReader {...props} inline_notes annotation_edit={{ ...edit, content: 'Changed elsewhere' }} />);
    await advancePreviewFrame();
    expect(editor.value).toBe('abcd');
    dispatchSafariGesture(scroll, 'gestureend', 1.4);
    await advancePreviewFrame();
    expect(editor.value).toBe('Changed elsewhere');
    const after_pinch = croppedPdfPointAt('p1-body', 100, 100);
    view.rerender(<PdfReader {...props} inline_notes annotation_edit={null} />);
    await advancePreviewFrame();
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
    expect(croppedPdfPointAt('p1-body', 100, 100)[1]).toBeCloseTo(after_pinch[1]);
  });

  it('shows expandable notes only when enabled and sends the clicked passage anchor', async () => {
    const props = readingProps();
    const annotation = readingNote('p1-body');
    const intro = readingNote('p1-intro');
    annotation.target.page_anchors.unshift(intro.target.page_anchors[0]);
    props.annotations = [annotation];
    props.on_navigate_annotation = vi.fn();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    expect(document.querySelector('.note-strip')).toBeNull();
    view.rerender(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(document.querySelectorAll('.note-strip')).toHaveLength(2));
    const article = readingBlock('p1-body').closest('.reading-block')!;
    const toggle = article.querySelector<HTMLButtonElement>('.note-card-heading')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.pointerDown(toggle, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(toggle, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
    fireEvent.click(article.querySelector('.note-card-actions button')!);
    expect(props.on_navigate_annotation).toHaveBeenCalledWith(annotation, annotation.target.page_anchors[1]);
    view.rerender(<PdfReader {...props} inline_notes={false} />);
    await waitFor(() => expect(document.querySelector('.note-strip')).toBeNull());
  });

  it('preserves the visible passage when notes above it are added, expanded, edited, collapsed, or deleted', async () => {
    const props = readingProps();
    const annotation = readingNote('p1-intro');
    const view = render(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    const point = croppedPdfPointAt('p1-body', 100, 100);
    const expectStable = () => {
      const actual = croppedPdfPointAt('p1-body', 100, 100);
      expect(actual[0]).toBeCloseTo(point[0]);
      expect(actual[1]).toBeCloseTo(point[1]);
    };
    view.rerender(<PdfReader {...props} inline_notes annotations={[annotation]} />);
    await waitFor(() => expect(document.querySelector('.note-strip')).toBeTruthy());
    expectStable();
    fireEvent.click(screen.getByRole('button', { name: 'Expand note: Saved passage note' }));
    expectStable();
    const edited = { ...annotation, body: { kind: 'note' as const, content: 'A much longer edited note. '.repeat(50) } };
    view.rerender(<PdfReader {...props} inline_notes annotations={[edited]} />);
    await waitFor(() => expect(document.querySelector('.note-card-body')?.textContent).toBe(edited.body.content));
    expectStable();
    fireEvent.click(document.querySelector('.note-card-heading')!);
    expectStable();
    view.rerender(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(document.querySelector('.note-strip')).toBeNull());
    expectStable();
  });

  it('preserves a visible note instead of jumping into the next PDF crop when a long note changes height', async () => {
    const props = readingProps('p1-intro');
    props.annotations = [readingNote('p1-intro', 'Long note. '.repeat(100))];
    render(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-intro'));
    const card = document.querySelector<HTMLElement>('.note-card')!;
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: scroll.scrollTop + card.getBoundingClientRect().top - 30 }));
    const initial_top = card.getBoundingClientRect().top;
    fireEvent.click(card.querySelector('.note-card-heading')!);
    expect(card.getBoundingClientRect().top).toBeCloseTo(initial_top);
    expect(readingBlock('p1-intro').getBoundingClientRect().bottom).toBeLessThan(30);
    fireEvent.click(card.querySelector('.note-card-heading')!);
    expect(card.getBoundingClientRect().top).toBeCloseTo(initial_top);
  });

  it.each(['finish', 'cancel'] as const)('defers changed note geometry until a pinch %s', async (ending) => {
    const props = readingProps();
    const annotation = readingNote('p1-intro');
    const view = render(<PdfReader {...props} inline_notes annotations={[annotation]} />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    const scroll = screen.getByLabelText('Scrollable reading view');
    const baseline = heavyWork(props);
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    dispatchSafariGesture(scroll, 'gesturechange', 1.4);
    await advancePreviewFrame();
    const anchor = croppedPdfPointAt('p1-body', 180, 180);
    const changed = { ...annotation, body: { kind: 'note' as const, content: 'Changed during pinch' } };
    view.rerender(<PdfReader {...props} inline_notes annotations={[changed, readingNote('p1-body', 'A second note', 'second')]} />);
    await advancePreviewFrame();
    expect(document.querySelectorAll('.note-card')).toHaveLength(1);
    expect(document.querySelector('.note-card-preview')?.textContent).toBe('Saved passage note');
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(true);
    expect(heavyWork(props)).toEqual(baseline);
    const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
    dispatchSafariGesture(scroll, 'gesturechange', 1.4);
    await advancePreviewFrame();
    expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length).toBe(reads);
    if (ending === 'finish') dispatchSafariGesture(scroll, 'gestureend', 1.4);
    else view.rerender(<PdfReader {...props} inline_notes annotations={[changed, readingNote('p1-body', 'A second note', 'second')]} reading_active={false} />);
    await advancePreviewFrame();
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(document.querySelectorAll('.note-card')).toHaveLength(2);
    expect(document.querySelector('.note-card-preview')?.textContent).toBe('Changed during pinch');
    if (ending === 'finish') {
      const actual = croppedPdfPointAt('p1-body', 180, 180);
      expect(actual[0]).toBeCloseTo(anchor[0]);
      expect(actual[1]).toBeCloseTo(anchor[1]);
    }
  });

  it('reveals the nearest passage when deleting the only note visible in the viewport', async () => {
    const props = readingProps('p1-intro');
    const annotation = readingNote('p1-intro', 'Long note. '.repeat(200));
    const view = render(<PdfReader {...props} inline_notes annotations={[annotation]} />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-intro'));
    const card = document.querySelector<HTMLElement>('.note-card')!;
    fireEvent.click(card.querySelector('.note-card-heading')!);
    const scroll = screen.getByLabelText('Scrollable reading view');
    act(() => scroll.scrollTo({ top: card.getBoundingClientRect().top + scroll.scrollTop + 50 }));
    expect(readingBlock('p1-intro').getBoundingClientRect().bottom).toBeLessThan(0);
    expect(readingBlock('p2-figure').getBoundingClientRect().top).toBeGreaterThan(viewport_height);
    view.rerender(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(document.querySelector('.note-card')).toBeNull());
    expect(readingBlock('p2-figure').getBoundingClientRect().top).toBeCloseTo(20);
  });

  it('keeps notes visible during pinch when their source crop bitmap is unmounted', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: HTMLElement) {
        const isIntersecting = target.dataset.blockId !== 'p3-original';
        const bounds = target.getBoundingClientRect();
        this.callback([{
          target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
          boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null, time: 0,
        }], this as unknown as IntersectionObserver);
      }
      disconnect() {}
    });
    const style = document.createElement('style');
    style.textContent = reader_styles;
    document.head.append(style);
    try {
      const props = readingProps();
      props.annotations = [readingNote('p3-original')];
      const view = render(<PdfReader {...props} inline_notes />);
      await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
      const page = readingBlock('p3-original');
      const article = page.closest<HTMLElement>('.reading-block')!;
      const notes = article.querySelector<HTMLElement>('.note-strip')!;
      expect(page.querySelector('canvas')).toBeNull();
      vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({
        x: 10, y: -900, left: 10, top: -900, right: 350, bottom: 200,
        width: 340, height: 1100, toJSON: () => ({}),
      });
      const scroll = screen.getByLabelText('Scrollable reading view');
      const baseline = heavyWork(props);
      vi.useFakeTimers();
      dispatchSafariGesture(scroll, 'gesturestart', 1);
      dispatchSafariGesture(scroll, 'gesturechange', 0.7);
      await advancePreviewFrame();
      expect(article.hasAttribute('data-zoom-preview-page')).toBe(true);
      expect(previewTransform(article).scale).toBeCloseTo(0.7);
      expect(getComputedStyle(notes).visibility).toBe('visible');
      expect(page.querySelector('canvas')).toBeNull();
      expect(heavyWork(props)).toEqual(baseline);
      view.rerender(<PdfReader {...props} inline_notes reading_active={false} />);
      await advancePreviewFrame();
      expect(article.hasAttribute('data-zoom-preview-page')).toBe(false);
      expect(getComputedStyle(notes).visibility).toBe('visible');
    } finally {
      style.remove();
    }
  });

  it('does not interpret selected note text as a PDF selection', async () => {
    const props = readingProps('p1-intro');
    props.annotations = [readingNote('p1-intro')];
    render(<PdfReader {...props} inline_notes />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-intro'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand note: Saved passage note' }));
    const text = document.querySelector('.note-card-body')!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(document.querySelector('.note-card-body')!);
    expect(props.on_selection).toHaveBeenLastCalledWith(null);
    window.getSelection()!.removeAllRanges();
  });
});

describe('optional Reading view', () => {
  it('shows every semantic type outside selectable crops while controls are hidden', async () => {
    const props = readingProps('p1-intro');
    const labels = ['Content', 'Equation', 'Graph', 'Table', 'Reference', 'Title', 'Others'] as const;
    reading_fixture.layout!.blocks = labels.map((label, index) => ({
      ...reading_fixture.layout!.blocks[0],
      block_id: index ? `p1-${label.toLowerCase()}` : 'p1-intro',
      block_type: label.toLowerCase() as ReadingLayout['blocks'][number]['block_type'],
    }));
    const styles = document.createElement('style');
    styles.textContent = reader_styles;
    document.head.append(styles);
    try {
      render(<PdfReader {...props} controls_visible={false} />);
      await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-intro'));
      const block_labels = [...document.querySelectorAll<HTMLElement>('.reading-block-type')];
      expect(block_labels.map((label) => label.textContent)).toEqual(labels);
      for (const label of block_labels) {
        const style = getComputedStyle(label);
        expect(label.closest('.pdf-page')).toBeNull();
        expect(label.closest('.reading-block-actions')).toBeNull();
        expect(label.parentElement?.classList.contains('reading-block')).toBe(true);
        expect(style.display).not.toBe('none');
        expect(style.visibility).toBe('visible');
        expect(style.userSelect).toBe('none');
        expect(style.width).toBe('0px');
        expect(style.minWidth).toBe('100%');
        expect(style.maxWidth).toBe('100%');
      }
      expect(document.querySelector('.reading-pages-controls')).toBeNull();
      expect(getComputedStyle(document.querySelector('.reading-block-actions')!).opacity).toBe('0');
      expect(props.on_error).not.toHaveBeenCalled();
    } finally {
      styles.remove();
    }
  });

  it.each([0, 90, 180, 270].flatMap((rotation) => (['fit_width', 'custom'] as const).map((zoom_mode) => ({ rotation, zoom_mode }))))(
    'keeps Reading mode and $zoom_mode zoom for a rotated $rotation° PDF destination', async ({ rotation, zoom_mode }) => {
      pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'body', rect: [100, 600, 125, 612], dest: [0, { name: 'XYZ' }, 400, 500, 2.8] }]);
      const props = readingProps('p1-intro');
      // Keep the same interior source point (180, 640) when rotating the saved
      // viewport; a crop's last edge can scroll onto the following article.
      const initial_positions: Record<number, [number, number]> = {
        0: [180 / 600, 160 / 800], 90: [640 / 800, 180 / 600],
        180: [420 / 600, 640 / 800], 270: [160 / 800, 420 / 600],
      };
      props.target_location = { ...props.target_location!, rotation, page_position: initial_positions[rotation], zoom_mode, zoom: zoom_mode === 'custom' ? 1.25 : 1 };
      const view = render(<PdfReader {...props} />);
      await waitFor(() => expect(latestLocation(props).reader_mode).toBe('reading'));
      const source = latestLocation(props);
      fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
      const destination = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
      if (destination.kind !== 'pdf') throw new Error('Expected a PDF destination');
      const positions: Record<number, [number, number]> = {
        0: [400 / 600, 300 / 800], 90: [500 / 800, 400 / 600],
        180: [200 / 600, 500 / 800], 270: [300 / 800, 200 / 600],
      };
      expect(destination.location).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', page_number: 1, zoom: source.zoom, zoom_mode, rotation });
      expect(destination.location.page_position).toEqual(positions[rotation]);
      view.rerender(<PdfReader {...props} target_location={destination.location} navigation_key={2} />);
      await waitFor(() => expect(latestLocation(props)).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', rotation, zoom: source.zoom, zoom_mode }));
      expect(latestLocation(props).page_position[1]).toBeCloseTo(positions[rotation][1]);
      view.rerender(<PdfReader {...props} target_location={source} navigation_key={3} />);
      await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-intro'));
      expect(props.on_error).not.toHaveBeenCalled();
    },
  );

  it('maps a named outline destination in removed whitespace to the nearest Reading block', async () => {
    pdf_fixture.outline = [{ title: 'Figure section', dest: 'figure-gap', items: [] }];
    pdf_fixture.destinations.set('figure-gap', [1, { name: 'XYZ' }, 500, 360, 2]);
    const props = readingProps('p1-intro');
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).reader_mode).toBe('reading'));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Jump to a document section' }), { target: { value: '0' } });
    await waitFor(() => expect(props.on_navigate).toHaveBeenCalledWith({ kind: 'pdf', location: expect.objectContaining({
      reader_mode: 'reading', reading_block_id: 'p2-figure', page_number: 2, zoom: 1, zoom_mode: 'fit_width',
    }) }));
  });

  it('keeps Reading mode when a PDF action advances a page', async () => {
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'next-page', rect: [100, 600, 125, 612], action: 'NextPage' }]);
    const props = readingProps('p1-intro');
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).reader_mode).toBe('reading'));
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    expect(props.on_navigate).toHaveBeenCalledWith({ kind: 'pdf', location: expect.objectContaining({ reader_mode: 'reading', page_number: 2, zoom: 1, zoom_mode: 'fit_width' }) });
  });

  it('restores a specific crop when a moved figure separates two blocks from the same page', async () => {
    const props = readingProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props)).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', page_number: 1, zoom_mode: 'fit_width' }));
    expect(latestLocation(props).page_position[1]).toBeCloseTo(0.5);
    const blocks = [...screen.getByLabelText('Scrollable reading view').querySelectorAll<HTMLElement>('[data-block-id]')];
    expect(blocks.map((block) => block.dataset.blockId)).toEqual(['p1-intro', 'p2-figure', 'p1-body', 'p2-body', 'p3-original']);
    expect(parseFloat(readingBlock('p1-body').style.width)).toBeCloseTo(336);

    const reports = vi.mocked(props.on_location_change).mock.calls.length;
    resizeViewport(840);
    await waitFor(() => expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(reports));
    expect(latestLocation(props)).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', page_number: 1, zoom: 1 });
    expect(latestLocation(props).page_position[1]).toBeCloseTo(0.5);
    expect(parseFloat(readingBlock('p1-body').style.width)).toBeCloseTo(760);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('opens the figure source in PDF and restores the same reading block through history', async () => {
    const props = readingProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    const reading_location = latestLocation(props);
    fireEvent.click(screen.getByRole('button', { name: 'View Figure 1 in PDF on page 2' }));
    const navigation = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    if (navigation.kind !== 'pdf') throw new Error('Expected an original-PDF destination');
    expect(navigation.location).toMatchObject({ reader_mode: 'pdf', reading_block_id: null, page_number: 2, page_position: [0.1, 0.125], zoom_mode: 'fit_width' });
    view.rerender(<PdfReader {...props} target_location={navigation.location} navigation_key={2} />);
    await waitFor(() => expect(latestLocation(props)).toMatchObject({ reader_mode: 'pdf', page_number: 2 }));
    expect(screen.getByLabelText('Scrollable PDF pages')).toBeTruthy();
    expect(latestLocation(props).page_position[1]).toBeCloseTo(0.125);

    view.rerender(<PdfReader {...props} target_location={reading_location} navigation_key={3} />);
    await waitFor(() => expect(latestLocation(props)).toMatchObject({ reader_mode: 'reading', page_number: 1, reading_block_id: 'p1-body' }));
    expect(latestLocation(props).page_position[1]).toBeCloseTo(reading_location.page_position[1]);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('previews a cropped-block pinch without PDF work and commits its source anchor sharply', async () => {
    const props = readingProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
    const page = readingBlock('p1-body');
    await waitFor(() => expect(page.querySelector<HTMLElement>('.textLayer')!.hidden).toBe(false));
    const scroll = screen.getByLabelText('Scrollable reading view');
    const anchor = croppedPdfPointAt('p1-body', 180, 180);
    const baseline = heavyWork(props);
    const canvas = page.querySelector<HTMLCanvasElement>('canvas')!;
    const original_pixels = canvas.width;
    vi.useFakeTimers();
    dispatchTouch(scroll, 'touchstart', [{ identifier: 1, clientX: 140, clientY: 180 }, { identifier: 2, clientX: 220, clientY: 180 }]);
    for (let index = 1; index <= 20; index += 1) {
      const distance = 80 * (1 + index / 40);
      dispatchTouch(scroll, 'touchmove', [{ identifier: 1, clientX: 180 - distance / 2, clientY: 180 }, { identifier: 2, clientX: 180 + distance / 2, clientY: 180 }]);
      await advancePreviewFrame();
      expect(heavyWork(props)).toEqual(baseline);
      const point = croppedPdfPointAt('p1-body', 180, 180);
      expect(point[0]).toBeCloseTo(anchor[0]);
      expect(point[1]).toBeCloseTo(anchor[1]);
    }
    dispatchTouch(scroll, 'touchend', []);
    await advancePreviewFrame();
    expect(latestLocation(props)).toMatchObject({ reader_mode: 'reading', reading_block_id: 'p1-body', zoom: 1.5, zoom_mode: 'custom' });
    const point = croppedPdfPointAt('p1-body', 180, 180);
    expect(point[0]).toBeCloseTo(anchor[0]);
    expect(point[1]).toBeCloseTo(anchor[1]);
    expect(canvas.width).toBeGreaterThan(original_pixels);
    expect(canvas.width).toBe(Math.floor(parseFloat(page.style.width)));
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('anchors a cross-block selection in display order without losing repeated source pages', async () => {
    const props = readingProps('p1-intro');
    const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: 100, height: 10, fontName: 'body', dir: 'ltr', hasEOL: false });
    pdf_fixture.text_content.set(1, [item('Introduction', 80, 650), item('Body paragraph', 340, 650)]);
    pdf_fixture.text_content.set(2, [item('Figure 1', 100, 500)]);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(readingBlock('p1-body')?.querySelector('.textLayer')?.textContent).toBe('Body paragraph'));
    const range = document.createRange();
    const first = readingBlock('p1-intro').querySelector('.textLayer span')!.firstChild!;
    const last = readingBlock('p1-body').querySelector('.textLayer span')!.firstChild!;
    range.setStart(first, 0);
    range.setEnd(last, last.textContent!.length);
    const original_rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
      const element = this.startContainer instanceof HTMLElement ? this.startContainer : this.startContainer.parentElement!;
      const bounds = element.closest<HTMLElement>('[data-block-id]')!.getBoundingClientRect();
      return [{ left: bounds.left + 20, top: bounds.top + 20, right: bounds.left + 120, bottom: bounds.top + 30 }];
    } });
    try {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      fireEvent.keyUp(screen.getByLabelText('Scrollable reading view'), { key: 'Shift' });
      const selected = vi.mocked(props.on_selection).mock.calls.at(-1)![0];
      expect(selected?.selected_text).toBe('Introduction\nFigure 1\nBody paragraph');
      expect(selected?.page_anchors.map((anchor) => anchor.page_number)).toEqual([1, 2, 1]);
      expect(selected?.page_anchors[0].quad_points[0][0]).toBeLessThan(300);
      expect(selected?.page_anchors[2].quad_points[0][0]).toBeGreaterThan(320);
      selection.removeAllRanges();
    } finally {
      if (original_rects) Object.defineProperty(Range.prototype, 'getClientRects', original_rects);
      else delete (Range.prototype as Partial<Range>).getClientRects;
    }
  });
});

describe('immersive PDF view', () => {
  it('fits a new paper, refits on resize, and preserves manual zoom', async () => {
    // Location reports run after layout in an animation frame. Drive those
    // frames directly so a busy native build cannot consume a timer deadline.
    const frames = new Map<number, FrameRequestCallback>();
    let frame_id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frame_id, callback);
      return frame_id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    async function reportView() {
      expect(frames.size).toBeGreaterThan(0);
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(performance.now()));
      });
    }
    const props = readerProps();
    await act(async () => { render(<PdfReader {...props} />); });
    await reportView();
    expect(latestLocation(props).zoom).toBeCloseTo(336 / 600);
    expect(latestLocation(props).zoom_mode).toBe('fit_width');

    resizeViewport(840);
    await reportView();
    expect(latestLocation(props).zoom).toBeCloseTo(816 / 600);
    const fitted = latestLocation(props);
    expect(fitted.page_number).toBe(1);
    expectActualPosition(props);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await reportView();
    expect(latestLocation(props).zoom).toBeCloseTo(816 / 600 + 0.15);
    expect(latestLocation(props).zoom_mode).toBe('custom');
    const reports_before_resize = vi.mocked(props.on_location_change).mock.calls.length;
    resizeViewport(390);
    await reportView();
    expect(vi.mocked(props.on_location_change).mock.calls.length).toBeGreaterThan(reports_before_resize);
    expect(latestLocation(props).zoom).toBeCloseTo(816 / 600 + 0.15);

    fireEvent.click(screen.getByRole('button', { name: 'Fit page width' }));
    await reportView();
    expect(latestLocation(props).zoom).toBeCloseTo(366 / 600);
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('restores saved page, position, and zoom without auto-fitting', async () => {
    const saved: ReadingLocation = { paper_id: '1706.03762v7', page_number: 2, page_position: [0.2, 0.5], zoom: 1.4, rotation: 0 };
    const props = readerProps(saved);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props)).toEqual({ ...saved, zoom_mode: 'custom', reader_mode: 'pdf' }));
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
    expect(next.kind).toBe('pdf');
    if (next.kind !== 'pdf') throw new Error('Expected a page destination');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    await waitFor(() => expect(props.on_navigate).toHaveBeenCalled());
    const destination = vi.mocked(props.on_navigate).mock.calls.at(-1)![0];
    if (destination.kind !== 'pdf') throw new Error('Expected an internal citation');
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
    if (destination.kind !== 'pdf') throw new Error('Expected a page destination');
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
  it.each(['pdf', 'reading'] as const)('keeps %s pinch active through scrollbar-only resize notifications but cancels a real resize', async (mode) => {
    const props = mode === 'reading' ? readingProps() : readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_location_change).toHaveBeenCalled());
    const scroll = screen.getByLabelText(mode === 'reading' ? 'Scrollable reading view' : 'Scrollable PDF pages');
    const crop = scroll.querySelector<HTMLElement>('.pdf-page')!;
    const crop_width = crop.style.width;
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    dispatchSafariGesture(scroll, 'gesturechange', 1.2);
    await advancePreviewFrame();
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, get: () => viewport_width + 6 },
      clientHeight: { configurable: true, get: () => viewport_height + 15 },
    });
    act(() => resize_callbacks.forEach((callback) => callback()));
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(true);
    expect(crop.style.width).toBe(crop_width);
    dispatchSafariGesture(scroll, 'gesturechange', 1.5);
    await advancePreviewFrame();
    const promoted = scroll.querySelector<HTMLElement>('[data-zoom-preview-page]')!;
    expect(previewTransform(promoted).scale).toBeCloseTo(1.5);
    resizeViewport(viewport_width, viewport_height + 100);
    await advancePreviewFrame();
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(scroll.querySelector('[data-zoom-preview-page]')).toBeNull();
    expect(scroll.style.getPropertyValue('--zoom-preview-width')).toBe('');
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
  });

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

  it('previews sixty touch frames without PDF work and commits one sharp viewport at the final midpoint', async () => {
    const props = readerProps();
    render(<PdfReader {...props} controls_visible={false} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const anchor = pdfPointAt(page, 180, 180);
    const initial_zoom = latestLocation(props).zoom;
    const initial_size = { width: page.style.width, height: page.style.height };
    const initial_pixels = { width: firstCanvas().width, height: firstCanvas().height };
    const baseline = heavyWork(props);
    const visible_pages = document.querySelectorAll('.pdf-page canvas').length;
    const wrapper = page.parentElement!;
    vi.useFakeTimers();
    const pointer = { pointerId: 1, isPrimary: true, button: 0, clientX: 140, clientY: 180 };
    fireEvent.pointerDown(scroll, pointer);
    const start = dispatchTouch(scroll, 'touchstart', [
      { identifier: 1, clientX: 140, clientY: 180 },
      { identifier: 2, clientX: 220, clientY: 180 },
    ]);
    expect(start.defaultPrevented).toBe(true);
    for (let frame = 1; frame <= 60; frame += 1) {
      const progress = frame / 60;
      const center_x = 180 + 20 * progress;
      const center_y = 180 + 40 * progress;
      const distance = 80 * (1 + progress);
      expect(dispatchTouch(scroll, 'touchmove', [
        { identifier: 1, clientX: center_x - distance / 2, clientY: center_y },
        { identifier: 2, clientX: center_x + distance / 2, clientY: center_y },
      ]).defaultPrevented).toBe(true);
      await advancePreviewFrame();
      expect(heavyWork(props)).toEqual(baseline);
      expect({ width: page.style.width, height: page.style.height }).toEqual(initial_size);
      expect({ width: firstCanvas().width, height: firstCanvas().height }).toEqual(initial_pixels);
      expectPdfPointAt(page, anchor, center_x, center_y);
      expect(scroll.dataset.zoomPreview).toBe('true');
      expect(wrapper.hasAttribute('data-zoom-preview-page')).toBe(true);
      expect(previewTransform(wrapper).scale).toBeCloseTo(1 + progress);
      expect(scroll.querySelector<HTMLElement>('.pdf-pages')!.style.transform).toBe('');
    }
    dispatchTouch(scroll, 'touchend', []);
    fireEvent.pointerUp(scroll, pointer);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2);
    expectPdfPointAt(page, anchor, 200, 220);
    expect(heavyWork(props)).toEqual({
      page_renders: baseline.page_renders + visible_pages,
      text_layers: baseline.text_layers + visible_pages,
      canvas_copies: baseline.canvas_copies + visible_pages,
      location_reports: baseline.location_reports + 1,
    });
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(wrapper.style.transform).toBe('');
    expect(wrapper.style.transformOrigin).toBe('');
    expect(wrapper.hasAttribute('data-zoom-preview-page')).toBe(false);
    expect(page.querySelector<HTMLElement>('.textLayer')!.hidden).toBe(false);
    expect(firstCanvas().width).toBe(Math.floor(parseFloat(page.style.width)));
    await advancePreviewFrame(200);
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
    expect(latestLocation(props).zoom_mode).toBe('custom');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('previews thirty Safari frames without PDF work and commits their final scale and midpoint', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const anchor = pdfPointAt(page, 180, 180);
    const initial_zoom = latestLocation(props).zoom;
    const baseline = heavyWork(props);
    const visible_pages = document.querySelectorAll('.pdf-page canvas').length;
    vi.useFakeTimers();
    expect(dispatchSafariGesture(scroll, 'gesturestart', 1).defaultPrevented).toBe(true);
    for (let frame = 1; frame <= 30; frame += 1) {
      const progress = frame / 30;
      const center_x = 180 + 20 * progress;
      const center_y = 180 + 40 * progress;
      expect(dispatchSafariGesture(scroll, 'gesturechange', 1 + progress, center_x, center_y).defaultPrevented).toBe(true);
      await advancePreviewFrame();
      expect(heavyWork(props)).toEqual(baseline);
      expect(latestLocation(props).zoom).toBe(initial_zoom);
      expectPdfPointAt(page, anchor, center_x, center_y);
    }
    expect(dispatchSafariGesture(scroll, 'gestureend', 2, 200, 220).defaultPrevented).toBe(true);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2);
    expect(heavyWork(props)).toEqual({
      page_renders: baseline.page_renders + visible_pages,
      text_layers: baseline.text_layers + visible_pages,
      canvas_copies: baseline.canvas_copies + visible_pages,
      location_reports: baseline.location_reports + 1,
    });
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
    const page = screen.getByLabelText('Page 1');
    const canvas = firstCanvas();
    const old_pixels = { width: canvas.width, height: canvas.height };
    const old_copy_count = pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas).length;
    const initial_zoom = latestLocation(props).zoom;
    pdf_fixture.defer_renders = true;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(latestRender().viewport.scale).toBeGreaterThan(initial_zoom));
    const canceled = latestRender();
    expect(canceled.canvas).not.toBe(canvas);
    expect(firstCanvas()).toBe(canvas);
    expect({ width: canvas.width, height: canvas.height }).toEqual(old_pixels);
    expect(pdf_fixture.canvas_copies.filter((copy) => copy.canvas === canvas)).toHaveLength(old_copy_count);
    expect(page.querySelector<HTMLElement>('.textLayer')!.hidden).toBe(true);
    expect(page.querySelector('.pdf-page-placeholder')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
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

  it('previews a continuous ctrl-wheel gesture and rasterizes once after wheel input stops', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const initial_zoom = latestLocation(props).zoom;
    const anchor = pdfPointAt(page, 180, 180);
    const baseline = heavyWork(props);
    const visible_pages = document.querySelectorAll('.pdf-page canvas').length;
    vi.useFakeTimers();
    for (let frame = 1; frame <= 60; frame += 1) {
      const progress = (frame - 1) / 59;
      expect(dispatchZoomWheel(scroll, -4, 180 + 20 * progress, 180 + 40 * progress).defaultPrevented).toBe(true);
      await advancePreviewFrame();
      expect(heavyWork(props)).toEqual(baseline);
      expect(latestLocation(props).zoom).toBe(initial_zoom);
      expectPdfPointAt(page, anchor, 180 + 20 * progress, 180 + 40 * progress);
    }
    await advancePreviewFrame(150);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * Math.exp(60 * 4 * 0.002));
    expectPdfPointAt(page, anchor, 200, 220);
    expect(heavyWork(props)).toEqual({
      page_renders: baseline.page_renders + visible_pages,
      text_layers: baseline.text_layers + visible_pages,
      canvas_copies: baseline.canvas_copies + visible_pages,
      location_reports: baseline.location_reports + 1,
    });
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(page.parentElement!.style.transform).toBe('');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('commits the last valid touch preview when the native touch sequence is canceled', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const initial_zoom = latestLocation(props).zoom;
    const baseline = heavyWork(props);
    vi.useFakeTimers();
    dispatchTouch(scroll, 'touchstart', [
      { identifier: 1, clientX: 140, clientY: 180 },
      { identifier: 2, clientX: 220, clientY: 180 },
    ]);
    dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: 100, clientY: 180 },
      { identifier: 2, clientX: 260, clientY: 180 },
    ]);
    await advancePreviewFrame();
    expect(heavyWork(props)).toEqual(baseline);
    dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: NaN, clientY: 180 },
      { identifier: 2, clientX: 260, clientY: 180 },
    ]);
    dispatchTouch(scroll, 'touchcancel', []);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2);
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(page.parentElement!.style.transform).toBe('');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('continues a flushed Safari preview when direct touch events take ownership', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const initial_zoom = latestLocation(props).zoom;
    const baseline = heavyWork(props);
    const visible_pages = document.querySelectorAll('.pdf-page canvas').length;
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    dispatchSafariGesture(scroll, 'gesturechange', 1.5);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBe(initial_zoom);
    expect(previewTransform(screen.getByLabelText('Page 1').parentElement).scale).toBe(1.5);
    dispatchTouch(scroll, 'touchstart', [{ identifier: 1, clientX: 130, clientY: 180 }]);
    dispatchTouch(scroll, 'touchstart', [
      { identifier: 1, clientX: 130, clientY: 180 },
      { identifier: 2, clientX: 230, clientY: 180 },
    ]);
    dispatchTouch(scroll, 'touchmove', [
      { identifier: 1, clientX: 80, clientY: 180 },
      { identifier: 2, clientX: 280, clientY: 180 },
    ]);
    await advancePreviewFrame();
    expect(heavyWork(props)).toEqual(baseline);
    expect(previewTransform(screen.getByLabelText('Page 1').parentElement).scale).toBeCloseTo(3);
    dispatchTouch(scroll, 'touchend', []);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 3);
    expect(heavyWork(props)).toEqual({
      page_renders: baseline.page_renders + visible_pages,
      text_layers: baseline.text_layers + visible_pages,
      canvas_copies: baseline.canvas_copies + visible_pages,
      location_reports: baseline.location_reports + 1,
    });
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('retains finished raster and text layers when a gesture ends without moving', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const canvas = firstCanvas();
    const text_layer = screen.getByLabelText('Page 1').querySelector<HTMLElement>('.textLayer')!;
    const baseline = heavyWork(props);
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    await advancePreviewFrame();
    expect(text_layer.hidden).toBe(true);
    dispatchSafariGesture(scroll, 'gestureend', 1);
    await advancePreviewFrame();
    expect(heavyWork(props)).toEqual(baseline);
    expect(firstCanvas()).toBe(canvas);
    expect(text_layer.hidden).toBe(false);
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(latestLocation(props).zoom_mode).toBe('fit_width');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('preserves the distance from a gesture midpoint in the gap between PDF pages', async () => {
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const initial_zoom = latestLocation(props).zoom;
    const anchor = pdfPointAt(page, 180, 480);
    expect(page.getBoundingClientRect().bottom).toBeLessThan(480);
    expect(screen.getByLabelText('Page 2').getBoundingClientRect().top).toBeGreaterThan(480);
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1, 180, 480);
    dispatchSafariGesture(scroll, 'gesturechange', 2, 180, 500);
    await advancePreviewFrame();
    expectPdfPointAt(page, anchor, 180, 500);
    const preview_bottom = page.getBoundingClientRect().bottom;
    dispatchSafariGesture(scroll, 'gestureend', 2, 180, 500);
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom * 2);
    expect(page.getBoundingClientRect().bottom).toBeCloseTo(preview_bottom);
    expectPdfPointAt(page, anchor, 180, 500);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('clears a preview and discards its queued zoom when the paper changes', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const old_scroll = screen.getByLabelText('Scrollable PDF pages');
    const old_wrapper = screen.getByLabelText('Page 1').parentElement!;
    vi.useFakeTimers();
    dispatchSafariGesture(old_scroll, 'gesturestart', 1);
    dispatchSafariGesture(old_scroll, 'gesturechange', 2);
    await advancePreviewFrame();
    expect(old_wrapper.style.transform).not.toBe('');
    const reports_before_change = vi.mocked(props.on_location_change).mock.calls.length;
    dispatchSafariGesture(old_scroll, 'gesturechange', 3);
    const next_paper = { ...props.paper, paper_id: '2401.00001v1', arxiv_id: '2401.00001', arxiv_version: 1 };
    view.rerender(<PdfReader {...props} paper={next_paper} pdf_data={new Uint8Array([2])} />);
    await advancePreviewFrame();
    expect(old_wrapper.style.transform).toBe('');
    expect(old_wrapper.style.transformOrigin).toBe('');
    expect(old_wrapper.hasAttribute('data-zoom-preview-page')).toBe(false);
    expect(old_scroll.hasAttribute('data-zoom-preview')).toBe(false);
    for (let frame = 0; frame < 4 && latestLocation(props).paper_id !== next_paper.paper_id; frame += 1) {
      await advancePreviewFrame();
    }
    expect(latestLocation(props)).toMatchObject({ paper_id: next_paper.paper_id, zoom_mode: 'fit_width' });
    expect(latestLocation(props).zoom).toBeCloseTo(336 / 600);
    expect(vi.mocked(props.on_location_change).mock.calls.slice(reports_before_change).every(([location]) => location.paper_id === next_paper.paper_id)).toBe(true);
    expect(screen.getByLabelText('Page 1').parentElement!.style.transform).toBe('');
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('discards a preview when a panel opens and keeps ordinary scrolling and zoom buttons working', async () => {
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    await expectReadyPage();
    const scroll = screen.getByLabelText('Scrollable PDF pages');
    const page = screen.getByLabelText('Page 1');
    const initial_zoom = latestLocation(props).zoom;
    const reports_before_preview = vi.mocked(props.on_location_change).mock.calls.length;
    const baseline = heavyWork(props);
    vi.useFakeTimers();
    dispatchSafariGesture(scroll, 'gesturestart', 1);
    dispatchSafariGesture(scroll, 'gesturechange', 2);
    await advancePreviewFrame();
    expect(page.parentElement!.style.transform).not.toBe('');
    dispatchSafariGesture(scroll, 'gesturechange', 3);
    view.rerender(<PdfReader {...props} reading_active={false} />);
    await advancePreviewFrame();
    expect(page.parentElement!.style.transform).toBe('');
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(latestLocation(props).zoom).toBe(initial_zoom);
    expect(props.on_location_change).toHaveBeenCalledTimes(reports_before_preview);
    expect(heavyWork(props)).toEqual(baseline);
    expect(dispatchZoomWheel(scroll).defaultPrevented).toBe(false);
    view.rerender(<PdfReader {...props} reading_active />);
    act(() => scroll.scrollTo({ top: 80 }));
    fireEvent.scroll(scroll);
    await advancePreviewFrame();
    expect(props.on_location_change).toHaveBeenCalledTimes(reports_before_preview + 1);
    expectActualPosition(props);
    const renders_before_button = pdf_fixture.render_requests.length;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom + 0.15);
    expect(latestLocation(props).zoom_mode).toBe('custom');
    expect(pdf_fixture.render_requests.length).toBeGreaterThan(renders_before_button);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await advancePreviewFrame();
    expect(latestLocation(props).zoom).toBeCloseTo(initial_zoom);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('releases canceled settled buffers without waiting for pending cached text extraction', async () => {
    pdf_fixture.defer_text = true;
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(latestLocation(props).zoom_mode).toBe('fit_width'));
    const pending_text_count = pdf_fixture.text_requests.filter((request) => request.page_number === 1).length;
    expect(pending_text_count).toBeGreaterThan(0);
    for (let update = 0; update < 3; update += 1) {
      const previous = latestRender();
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
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


describe('PDF link targets', () => {
  it.each([
    { url: 'https://arxiv.org/pdf/1706.03762v7.pdf', kind: 'app', arxiv_id: '1706.03762v7' },
    { url: 'https://example.com/paper', kind: 'external' },
  ])('routes $kind URL links through the shared classifier', async ({ url, kind, arxiv_id }) => {
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'url', rect: [100, 500, 125, 512], url }]);
    const props = readerProps();
    render(<PdfReader {...props} />);
    const label = kind === 'app' ? 'Open paper in Papertrail' : 'Open in browser';
    fireEvent.click(await screen.findByRole('button', { name: `${label}: ${url}` }));
    expect(props.on_navigate).toHaveBeenCalledWith(kind === 'app' ? { kind, url, arxiv_id } : { kind, url });
  });

  it.each(['destination', 'page index'])('discards a delayed %s after a later link is followed', async (stage) => {
    let complete!: (value: unknown[] | number) => void;
    if (stage === 'destination') {
      pdf_fixture.destinations.set('slow', new Promise<unknown[]>((resolve) => { complete = (value) => resolve(value as unknown[]); }));
    } else {
      pdf_fixture.page_indices.set(2, new Promise<number>((resolve) => { complete = (value) => resolve(value as number); }));
    }
    pdf_fixture.annotations.set(1, [
      { subtype: 'Link', id: 'slow', rect: [100, 500, 125, 512], dest: stage === 'destination' ? 'slow' : [{ num: 2, gen: 0 }, { name: 'Fit' }] },
      { subtype: 'Link', id: 'latest', rect: [150, 500, 175, 512], dest: [2, { name: 'Fit' }] },
    ]);
    const props = readerProps();
    render(<PdfReader {...props} />);
    const links = await screen.findAllByRole('button', { name: 'Go to destination within this paper' });
    fireEvent.click(links[0]);
    fireEvent.click(links[1]);
    expect(props.on_navigate).toHaveBeenCalledWith({ kind: 'pdf', location: expect.objectContaining({ page_number: 3 }) });
    await act(async () => { complete(stage === 'destination' ? [1, { name: 'Fit' }] : 1); });
    expect(props.on_navigate).toHaveBeenCalledTimes(1);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it.each(['history', 'mode', 'paper'])('discards a named destination after a %s change', async (change) => {
    readingProps();
    let complete!: (value: unknown[]) => void;
    pdf_fixture.destinations.set('slow', new Promise<unknown[]>((resolve) => { complete = resolve; }));
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'slow', rect: [100, 600, 125, 612], dest: 'slow' }]);
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_location_change).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    const target = { ...latestLocation(props), ...(change === 'mode' ? { reader_mode: 'reading' as const } : { page_number: 3 }) };
    if (change === 'paper') {
      view.rerender(<PdfReader {...props} paper={{ ...props.paper, paper_id: 'new-paper' }} target_location={null} pdf_data={new Uint8Array([2])} navigation_key={2} />);
      await waitFor(() => expect(latestLocation(props).paper_id).toBe('new-paper'));
    } else {
      view.rerender(<PdfReader {...props} target_location={target} navigation_key={2} />);
      await waitFor(() => expect(latestLocation(props)).toMatchObject(change === 'mode' ? { reader_mode: 'reading' } : { page_number: 3 }));
    }
    await act(async () => { complete([1, { name: 'Fit' }]); });
    expect(props.on_navigate).not.toHaveBeenCalled();
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('ignores a rejected destination after a page control has navigated', async () => {
    let reject!: (error: Error) => void;
    pdf_fixture.destinations.set('slow', new Promise<unknown[]>((_resolve, fail) => { reject = fail; }));
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'slow', rect: [100, 600, 125, 612], dest: 'slow' }]);
    const props = readerProps();
    render(<PdfReader {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await act(async () => { reject(new Error('Delayed invalid destination')); });
    expect(props.on_navigate).toHaveBeenCalledTimes(1);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it.each([false, true])('discards a pending destination when the reader becomes inactive, including reactivation: %s', async (reactivate) => {
    let complete!: (value: unknown[]) => void;
    pdf_fixture.destinations.set('slow', new Promise<unknown[]>((resolve) => { complete = resolve; }));
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'slow', rect: [100, 600, 125, 612], dest: 'slow' }]);
    const props = readerProps();
    const view = render(<PdfReader {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    view.rerender(<PdfReader {...props} reading_active={false} />);
    if (reactivate) view.rerender(<PdfReader {...props} reading_active />);
    await act(async () => { complete([1, { name: 'Fit' }]); });
    expect(props.on_navigate).not.toHaveBeenCalled();
    expect(props.on_error).not.toHaveBeenCalled();
    if (reactivate) {
      fireEvent.click(screen.getByRole('button', { name: 'Go to destination within this paper' }));
      await waitFor(() => expect(props.on_navigate).toHaveBeenCalledWith({ kind: 'pdf', location: expect.objectContaining({ page_number: 2 }) }));
    }
  });

  it('allows a figure link to finish after closing the figure reactivates the reader', async () => {
    const show_modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
    try {
      let complete!: (value: unknown[]) => void;
      pdf_fixture.destinations.set('figure-target', new Promise<unknown[]>((resolve) => { complete = resolve; }));
      pdf_fixture.annotations.set(2, [{ subtype: 'Link', id: 'figure-link', rect: [100, 600, 125, 612], dest: 'figure-target' }]);
      const props = readingProps('p1-intro');
      render(<PdfReader {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: /^Enlarge / }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(dialog.querySelector('.pdf-embedded-link')).toBeTruthy());
      fireEvent.click(dialog.querySelector('.pdf-embedded-link')!);
      expect(screen.queryByRole('dialog')).toBeNull();
      await act(async () => { complete([0, { name: 'XYZ' }, 400, 500, null]); });
      expect(props.on_navigate).toHaveBeenCalledWith({ kind: 'pdf', location: expect.objectContaining({ reader_mode: 'reading', reading_block_id: 'p1-body', page_number: 1 }) });
      expect(props.on_error).not.toHaveBeenCalled();
    } finally {
      if (show_modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show_modal);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  });
});

describe('reference details in both reading modes', () => {
  it.each(['pdf', 'reading'] as const)('finds references before a long appendix and opens their margin citation in %s mode', async (mode) => {
    const props = mode === 'reading' ? readingProps('p1-intro') : readerProps();
    pdf_fixture.page_sizes = Array.from({ length: 67 }, () => ({ width: 612, height: 792 }));
    const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: 400, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    pdf_fixture.text_content.set(42, [
      item('References', 90, 500),
      item('Scott Aaronson and Hendrik Kirchner.', 90, 450),
      item('Watermarking gpt outputs, 2023.', 101, 436),
    ]);
    pdf_fixture.text_content.set(43, [
      item('Tom B. Brown and Benjamin Mann.', 90, 651),
      item('Language models are few-shot learners.', 101, 637),
      item('In Advances in Neural Information Processing Systems, 2020. 2', 101, 623),
    ]);
    pdf_fixture.text_content.set(54, [item('A Additional Ablation on Mimi Codec', 90, 700), item('Appendix source https://example.org/unrelated', 90, 680)]);
    pdf_fixture.destinations.set('cite.gpt3', [42, { name: 'XYZ' }, 62.727, 663, null]);
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'moshi-margin', rect: [100, 600, 180, 612], dest: 'cite.gpt3' }]);
    if (mode === 'reading') reading_fixture.layout!.blocks[0].text = 'Earlier language models.';
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_references).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: 'Watermarking gpt outputs', page_number: 42 }),
      expect.objectContaining({ title: 'Language models are few-shot learners', page_number: 43 }),
    ], 'ready'));
    if (mode === 'reading') {
      await waitFor(() => expect(document.querySelector('.reference-strip button')?.textContent).toContain('Language models are few-shot learners'));
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    await waitFor(() => expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ title: 'Language models are few-shot learners', page_number: 43 }) }));
    expect(props.on_error).not.toHaveBeenCalled();
  });

  function bibliography() {
    const item = (str: string, y: number) => ({ str, transform: [10, 0, 0, 10, 50, y], width: 260, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    pdf_fixture.text_content.set(4, [item('References', 750), item('[7] Jane Doe. A useful paper. Journal, 2021.', 700)]);
  }

  it('opens reference details for bibliography links without navigating away or redrawing PDF', async () => {
    bibliography();
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'cite-7', rect: [100, 500, 125, 512], dest: [3, { name: 'XYZ' }, 50, 712, null] }]);
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_references).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ label: '7' })]), 'ready'));
    const baseline = pdf_fixture.render_requests.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    await waitFor(() => expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: '7', page_number: 4 }) }));
    expect(pdf_fixture.render_requests.length).toBe(baseline);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'reading'] as const)('retains the reference popup for arXiv citation URLs in %s mode', async (mode) => {
    const item = (str: string, y: number) => ({ str, transform: [10, 0, 0, 10, 50, y], width: 260, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    pdf_fixture.text_content.set(4, [item('References', 750), item('[7] Jane Doe. A useful paper. arXiv:1706.03762, 2021.', 700)]);
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'cite-url', rect: [100, 600, 125, 612], url: 'https://arxiv.org/abs/1706.03762' }]);
    const props = mode === 'reading' ? readingProps('p1-intro') : readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_references).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ label: '7', arxiv_id: '1706.03762' })]), 'ready'));
    const baseline = pdf_fixture.render_requests.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Open paper in Papertrail: https://arxiv.org/abs/1706.03762' }));
    expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: '7' }) });
    expect(pdf_fixture.render_requests.length).toBe(baseline);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('shows a reference beside a citing block outside the PDF crop and text layer', async () => {
    bibliography();
    const props = readingProps('p1-intro');
    reading_fixture.layout!.blocks[0].text = 'This follows earlier work [7].';
    render(<PdfReader {...props} />);
    await waitFor(() => expect(document.querySelector('.reference-strip button')).toBeTruthy());
    const button = document.querySelector<HTMLButtonElement>('.reference-strip button')!;
    expect(button.closest('.pdf-page-wrap')).toBeNull();
    expect(button.closest('.textLayer')).toBeNull();
    fireEvent.click(button);
    expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: '7' }) });
    expect(props.on_toggle_controls).not.toHaveBeenCalled();
  });

  function authorYearBibliography() {
    const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: 230, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    pdf_fixture.text_content.set(4, [
      item('References', 50, 750),
      item('Smith, J., Jones, M., and Doe, A.', 50, 700),
      item('A useful paper. Example Journal, 2025.', 60, 688),
      item('doi: 10.1000/example.', 60, 676),
      item('Brown, A. and Green, B.', 50, 620),
      item('A different useful title. Example Journal, 2022.', 60, 608),
      item('Further research.', 60, 596),
      item('Lee, A. and Kim, B.', 307, 650),
      item('Another useful title. Example Journal, 2024.', 317, 638),
      item('10.18653/v1/2024.example.1.', 317, 626),
      item('Wang, C. et al. (2023). A third useful title.', 307, 600),
      item('Example Journal.', 317, 588),
    ]);
  }

  it('shows unlinked author–year citations beside their Reading block and opens the existing popup', async () => {
    authorYearBibliography();
    const props = readingProps('p1-intro');
    reading_fixture.layout!.blocks[0].text = 'Following Smith et al. (2025) and Wang et al. (2023).';
    render(<PdfReader {...props} />);
    await waitFor(() => expect(document.querySelectorAll('.reference-strip button')).toHaveLength(2));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.reference-strip button')];
    expect(buttons[0].textContent).toContain('A useful paper');
    expect(buttons[1].textContent).toContain('A third useful title');
    fireEvent.click(buttons[0]);
    expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: null, title: 'A useful paper', publication_year: '2025' }) });
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('shows parenthetical citations from an unindented semicolon bibliography beside the first-page block', async () => {
    const item = (str: string, y: number) => ({ str, transform: [10, 0, 0, 10, 54, y], width: 240, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
    pdf_fixture.text_content.set(4, [item('References', 750),
      item('Chu, Y.; Xu, J.; and Yang, Q. 2023. Qwen-audio:', 714),
      item('Advancing universal audio understanding. arXiv:2311.07919.', 703),
      item('Tang, C.; Yu, W.; and Sun, G. 2023. Salmonn:', 689),
      item('Towards generic hearing abilities. arXiv:2310.13289.', 678),
    ]);
    const props = readingProps('p1-body');
    reading_fixture.layout!.blocks[2].text = 'Earlier models (Chu et al. 2023; Tang et al. 2023) support audio understanding.';
    render(<PdfReader {...props} />);
    await waitFor(() => expect(document.querySelectorAll('.reference-strip button')).toHaveLength(2));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.reference-strip button')];
    expect(buttons[0].closest('article')?.querySelector('[data-block-id]')?.getAttribute('data-block-id')).toBe('p1-body');
    expect(buttons[0].textContent).toContain('Qwen-audio');
    expect(buttons[1].textContent).toContain('Salmonn');
    fireEvent.click(buttons[0]);
    expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ authors: ['Y. Chu', 'J. Xu', 'Q. Yang'], publication_year: '2023', arxiv_id: '2311.07919' }) });
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'reading'] as const)('opens an author–year citation with a margin destination in %s mode', async (mode) => {
    authorYearBibliography();
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'author-year-margin', rect: [100, 600, 180, 612], dest: [3, { name: 'XYZ' }, 287, 662, null] }]);
    const props = mode === 'reading' ? readingProps('p1-intro') : readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_references).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ title: 'Another useful title', label: null })]), 'ready'));
    if (mode === 'reading') {
      await waitFor(() => expect(document.querySelector('.reference-strip button')?.textContent).toContain('Another useful title'));
    }
    const baseline = pdf_fixture.render_requests.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Go to destination within this paper' }));
    await waitFor(() => expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ title: 'Another useful title', publication_year: '2024' }) }));
    expect(pdf_fixture.render_requests.length).toBe(baseline);
    expect(props.on_error).not.toHaveBeenCalled();
  });

  describe('Reading preview paint', () => {
    let styles: HTMLStyleElement;

    beforeEach(() => {
      styles = document.createElement('style');
      styles.textContent = reader_styles;
      document.head.append(styles);
      vi.stubGlobal('IntersectionObserver', class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(target: HTMLElement) {
          const isIntersecting = target.dataset.blockId !== 'p3-original';
          const bounds = target.getBoundingClientRect();
          this.callback([{
            target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
            boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null, time: 0,
          }], this as unknown as IntersectionObserver);
        }
        disconnect() {}
      });
    });

    afterEach(() => styles.remove());

    it.each(['finish', 'cancel'] as const)('keeps references with their passage throughout Safari pinch and restores interaction on %s', async (ending) => {
      bibliography();
      const props = readingProps();
      reading_fixture.layout!.blocks[2].text = 'This follows earlier work [7].';
      const view = render(<PdfReader {...props} />);
      await waitFor(() => expect(document.querySelector('.reference-strip button')).toBeTruthy());
      await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
      const page = readingBlock('p1-body');
      await waitFor(() => expect(page.querySelector<HTMLElement>('.textLayer')!.hidden).toBe(false));
      const scroll = screen.getByLabelText('Scrollable reading view');
      const strip = scroll.querySelector<HTMLElement>('.pdf-pages')!;
      const toolbar = screen.getByLabelText('PDF view controls');
      const articles = [...scroll.querySelectorAll<HTMLElement>('article')];
      const actions = [...scroll.querySelectorAll<HTMLElement>('.reading-block-type, .reading-block-actions, .reference-strip')];
      const article = page.closest<HTMLElement>('article')!;
      const reference = article.querySelector<HTMLElement>('.reference-strip')!;
      const canvas = page.querySelector<HTMLCanvasElement>('canvas')!;
      const original_pixels = { width: canvas.width, height: canvas.height };
      const original_page_size = { width: page.style.width, height: page.style.height };
      const toolbar_bounds = toolbar.getBoundingClientRect();
      const anchor = croppedPdfPointAt('p1-body', 180, 180);
      const baseline = heavyWork(props);
      const original_zoom = latestLocation(props).zoom;
      expect(readingBlock('p3-original').querySelector('canvas')).toBeNull();
      expect(getComputedStyle(scroll).backgroundColor).toBe('rgb(244, 243, 237)');
      // The stationary scroll viewport must paint the full background, even
      // where an enlarged crop overflows the content strip horizontally.
      expect(getComputedStyle(strip).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      for (const article of articles) expect(getComputedStyle(article).backgroundColor).toBe('rgb(255, 255, 255)');
      for (const action of actions) expect(getComputedStyle(action).visibility).toBe('visible');

      vi.useFakeTimers();
      dispatchSafariGesture(scroll, 'gesturestart', 1);
      for (const [scale, client_x, client_y] of [[1.5, 200, 190], [0.7, 160, 170], [1.4, 180, 180]]) {
        dispatchSafariGesture(scroll, 'gesturechange', scale, client_x, client_y);
        await advancePreviewFrame();
        expect(heavyWork(props)).toEqual(baseline);
        expect({ width: canvas.width, height: canvas.height }).toEqual(original_pixels);
        expect({ width: page.style.width, height: page.style.height }).toEqual(original_page_size);
        expect(previewTransform(article).scale).toBeCloseTo(scale);
        expect(page.parentElement!.style.transform).toBe('');
        expect(croppedPdfPointAt('p1-body', client_x, client_y)[0]).toBeCloseTo(anchor[0]);
        expect(croppedPdfPointAt('p1-body', client_x, client_y)[1]).toBeCloseTo(anchor[1]);
        expect(getComputedStyle(page).backgroundColor).toBe('rgb(255, 255, 255)');
        for (const block of articles) {
          expect(getComputedStyle(block).backgroundColor).toBe('rgb(255, 255, 255)');
          expect(getComputedStyle(block).visibility).toBe(block.hasAttribute('data-zoom-preview-page') ? 'visible' : 'hidden');
        }
        for (const action of actions) {
          expect(getComputedStyle(action).visibility).toBe(action.closest('[data-zoom-preview-page]') ? 'visible' : 'hidden');
          expect(getComputedStyle(action).display).not.toBe('none');
          expect(action.style.transform).toBe('');
        }
        expect(getComputedStyle(reference).visibility).toBe('visible');
        expect(getComputedStyle(reference.querySelector('.reference-strip-title')!).visibility).toBe('visible');
        expect(getComputedStyle(reference.querySelector('.reference-strip-publication')!).visibility).toBe('visible');
        expect(reference.closest('[data-zoom-preview-page]')).toBe(article);
        expect(getComputedStyle(article.querySelector('.reading-block-actions')!).pointerEvents).toBe('none');
        expect(getComputedStyle(readingBlock('p3-original').parentElement!).visibility).toBe('hidden');
        expect(toolbar.getBoundingClientRect()).toMatchObject({
          left: toolbar_bounds.left, top: toolbar_bounds.top, width: toolbar_bounds.width, height: toolbar_bounds.height,
        });
        expect(toolbar.style.transform).toBe('');
        expect(getComputedStyle(scroll).backgroundColor).toBe('rgb(244, 243, 237)');
      }

      if (ending === 'finish') dispatchSafariGesture(scroll, 'gestureend', 1.4);
      else {
        dispatchSafariGesture(scroll, 'gesturechange', 2);
        view.rerender(<PdfReader {...props} reading_active={false} />);
      }
      await advancePreviewFrame();
      expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
      expect(page.parentElement!.style.transform).toBe('');
      for (const block of articles) {
        expect(getComputedStyle(block).backgroundColor).toBe('rgb(255, 255, 255)');
        expect(block.style.transform).toBe('');
        expect(block.hasAttribute('data-zoom-preview-page')).toBe(false);
      }
      for (const action of actions) expect(getComputedStyle(action).visibility).toBe('visible');
      expect(getComputedStyle(scroll).backgroundColor).toBe('rgb(244, 243, 237)');
      expect(getComputedStyle(strip).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(latestLocation(props).zoom).toBeCloseTo(original_zoom * (ending === 'finish' ? 1.4 : 1));
      if (ending === 'cancel') expect(heavyWork(props)).toEqual(baseline);
      else expect(canvas.width).toBe(Math.floor(Number.parseFloat(page.style.width)));
      fireEvent.scroll(scroll);
      await advancePreviewFrame();
      expect(getComputedStyle(reference).visibility).toBe('visible');
      fireEvent.click(reference.querySelector('button')!);
      expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: '7' }) });
      expect(props.on_error).not.toHaveBeenCalled();
    });

    it('keeps visible reference rows in the preview after their offscreen crop bitmap is unmounted', async () => {
      bibliography();
      const props = readingProps();
      reading_fixture.layout!.blocks[4].text = 'This follows earlier work [7].';
      const view = render(<PdfReader {...props} />);
      await waitFor(() => expect(document.querySelector('.reference-strip button')).toBeTruthy());
      const page = readingBlock('p3-original');
      const article = page.closest<HTMLElement>('article')!;
      const reference = article.querySelector<HTMLElement>('.reference-strip')!;
      expect(page.querySelector('canvas')).toBeNull();
      // The crop has scrolled above the viewport, but its long reference list
      // still intersects it. Selection must use the whole passage bounds.
      vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({
        x: 10, y: -900, left: 10, top: -900, right: 350, bottom: 200,
        width: 340, height: 1100, toJSON: () => ({}),
      });
      const scroll = screen.getByLabelText('Scrollable reading view');
      const baseline = heavyWork(props);
      vi.useFakeTimers();
      dispatchSafariGesture(scroll, 'gesturestart', 1);
      dispatchSafariGesture(scroll, 'gesturechange', 0.7);
      await advancePreviewFrame();
      expect(article.hasAttribute('data-zoom-preview-page')).toBe(true);
      expect(previewTransform(article).scale).toBeCloseTo(0.7);
      expect(getComputedStyle(reference).visibility).toBe('visible');
      expect(page.querySelector('canvas')).toBeNull();
      expect(heavyWork(props)).toEqual(baseline);
      view.rerender(<PdfReader {...props} reading_active={false} />);
      await advancePreviewFrame();
      expect(article.style.transform).toBe('');
      expect(article.hasAttribute('data-zoom-preview-page')).toBe(false);
      expect(getComputedStyle(reference).visibility).toBe('visible');
    });

    it('animates only nearby Reading blocks and brings prefetched blocks in without frame-time layout or PDF work', async () => {
      const props = readingProps();
      const view = render(<PdfReader {...props} />);
      await waitFor(() => expect(latestLocation(props).reading_block_id).toBe('p1-body'));
      const distant = readingBlock('p1-intro').closest<HTMLElement>('article')!;
      await waitFor(() => expect(distant.querySelector('canvas')).toBeTruthy());
      const scroll = screen.getByLabelText('Scrollable reading view');
      const baseline = heavyWork(props);
      vi.useFakeTimers();
      dispatchSafariGesture(scroll, 'gesturestart', 1);
      await advancePreviewFrame();
      expect(distant.hasAttribute('data-zoom-preview-page')).toBe(false);
      expect(distant.style.transform).toBe('');
      const layout_reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
      for (let frame = 0; frame < 60; frame++) {
        dispatchSafariGesture(scroll, 'gesturechange', 1 + frame / 150);
        await advancePreviewFrame();
      }
      expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length).toBe(layout_reads);
      expect(heavyWork(props)).toEqual(baseline);
      expect(distant.hasAttribute('data-zoom-preview-page')).toBe(false);
      dispatchSafariGesture(scroll, 'gesturechange', 0.2);
      await advancePreviewFrame();
      expect(distant.hasAttribute('data-zoom-preview-page')).toBe(true);
      expect(getComputedStyle(distant).visibility).toBe('visible');
      expect(heavyWork(props)).toEqual(baseline);
      view.rerender(<PdfReader {...props} reading_active={false} />);
      await advancePreviewFrame();
      expect(scroll.querySelector('[data-zoom-preview-page]')).toBeNull();
    });
  });

  it('associates a block through native citation geometry when its text cannot identify the citation', async () => {
    bibliography();
    const props = readingProps('p1-intro');
    pdf_fixture.annotations.set(1, [{ subtype: 'Link', id: 'author-year-link', rect: [100, 600, 200, 612], dest: [3, { name: 'XYZ' }, 50, 712, null] }]);
    render(<PdfReader {...props} />);
    await waitFor(() => expect(document.querySelector('.reference-strip button')).toBeTruthy());
    const strips = [...document.querySelectorAll('.reference-strip')];
    expect(strips).toHaveLength(1);
    expect(strips[0].closest('article')?.querySelector('[data-block-id]')?.getAttribute('data-block-id')).toBe('p1-intro');
    fireEvent.click(strips[0].querySelector('button')!);
    expect(props.on_navigate).toHaveBeenLastCalledWith({ kind: 'reference', reference: expect.objectContaining({ label: '7' }) });
  });

  it('defers new reference rows until an active pinch has settled', async () => {
    bibliography();
    pdf_fixture.defer_text_page = 4;
    const props = readingProps('p1-intro');
    reading_fixture.layout!.blocks[0].text = 'This follows earlier work [7].';
    render(<PdfReader {...props} />);
    await waitFor(() => expect(pdf_fixture.text_requests.some((request) => request.page_number === 4)).toBe(true));
    await waitFor(() => expect(readingBlock('p1-intro').querySelector('.textLayer')?.textContent).toBeDefined());
    const scroll = screen.getByLabelText('Scrollable reading view');
    vi.useFakeTimers();
    dispatchTouch(scroll, 'touchstart', [{ identifier: 1, clientX: 140, clientY: 180 }, { identifier: 2, clientX: 220, clientY: 180 }]);
    dispatchTouch(scroll, 'touchmove', [{ identifier: 1, clientX: 120, clientY: 180 }, { identifier: 2, clientX: 240, clientY: 180 }]);
    await advancePreviewFrame();
    await act(async () => { pdf_fixture.text_requests.filter((request) => request.page_number === 4).forEach((request) => request.complete()); });
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(true);
    expect(document.querySelector('.reference-strip')).toBeNull();
    dispatchTouch(scroll, 'touchend', []);
    await advancePreviewFrame();
    expect(scroll.hasAttribute('data-zoom-preview')).toBe(false);
    expect(document.querySelector('.reference-strip')).toBeTruthy();
    expect(props.on_error).not.toHaveBeenCalled();
  });

  it('keeps a readable PDF open if bibliography text extraction fails', async () => {
    pdf_fixture.fail_text_page = 4;
    const props = readerProps();
    render(<PdfReader {...props} />);
    await waitFor(() => expect(props.on_references).toHaveBeenLastCalledWith([], 'error'));
    expect(screen.getByLabelText('Page 1')).toBeTruthy();
    expect(screen.queryByText(/Could not open this PDF/)).toBeNull();
    expect(props.on_error).not.toHaveBeenCalled();
  });
});
