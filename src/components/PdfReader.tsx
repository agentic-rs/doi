import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RotateCw, Scan } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, RenderingCancelledException, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker_url from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { Annotation, PageAnchor, PdfReaderProps, ReadingLocation } from '../lib/types';
import { anchorViewportPosition, clamp, quadToSvgPoints, safeReferenceUrl } from '../lib/pdf-geometry';
import { extractReferences } from '../lib/pdf-references';
import { selectionContext } from '../lib/pdf-selection';
import { pdfContentText } from '../lib/pdf-text';
import { readPdfTextContent } from '../lib/pdf-compatibility';
import { interactiveReaderTarget, isReaderTap, moveReaderGesture, startReaderGesture } from '../lib/reader-gestures';
import type { ReaderGesture } from '../lib/reader-gestures';
import type { SelectionPage } from '../lib/pdf-selection';
import './pdf-reader.css';

GlobalWorkerOptions.workerSrc = worker_url;

const minimum_zoom = 0.1;
const maximum_zoom = 3;

interface LoadedPdf {
  paper_id: string;
  document: PDFDocumentProxy;
  pages: PDFPageProxy[];
}

interface OutlineEntry {
  title: string;
  depth: number;
  destination: string | unknown[] | null;
  url: string | null;
}

function flattenOutline(items: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>, depth = 0): OutlineEntry[] {
  return (items ?? []).flatMap((item) => [{
    title: item.title,
    depth,
    destination: typeof item.dest === 'string' || Array.isArray(item.dest) ? item.dest : null,
    url: typeof item.url === 'string' ? safeReferenceUrl(item.url) : null,
  }, ...flattenOutline(item.items, depth + 1)]);
}

interface PdfLink {
  link_id: string;
  rect: number[];
  url: string | null;
  destination: string | unknown[] | null;
  action: string | null;
}

interface PdfPageProps {
  page: PDFPageProxy;
  zoom: number;
  rotation: number;
  scroll_root: HTMLDivElement | null;
  annotations: Annotation[];
  register_page: (page_number: number, data: SelectionPage | null) => void;
  on_link: (link: PdfLink, page_number: number) => void;
  on_error: (message: string) => void;
}

function PdfPage({ page, zoom, rotation, scroll_root, annotations, register_page, on_link, on_error }: PdfPageProps) {
  const page_ref = useRef<HTMLDivElement>(null);
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const text_ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(page.pageNumber <= 2);
  const [rendered, setRendered] = useState(false);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const viewport = useMemo(() => page.getViewport({ scale: zoom, rotation: (page.rotate + rotation) % 360 }), [page, zoom, rotation]);

  useEffect(() => {
    const element = page_ref.current;
    if (!element || !scroll_root) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: scroll_root,
      rootMargin: '1000px 600px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroll_root]);

  useEffect(() => {
    let disposed = false;
    let render_task: RenderTask | undefined;
    let text_layer: TextLayer | undefined;
    setRendered(false);
    setLinks([]);
    const canvas = canvas_ref.current;
    const text_element = text_ref.current;
    const page_element = page_ref.current;
    if (!visible || !canvas || !text_element || !page_element) return;

    async function renderPage() {
      // Restrict canvas memory on high DPI displays and very large pages.
      const pixel_ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas!.width = Math.ceil(viewport.width * pixel_ratio);
      canvas!.height = Math.ceil(viewport.height * pixel_ratio);
      render_task = page.render({ canvas: canvas!, viewport, transform: [pixel_ratio, 0, 0, pixel_ratio, 0, 0] });
      // Cancellation can precede text extraction finishing. Mark the render
      // rejection handled immediately, then surface it in the combined await.
      void render_task.promise.catch(() => undefined);
      const [content, embedded_annotations] = await Promise.all([readPdfTextContent(page), page.getAnnotations({ intent: 'display' })]);
      if (disposed) return;
      text_layer = new TextLayer({ textContentSource: content, container: text_element!, viewport });
      await Promise.all([render_task.promise, text_layer.render()]);
      if (disposed) return;
      register_page(page.pageNumber, {
        page_number: page.pageNumber,
        page_element: page_element!,
        text_layer: text_element!,
        viewport,
        text: pdfContentText(content),
      });
      setLinks(embedded_annotations.filter((annotation) => annotation.subtype === 'Link' && Array.isArray(annotation.rect))
        .map((annotation) => ({
          link_id: String(annotation.id),
          rect: annotation.rect as number[],
          url: typeof annotation.url === 'string' ? safeReferenceUrl(annotation.url) : null,
          destination: typeof annotation.dest === 'string' || Array.isArray(annotation.dest) ? annotation.dest : null,
          action: typeof annotation.action === 'string' ? annotation.action : null,
        }))
        .filter((link) => link.url || link.destination || link.action));
      setRendered(true);
    }

    void renderPage().catch((error: unknown) => {
      if (!disposed && !(error instanceof RenderingCancelledException)) {
        on_error(`Page ${page.pageNumber} could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return () => {
      disposed = true;
      register_page(page.pageNumber, null);
      render_task?.cancel();
      text_layer?.cancel();
      text_element.replaceChildren();
    };
  }, [page, visible, viewport, register_page, on_error]);

  const page_annotations = annotations.flatMap((annotation) => annotation.target.page_anchors
    .filter((anchor) => anchor.page_number === page.pageNumber)
    .map((anchor, anchor_index) => ({ annotation, anchor, anchor_index })));

  return (
    <div className="pdf-page-wrap">
      <div
        className="pdf-page"
        data-page-number={page.pageNumber}
        ref={page_ref}
        style={{ width: viewport.width, height: viewport.height, '--total-scale-factor': viewport.scale * page.userUnit } as CSSProperties}
        aria-label={`Page ${page.pageNumber}`}
      >
        {visible && <>
          <canvas ref={canvas_ref} key={`${zoom}-${rotation}`} className="pdf-page-canvas" aria-hidden="true" />
          <div className="textLayer" ref={text_ref} />
          <svg className="pdf-highlight-layer" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true">
            {page_annotations.flatMap(({ annotation, anchor, anchor_index }) => anchor.quad_points.map((quad, index) => (
              <polygon
                key={`${annotation.annotation_id}-${anchor_index}-${index}`}
                points={quadToSvgPoints(quad, viewport)}
                className={annotation.body.kind === 'ai_answer' ? 'pdf-highlight-ai' : 'pdf-highlight-note'}
              />
            )))}
          </svg>
          <div className="pdf-link-layer">
            {links.map((link) => {
              const rect = viewport.convertToViewportRectangle(link.rect);
              const left = Math.min(rect[0], rect[2]);
              const top = Math.min(rect[1], rect[3]);
              return (
                <button
                  key={link.link_id}
                  type="button"
                  className="pdf-embedded-link"
                  style={{ left, top, width: Math.abs(rect[2] - rect[0]), height: Math.abs(rect[3] - rect[1]) }}
                  title={link.url ?? 'Follow citation'}
                  aria-label={link.url ? `Open ${link.url}` : 'Follow citation to its destination'}
                  onClick={() => on_link(link, page.pageNumber)}
                />
              );
            })}
          </div>
        </>}
        {!rendered && <div className="pdf-page-placeholder" aria-hidden="true">{visible ? 'Rendering page…' : `Page ${page.pageNumber}`}</div>}
      </div>
      <span className="pdf-page-label" aria-hidden="true">{page.pageNumber}</span>
    </div>
  );
}

function defaultLocation(paper_id: string): ReadingLocation {
  return { paper_id, page_number: 1, page_position: [0, 0], zoom: 1.1, rotation: 0 };
}

export function PdfReader(props: PdfReaderProps) {
  const { paper, pdf_data, annotations, target_location, navigation_key } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [loaded_pdf, setLoaded] = useState<LoadedPdf | null>(null);
  const loaded = loaded_pdf?.paper_id === paper.paper_id ? loaded_pdf : null;
  const loaded_ref = useRef(loaded);
  loaded_ref.current = loaded;
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(target_location?.zoom ?? paper.last_location?.zoom ?? 1.1);
  const [rotation, setRotation] = useState(target_location?.rotation ?? paper.last_location?.rotation ?? 0);
  const [active_page, setActivePage] = useState(target_location?.page_number ?? 1);
  const [page_input, setPageInput] = useState(String(active_page));
  const [scroll_root, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [view_revision, setViewRevision] = useState(0);
  const [show_tap_hint, setShowTapHint] = useState(false);
  const selection_pages = useRef(new Map<number, SelectionPage>());
  const pending_location = useRef<ReadingLocation | null>(null);
  const pending_anchor = useRef<PageAnchor | null>(null);
  const restoration_frame = useRef<number | null>(null);
  const current_location = useRef(defaultLocation(paper.paper_id));
  const current_paper_id = useRef(paper.paper_id);
  current_paper_id.current = paper.paper_id;
  const scroll_frame = useRef<number | null>(null);
  const fit_width_mode = useRef(false);
  const initial_fit_pending = useRef(false);
  const applied_navigation = useRef<{ paper_id: string; navigation_key: number } | null>(null);
  const viewport_size = useRef<{ width: number; height: number } | null>(null);
  const gesture = useRef<ReaderGesture | null>(null);
  const tap_timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last_scroll_at = useRef(Number.NEGATIVE_INFINITY);
  const last_selection_at = useRef(Number.NEGATIVE_INFINITY);
  const hinted_paper = useRef<string | null>(null);
  const zoom_ref = useRef(zoom);
  const rotation_ref = useRef(rotation);
  zoom_ref.current = zoom;
  rotation_ref.current = rotation;

  const register_page = useMemo(() => (page_number: number, page_data: SelectionPage | null) => {
    if (page_data) selection_pages.current.set(page_number, page_data);
    else selection_pages.current.delete(page_number);
  }, []);
  const report_error = useMemo(() => (message: string) => callbacks.current.on_error(message), []);

  const immersive = Boolean(props.on_toggle_controls);
  const controls_visible = props.controls_visible ?? true;
  const reading_active = props.reading_active ?? true;

  function cancelPendingTap() {
    if (tap_timer.current) clearTimeout(tap_timer.current);
    tap_timer.current = null;
  }

  function hasSelection() {
    const selected = window.getSelection();
    return Boolean(selected && !selected.isCollapsed && selected.rangeCount);
  }

  useEffect(() => {
    let disposed = false;
    setLoaded(null);
    setError(null);
    setOutline([]);
    selection_pages.current.clear();
    cancelPendingTap();
    gesture.current = null;
    callbacks.current.on_selection(null);
    callbacks.current.on_references([]);
    const initial = callbacks.current.target_location ?? callbacks.current.paper.last_location ?? defaultLocation(paper.paper_id);
    pending_location.current = initial;
    pending_anchor.current = callbacks.current.target_anchor ?? null;
    current_location.current = initial;
    fit_width_mode.current = callbacks.current.initial_fit_width ?? (!callbacks.current.target_location && !callbacks.current.paper.last_location);
    initial_fit_pending.current = fit_width_mode.current;
    applied_navigation.current = { paper_id: paper.paper_id, navigation_key: callbacks.current.navigation_key };
    setZoom(clamp(initial.zoom, minimum_zoom, maximum_zoom));
    setRotation(initial.rotation);
    setActivePage(initial.page_number);
    const asset_base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
    const loading_task = getDocument({
      // PDF.js transfers this buffer to its worker. The app's cached bytes must
      // survive paper switches and React StrictMode's effect replay.
      data: pdf_data.slice(),
      cMapUrl: `${asset_base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${asset_base}standard_fonts/`,
      wasmUrl: `${asset_base}wasm/`,
    });
    void (async () => {
      const document = await loading_task.promise;
      const pages: PDFPageProxy[] = [];
      for (let first = 1; first <= document.numPages; first += 12) {
        const batch = await Promise.all(Array.from({ length: Math.min(12, document.numPages - first + 1) }, (_, index) => document.getPage(first + index)));
        if (disposed) return;
        pages.push(...batch);
      }
      if (disposed) return;
      setLoaded({ paper_id: paper.paper_id, document, pages });
      void document.getOutline().then((items) => {
        if (!disposed) setOutline(flattenOutline(items));
      }).catch(() => undefined);
      // Bibliographies are usually near the end; cap background work for very
      // large documents. Native link navigation is available on every page.
      const reference_pages = pages.slice(-Math.min(25, Math.max(6, Math.ceil(pages.length * 0.45))));
      const text_pages = [];
      for (const page of reference_pages) {
        const content = await readPdfTextContent(page);
        if (disposed) return;
        text_pages.push({ page_number: page.pageNumber, text: pdfContentText(content) });
      }
      if (!disposed) callbacks.current.on_references(extractReferences(text_pages));
    })().catch((failure: unknown) => {
      if (disposed) return;
      const message = `Could not open this PDF: ${failure instanceof Error ? failure.message : String(failure)}`;
      setError(message);
      callbacks.current.on_error(message);
    });
    return () => {
      disposed = true;
      void loading_task.destroy().catch(() => undefined);
    };
  }, [pdf_data, paper.paper_id]);

  // History is owned by the app. A new key restores the destination, while
  // scrolling and view controls merely update the existing history entry.
  useEffect(() => {
    const target = callbacks.current.target_location;
    if (!target || target.paper_id !== paper.paper_id) return;
    if (applied_navigation.current?.paper_id === paper.paper_id && applied_navigation.current.navigation_key === navigation_key) return;
    applied_navigation.current = { paper_id: paper.paper_id, navigation_key };
    fit_width_mode.current = false;
    initial_fit_pending.current = false;
    pending_location.current = target;
    pending_anchor.current = callbacks.current.target_anchor ?? null;
    setZoom(clamp(target.zoom, minimum_zoom, maximum_zoom));
    setRotation(target.rotation);
    setActivePage(target.page_number);
  }, [navigation_key, paper.paper_id]);

  useLayoutEffect(() => {
    if (!scroll_root || !loaded || !pending_location.current) return;
    let target = pending_location.current;
    if (target.paper_id !== paper.paper_id) return;
    if (initial_fit_pending.current) {
      const fitted_zoom = fittedWidth(target.page_number, target.rotation);
      if (fitted_zoom === null) return;
      initial_fit_pending.current = false;
      target = { ...target, zoom: fitted_zoom };
      pending_location.current = target;
      setZoom(fitted_zoom);
    }
    if (zoom !== clamp(target.zoom, minimum_zoom, maximum_zoom) || rotation !== target.rotation) return;
    const page_number = clamp(target.page_number, 1, loaded.pages.length);
    const anchor = pending_anchor.current;
    if (anchor?.page_number === page_number) {
      const pdf_page = loaded.pages[page_number - 1];
      const viewport = pdf_page.getViewport({ scale: zoom, rotation: (pdf_page.rotate + rotation) % 360 });
      target = { ...target, page_position: anchorViewportPosition(anchor.quad_points, viewport, viewport.width, viewport.height) };
    }
    const page = scroll_root.querySelector<HTMLElement>(`[data-page-number="${page_number}"]`);
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    const root_bounds = scroll_root.getBoundingClientRect();
    scroll_root.scrollTo({
      top: scroll_root.scrollTop + bounds.top - root_bounds.top + clamp(target.page_position[1], 0, 1) * bounds.height - 20,
      left: Math.max(0, scroll_root.scrollLeft + bounds.left - root_bounds.left + clamp(target.page_position[0], 0, 1) * bounds.width - 20),
      behavior: 'instant',
    });
    current_location.current = { ...target, page_number, zoom, rotation };
    setActivePage(page_number);
    pending_location.current = null;
    pending_anchor.current = null;
    if (restoration_frame.current !== null) cancelAnimationFrame(restoration_frame.current);
    // PDF layout is synchronous; one frame suppresses scroll events generated
    // by this restoration before the user moves again.
    restoration_frame.current = requestAnimationFrame(() => {
      restoration_frame.current = null;
      callbacks.current.on_location_change(current_location.current);
    });
  }, [loaded, zoom, rotation, scroll_root, navigation_key, target_location, paper.paper_id, view_revision]);

  const resize_callback = useRef(() => {});
  resize_callback.current = () => {
    if (!scroll_root || !loaded || scroll_root.clientWidth <= 0 || scroll_root.clientHeight <= 0) return;
    const size = { width: scroll_root.clientWidth, height: scroll_root.clientHeight };
    if (viewport_size.current?.width === size.width && viewport_size.current.height === size.height) return;
    viewport_size.current = size;
    // The saved page-relative point predates the resize. Reading it from the
    // shifted page DOM would lose the passage when the phone turns sideways.
    const source = pending_location.current ?? current_location.current;
    const next_zoom = fit_width_mode.current ? fittedWidth(source.page_number, source.rotation) ?? source.zoom : source.zoom;
    pending_location.current = { ...source, zoom: next_zoom };
    setZoom(next_zoom);
    setViewRevision((value) => value + 1);
  };

  useEffect(() => {
    if (!scroll_root || !loaded) return;
    viewport_size.current = { width: scroll_root.clientWidth, height: scroll_root.clientHeight };
    const observer = new ResizeObserver(() => resize_callback.current());
    observer.observe(scroll_root);
    return () => observer.disconnect();
  }, [scroll_root, loaded]);

  useLayoutEffect(() => {
    resize_callback.current();
  }, [props.viewport_key]);

  useEffect(() => {
    if (!immersive || !reading_active || controls_visible || hinted_paper.current === paper.paper_id) return;
    hinted_paper.current = paper.paper_id;
    setShowTapHint(true);
    const timer = setTimeout(() => setShowTapHint(false), 4_000);
    return () => {
      clearTimeout(timer);
      setShowTapHint(false);
    };
  }, [immersive, reading_active, controls_visible, paper.paper_id]);

  useEffect(() => {
    setPageInput(String(active_page));
  }, [active_page]);

  useEffect(() => {
    let selection_timer: ReturnType<typeof setTimeout> | null = null;
    const touch_selection = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const handleSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        callbacks.current.on_selection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const pages = [...selection_pages.current.values()].sort((first, second) => first.page_number - second.page_number);
      const has_reader_endpoint = pages.some((page) => page.text_layer.contains(range.startContainer) || page.text_layer.contains(range.endContainer));
      if (!has_reader_endpoint) return;
      callbacks.current.on_selection(selectionContext(range, pages));
    };
    // Updating after the mouse/key gesture avoids rebuilding multi-page anchors
    // for every single character while a selection is being extended.
    scroll_root?.addEventListener('pointerup', handleSelection);
    scroll_root?.addEventListener('keyup', handleSelection);
    const handleSelectionChange = () => {
      if (selection_timer) clearTimeout(selection_timer);
      if (window.getSelection()?.isCollapsed) {
        callbacks.current.on_selection(null);
      } else {
        last_selection_at.current = performance.now();
        cancelPendingTap();
        if (!touch_selection) return;
        // Native iOS selection handles can change a range without pointerup.
        // Capture a settled range while leaving the selection UI undisturbed.
        selection_timer = setTimeout(handleSelection, 250);
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      if (selection_timer) clearTimeout(selection_timer);
      scroll_root?.removeEventListener('pointerup', handleSelection);
      scroll_root?.removeEventListener('keyup', handleSelection);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [scroll_root]);

  useEffect(() => () => {
    if (scroll_frame.current !== null) cancelAnimationFrame(scroll_frame.current);
    if (restoration_frame.current !== null) cancelAnimationFrame(restoration_frame.current);
    cancelPendingTap();
  }, []);

  function reportLocation() {
    if (!scroll_root || pending_location.current || restoration_frame.current !== null || scroll_root.clientWidth <= 0 || scroll_root.clientHeight <= 0) return;
    const root_bounds = scroll_root.getBoundingClientRect();
    const pages = [...scroll_root.querySelectorAll<HTMLElement>('[data-page-number]')];
    const page = pages.find((candidate) => candidate.getBoundingClientRect().bottom > root_bounds.top + 26);
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    const page_number = Number(page.dataset.pageNumber);
    const location: ReadingLocation = {
      paper_id: current_paper_id.current,
      page_number,
      page_position: [clamp((root_bounds.left + 20 - bounds.left) / bounds.width, 0, 1), clamp((root_bounds.top + 20 - bounds.top) / bounds.height, 0, 1)],
      zoom: zoom_ref.current,
      rotation: rotation_ref.current,
    };
    current_location.current = location;
    setActivePage(page_number);
    callbacks.current.on_location_change(location);
  }

  function handleScroll() {
    last_scroll_at.current = performance.now();
    cancelPendingTap();
    if (scroll_frame.current !== null) cancelAnimationFrame(scroll_frame.current);
    scroll_frame.current = requestAnimationFrame(() => {
      scroll_frame.current = null;
      reportLocation();
    });
  }

  function changeView(next_zoom: number, next_rotation = rotation, keep_fit_mode = false) {
    reportLocation();
    if (!keep_fit_mode) fit_width_mode.current = false;
    const source = pending_location.current ?? current_location.current;
    const page = loaded?.pages[source.page_number - 1];
    let page_position = source.page_position;
    if (page && source.rotation !== next_rotation) {
      const old_viewport = page.getViewport({ scale: source.zoom, rotation: (page.rotate + source.rotation) % 360 });
      const pdf_point = old_viewport.convertToPdfPoint(source.page_position[0] * old_viewport.width, source.page_position[1] * old_viewport.height);
      const next_viewport = page.getViewport({ scale: next_zoom, rotation: (page.rotate + next_rotation) % 360 });
      const [x, y] = next_viewport.convertToViewportPoint(pdf_point[0], pdf_point[1]);
      page_position = [clamp(x / next_viewport.width, 0, 1), clamp(y / next_viewport.height, 0, 1)];
    }
    pending_location.current = { ...source, page_position, zoom: clamp(next_zoom, minimum_zoom, maximum_zoom), rotation: next_rotation };
    pending_anchor.current = null;
    setZoom(pending_location.current.zoom);
    setRotation(next_rotation);
    setViewRevision((value) => value + 1);
  }

  function navigatePage(page_number: number) {
    if (!loaded) return;
    reportLocation();
    callbacks.current.on_navigate({
      kind: 'internal',
      location: { paper_id: paper.paper_id, page_number: clamp(page_number, 1, loaded.pages.length), page_position: [0, 0], zoom, rotation },
    });
  }

  async function followLink(link: PdfLink, source_page: number) {
    reportLocation();
    if (link.url) {
      callbacks.current.on_navigate({ kind: 'external', url: link.url });
      return;
    }
    if (!loaded) return;
    if (link.action) {
      const page_number = { NextPage: source_page + 1, PrevPage: source_page - 1, FirstPage: 1, LastPage: loaded.pages.length }[link.action];
      if (page_number !== undefined) navigatePage(page_number);
      return;
    }
    try {
      const destination = typeof link.destination === 'string' ? await loaded.document.getDestination(link.destination) : link.destination;
      if (loaded_ref.current?.document !== loaded.document) return;
      if (!destination) throw new Error('The citation destination is missing.');
      const ref = destination[0];
      const index = typeof ref === 'number' ? ref : await loaded.document.getPageIndex(ref as { num: number; gen: number });
      if (loaded_ref.current?.document !== loaded.document) return;
      const page = loaded.pages[index];
      if (!page) throw new Error('The citation points to an unavailable page.');
      const kind = (destination[1] as { name?: string })?.name;
      const next_zoom = kind === 'XYZ' && typeof destination[4] === 'number' && destination[4] > 0 ? clamp(destination[4], minimum_zoom, maximum_zoom) : zoom;
      const viewport: PageViewport = page.getViewport({ scale: next_zoom, rotation: (page.rotate + rotation) % 360 });
      let x = page.view[0];
      let y = page.view[3];
      if (kind === 'XYZ' || kind === 'FitR') {
        if (typeof destination[2] === 'number') x = destination[2];
        if (typeof destination[kind === 'FitR' ? 5 : 3] === 'number') y = destination[kind === 'FitR' ? 5 : 3] as number;
      } else if (kind === 'FitH' || kind === 'FitBH') {
        if (typeof destination[2] === 'number') y = destination[2];
      } else if (kind === 'FitV' || kind === 'FitBV') {
        if (typeof destination[2] === 'number') x = destination[2];
      }
      const [viewport_x, viewport_y] = viewport.convertToViewportPoint(x, y);
      callbacks.current.on_navigate({
        kind: 'internal',
        location: { paper_id: paper.paper_id, page_number: index + 1, page_position: [clamp(viewport_x / viewport.width, 0, 1), clamp(viewport_y / viewport.height, 0, 1)], zoom: next_zoom, rotation },
      });
    } catch (failure) {
      if (loaded_ref.current?.document === loaded.document) callbacks.current.on_error(failure instanceof Error ? failure.message : String(failure));
    }
  }

  function submitPage(event: FormEvent) {
    event.preventDefault();
    const value = Number(page_input);
    if (Number.isInteger(value)) navigatePage(value);
    else setPageInput(String(active_page));
  }

  function fittedWidth(page_number: number, page_rotation: number): number | null {
    const page = loaded?.pages[clamp(page_number, 1, loaded.pages.length) - 1];
    if (!page || !scroll_root || scroll_root.clientWidth <= 0) return null;
    const width = page.getViewport({ scale: 1, rotation: (page.rotate + page_rotation) % 360 }).width;
    const pages = scroll_root.querySelector<HTMLElement>('.pdf-pages');
    const style = pages ? getComputedStyle(pages) : null;
    const padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 60;
    return clamp((scroll_root.clientWidth - padding - 4) / width, minimum_zoom, maximum_zoom);
  }

  function fitWidth() {
    const fitted_zoom = fittedWidth(active_page, rotation);
    if (fitted_zoom === null) return;
    fit_width_mode.current = true;
    changeView(fitted_zoom, rotation, true);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    cancelPendingTap();
    if (!reading_active) {
      gesture.current = null;
      return;
    }
    if (gesture.current) {
      gesture.current.cancelled = true;
      return;
    }
    gesture.current = startReaderGesture({
      pointer_id: event.pointerId, client_x: event.clientX, client_y: event.clientY,
      timestamp: performance.now(), is_primary: event.isPrimary, button: event.button,
      interactive_target: interactiveReaderTarget(event.target), has_selection: hasSelection(),
    });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const completed = gesture.current;
    gesture.current = null;
    if (!callbacks.current.on_toggle_controls || !reading_active) return;
    const pointer = {
      pointer_id: event.pointerId, client_x: event.clientX, client_y: event.clientY,
      timestamp: performance.now(), interactive_target: interactiveReaderTarget(event.target),
      has_selection: hasSelection(), last_scroll_at: last_scroll_at.current, last_selection_at: last_selection_at.current,
    };
    if (!isReaderTap(completed, pointer)) return;
    // A second tap can select a word; let WebKit settle its native selection
    // before changing the overlay and cancel if another gesture starts.
    tap_timer.current = setTimeout(() => {
      tap_timer.current = null;
      if (callbacks.current.reading_active === false || hasSelection() || last_selection_at.current > pointer.timestamp || last_scroll_at.current > pointer.timestamp) return;
      callbacks.current.on_toggle_controls?.();
    }, 180);
  }

  function handleReaderKey(event: KeyboardEvent<HTMLElement>) {
    if (!immersive || !reading_active || event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.key.toLowerCase() === 'f' && !interactiveReaderTarget(event.target)) || (event.key === 'Escape' && controls_visible)) {
      event.preventDefault();
      callbacks.current.on_toggle_controls?.();
    }
  }

  const matching_annotations = annotations.filter((annotation) => annotation.target.paper_id === paper.paper_id && annotation.target.pdf_hash === paper.pdf_hash);

  return (
    <section className={`pdf-reader ${immersive ? 'pdf-reader-immersive' : ''}`} aria-label="Paper reader" onKeyDown={handleReaderKey}>
      <div className="pdf-toolbar" hidden={!controls_visible} aria-label="PDF view controls">
        <div className="pdf-toolbar-group">
          <button type="button" title="Previous page" aria-label="Previous page" disabled={!loaded || active_page <= 1} onClick={() => navigatePage(active_page - 1)}><ChevronLeft size={16} /></button>
          <form className="pdf-page-picker" onSubmit={submitPage}>
            <input aria-label="Page number" inputMode="numeric" value={page_input} onChange={(event) => setPageInput(event.target.value)} disabled={!loaded} />
            <span>of {loaded?.pages.length ?? '—'}</span>
          </form>
          <button type="button" title="Next page" aria-label="Next page" disabled={!loaded || active_page >= loaded.pages.length} onClick={() => navigatePage(active_page + 1)}><ChevronRight size={16} /></button>
          {outline.length > 0 && <select className="pdf-outline-select" aria-label="Jump to a document section" value="" onChange={(event) => {
            const entry = outline[Number(event.target.value)];
            if (entry) void followLink({ link_id: 'outline', rect: [], url: entry.url, destination: entry.destination, action: null }, active_page);
          }}>
            <option value="" disabled>Contents</option>
            {outline.map((entry, index) => <option key={index} value={index}>{`${'— '.repeat(entry.depth)}${entry.title}`}</option>)}
          </select>}
        </div>
        <div className="pdf-toolbar-group">
          <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!loaded || zoom <= minimum_zoom} onClick={() => changeView(zoom - 0.15)}><Minus size={15} /></button>
          <span className="pdf-zoom-value">{Math.round(zoom * 100)}%</span>
          <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!loaded || zoom >= maximum_zoom} onClick={() => changeView(zoom + 0.15)}><Plus size={15} /></button>
          <span className="pdf-toolbar-divider" />
          <button type="button" title="Fit page width" aria-label="Fit page width" disabled={!loaded} onClick={fitWidth}><Scan size={16} /></button>
          <button type="button" title="Rotate clockwise" aria-label="Rotate clockwise" disabled={!loaded} onClick={() => changeView(zoom, (rotation + 90) % 360)}><RotateCw size={16} /></button>
        </div>
      </div>
      {immersive && reading_active && <button type="button" className="pdf-controls-accessible" onClick={() => props.on_toggle_controls?.()}>{controls_visible ? 'Hide reading controls' : 'Show reading controls'}</button>}
      {immersive && reading_active && !controls_visible && show_tap_hint && <div className="pdf-tap-hint" aria-hidden="true">Tap the page to show reading controls</div>}
      <div className="pdf-scroll" ref={setScrollRoot} onScroll={handleScroll}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => moveReaderGesture(gesture.current, event.pointerId, event.clientX, event.clientY)}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { gesture.current = null; cancelPendingTap(); }}
        tabIndex={0} aria-label="Scrollable PDF pages">
        {!loaded && <div className="pdf-loading" role="status">{error ? <p>{error}</p> : <><LoaderCircle className="pdf-spinner" size={24} /><p>Opening paper…</p></>}</div>}
        {loaded && <div className="pdf-pages">
          {loaded.pages.map((page) => <PdfPage
            key={`${paper.paper_id}-${page.pageNumber}`}
            page={page}
            zoom={zoom}
            rotation={rotation}
            scroll_root={scroll_root}
            annotations={matching_annotations}
            register_page={register_page}
            on_link={(link, page_number) => void followLink(link, page_number)}
            on_error={report_error}
          />)}
        </div>}
      </div>
    </section>
  );
}
