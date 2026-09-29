import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RotateCw, Scan, Expand, FileText } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker_url from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PageAnchor, PdfReaderProps, PdfZoomMode, ReadingLocation, ReaderMode, ReadingBlock, ReferenceItem } from '../lib/types';
import { anchorViewportPosition, clamp, safeReferenceUrl } from '../lib/pdf-geometry';
import { extractReferences, referenceAtDestination, referencesForText } from '../lib/pdf-references';
import { extractCitationLinks, referenceForUrl } from '../lib/pdf-citation-links';
import type { CitationLink } from '../lib/pdf-citation-links';
import { selectionContext } from '../lib/pdf-selection';
import { pdfContentLines } from '../lib/pdf-text';
import { readPdfTextContent } from '../lib/pdf-compatibility';
import { interactiveReaderTarget, isReaderTap, moveReaderGesture, startReaderGesture } from '../lib/reader-gestures';
import type { ReaderGesture } from '../lib/reader-gestures';
import type { SelectionPage } from '../lib/pdf-selection';
import { attachPdfZoomGestures } from '../lib/pdf-zoom-gestures';
import type { PdfZoomPoint } from '../lib/pdf-zoom-gestures';
import { PdfPage } from './PdfPage';
import type { PdfLink } from './PdfPage';
import { regionGeometry } from '../lib/pdf-region';
import { useReadingLayout } from '../lib/use-reading-layout';
import { findReadingBlock, locationInRegion, positionInRegion } from '../lib/reading-navigation';
import { FigureDialog } from './FigureDialog';
import { ReferenceStrip } from './ReferenceStrip';
import './pdf-reader.css';
import './reading-view.css';

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

function defaultLocation(paper_id: string): ReadingLocation {
  return { paper_id, page_number: 1, page_position: [0, 0], zoom: 1.1, zoom_mode: 'fit_width', rotation: 0 };
}

interface ZoomPreview {
  pages: Array<{ element: HTMLElement; origin: PdfZoomPoint }>;
  scroll_root: HTMLDivElement;
  root_origin: PdfZoomPoint;
  start_point: PdfZoomPoint;
  anchor_offset: PdfZoomPoint;
  point: PdfZoomPoint;
  base_zoom: number;
  zoom: number;
  updated: boolean;
}

export function PdfReader(props: PdfReaderProps) {
  const { paper, pdf_data, annotations, target_location, navigation_key } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [loaded_pdf, setLoaded] = useState<LoadedPdf | null>(null);
  const loaded = loaded_pdf?.paper_id === paper.paper_id ? loaded_pdf : null;
  const loaded_ref = useRef(loaded);
  loaded_ref.current = loaded;
  const [reader_mode, setReaderMode] = useState<ReaderMode>(target_location?.reader_mode ?? paper.last_location?.reader_mode ?? 'pdf');
  const [enlarged_figure, setEnlargedFigure] = useState<ReadingBlock | null>(null);
  const reading = reader_mode === 'reading';
  const { layout, progress: layout_progress, error: layout_error, retry: retryLayout } = useReadingLayout(loaded?.pages ?? null, paper.pdf_hash, paper.paper_id, reading);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [references, setReferences] = useState<ReferenceItem[]>([]);
  const [citation_links, setCitationLinks] = useState<CitationLink[]>([]);
  const [parsed_references, setParsedReferences] = useState<{ paper_id: string; items: ReferenceItem[]; links: CitationLink[] } | null>(null);
  const block_references = useMemo(() => new Map((layout?.blocks ?? []).map((block) => {
    const ids = new Set(referencesForText(block.text, references).map((reference) => reference.reference_id));
    for (const link of citation_links) {
      if (link.page_number === block.page_number &&
        link.source_rect[0] < block.source_rect[2] && link.source_rect[2] > block.source_rect[0] &&
        link.source_rect[1] < block.source_rect[3] && link.source_rect[3] > block.source_rect[1]) ids.add(link.reference_id);
    }
    const items = references.filter((reference) => ids.has(reference.reference_id) && (
      // The bibliography itself isn't a citing paragraph.
      reference.page_number !== block.page_number || !reference.source_rect ||
      reference.source_rect[2] < block.source_rect[0] || reference.source_rect[0] > block.source_rect[2] ||
      reference.source_rect[3] < block.source_rect[1] || reference.source_rect[1] > block.source_rect[3]));
    return [block.block_id, items] as const;
  })), [layout, references, citation_links]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(target_location?.zoom ?? paper.last_location?.zoom ?? 1.1);
  const [rotation, setRotation] = useState(target_location?.rotation ?? paper.last_location?.rotation ?? 0);
  const [active_page, setActivePage] = useState(target_location?.page_number ?? 1);
  const [page_input, setPageInput] = useState(String(active_page));
  const [scroll_root, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [view_revision, setViewRevision] = useState(0);
  const [show_tap_hint, setShowTapHint] = useState(false);
  const [render_paused, setRenderPaused] = useState(false);
  const selection_pages = useRef(new Map<string, SelectionPage>());
  const pending_location = useRef<ReadingLocation | null>(null);
  const pending_anchor = useRef<PageAnchor | null>(null);
  const pending_view_point = useRef<[number, number] | null>(null);
  const zoom_anchor = useRef<{ page_number: number; page_position: [number, number]; reading_block_id?: string | null } | null>(null);
  const zoom_preview = useRef<ZoomPreview | null>(null);
  const restoration_frame = useRef<number | null>(null);
  const current_location = useRef(defaultLocation(paper.paper_id));
  const current_paper_id = useRef(paper.paper_id);
  current_paper_id.current = paper.paper_id;
  const scroll_frame = useRef<number | null>(null);
  const zoom_mode = useRef<PdfZoomMode>('custom');
  const fit_pending = useRef(false);
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

  const register_page = useMemo(() => (region_id: string, page_data: SelectionPage | null) => {
    if (page_data) selection_pages.current.set(region_id, page_data);
    else selection_pages.current.delete(region_id);
  }, []);
  const report_error = useMemo(() => (message: string) => callbacks.current.on_error(message), []);
  const preserve_reference_location = useRef(() => {});
  preserve_reference_location.current = () => {
    if (reading && !pending_location.current) pending_location.current = readLocation();
  };

  const immersive = Boolean(props.on_toggle_controls);
  const controls_visible = props.controls_visible ?? true;
  const reading_active = (props.reading_active ?? true) && !enlarged_figure;

  function cancelPendingTap() {
    if (tap_timer.current) clearTimeout(tap_timer.current);
    tap_timer.current = null;
  }

  function clearZoomPreview() {
    const preview = zoom_preview.current;
    if (preview) {
      for (const { element } of preview.pages) {
        element.style.removeProperty('transform');
        element.removeAttribute('data-zoom-preview-page');
      }
      preview.scroll_root.removeAttribute('data-zoom-preview');
    }
    zoom_preview.current = null;
    zoom_anchor.current = null;
    setRenderPaused(false);
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
    setReferences([]);
    setCitationLinks([]);
    setParsedReferences(null);
    setEnlargedFigure(null);
    selection_pages.current.clear();
    cancelPendingTap();
    gesture.current = null;
    clearZoomPreview();
    pending_view_point.current = null;
    callbacks.current.on_selection(null);
    callbacks.current.on_references([], 'loading');
    const saved = callbacks.current.target_location ?? callbacks.current.paper.last_location;
    const should_fit = callbacks.current.initial_fit_width ?? !saved;
    const initial_mode = saved?.zoom_mode ?? (should_fit ? 'fit_width' : 'custom');
    const initial: ReadingLocation = {
      ...(saved ?? defaultLocation(paper.paper_id)),
      zoom_mode: initial_mode,
    };
    pending_location.current = initial;
    pending_anchor.current = callbacks.current.target_anchor ?? null;
    current_location.current = initial;
    zoom_mode.current = initial_mode;
    fit_pending.current = initial_mode === 'fit_width';
    applied_navigation.current = { paper_id: paper.paper_id, navigation_key: callbacks.current.navigation_key };
    setReaderMode(initial.reader_mode ?? 'pdf');
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
      void (async () => {
        const reference_pages = pages.slice(-Math.min(25, Math.max(6, Math.ceil(pages.length * 0.45))));
        const text_pages = [];
        for (const page of reference_pages) {
          const content = await readPdfTextContent(page);
          if (disposed) return;
          const lines = pdfContentLines(content);
          text_pages.push({ page_number: page.pageNumber, text: lines.map((line) => line.text).join('\n'), lines });
        }
        if (disposed) return;
        const items = extractReferences(text_pages);
        const links = await extractCitationLinks(document, pages, items, () => !disposed);
        if (!disposed) setParsedReferences({ paper_id: paper.paper_id, items, links });
      })().catch(() => {
        // A malformed bibliography must not replace an already working reader.
        if (!disposed) callbacks.current.on_references([], 'error');
      });
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

  useEffect(() => {
    // Installing new rows changes block heights. Defer until a pinch has
    // committed, so restoration never measures compositor-scaled rectangles.
    if (!parsed_references || parsed_references.paper_id !== paper.paper_id || render_paused || zoom_preview.current) return;
    preserve_reference_location.current();
    setReferences(parsed_references.items);
    setCitationLinks(parsed_references.links);
    callbacks.current.on_references(parsed_references.items, 'ready');
    setParsedReferences(null);
  }, [parsed_references, paper.paper_id, render_paused]);

  // History is owned by the app. A new key restores the destination, while
  // scrolling and view controls merely update the existing history entry.
  useEffect(() => {
    const target = callbacks.current.target_location;
    if (!target || target.paper_id !== paper.paper_id) return;
    if (applied_navigation.current?.paper_id === paper.paper_id && applied_navigation.current.navigation_key === navigation_key) return;
    applied_navigation.current = { paper_id: paper.paper_id, navigation_key };
    zoom_mode.current = target.zoom_mode ?? 'custom';
    fit_pending.current = zoom_mode.current === 'fit_width';
    pending_location.current = { ...target, zoom_mode: zoom_mode.current };
    pending_anchor.current = callbacks.current.target_anchor ?? null;
    pending_view_point.current = null;
    clearZoomPreview();
    setReaderMode(target.reader_mode ?? 'pdf');
    setEnlargedFigure(null);
    setZoom(clamp(target.zoom, minimum_zoom, maximum_zoom));
    setRotation(target.rotation);
    setActivePage(target.page_number);
    // A same-scale history/page jump still needs a fresh layout restoration.
    setViewRevision((value) => value + 1);
  }, [navigation_key, paper.paper_id]);

  useLayoutEffect(() => {
    if (!scroll_root || !loaded || !pending_location.current) return;
    let target = pending_location.current;
    if (target.paper_id !== paper.paper_id || (target.reader_mode ?? 'pdf') !== reader_mode || (reading && !layout)) return;
    if (fit_pending.current) {
      const fitted_zoom = fittedWidth(target.page_number, target.rotation);
      if (fitted_zoom === null) return;
      fit_pending.current = false;
      target = { ...target, zoom: fitted_zoom };
      pending_location.current = target;
      setZoom(fitted_zoom);
    }
    if (zoom !== clamp(target.zoom, minimum_zoom, maximum_zoom) || rotation !== target.rotation) return;
    // Commit the layout and remove the compositor preview in the same paint.
    // Measuring while the transform is still applied would scale the anchor twice.
    clearZoomPreview();
    const page_number = clamp(target.page_number, 1, loaded.pages.length);
    const anchor = pending_anchor.current;
    if (anchor?.page_number === page_number) {
      const pdf_page = loaded.pages[page_number - 1];
      const viewport = pdf_page.getViewport({ scale: zoom, rotation: (pdf_page.rotate + rotation) % 360 });
      target = { ...target, page_position: anchorViewportPosition(anchor.quad_points, viewport, viewport.width, viewport.height) };
    }
    const block = reading && layout ? findReadingBlock(layout, { ...target, reading_block_id: anchor ? null : target.reading_block_id }, loaded.pages) : null;
    const page = [...scroll_root.querySelectorAll<HTMLElement>('[data-page-number]')].find((element) =>
      block ? element.dataset.blockId === block.block_id : Number(element.dataset.pageNumber) === page_number);
    const position = block
      ? positionInRegion(target, regionGeometry(loaded.pages[page_number - 1], blockZoom(block), rotation, block.source_rect))
      : target.page_position;
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    const root_bounds = scroll_root.getBoundingClientRect();
    const view_point = pending_view_point.current ?? [20, 20];
    scroll_root.scrollTo({
      top: scroll_root.scrollTop + bounds.top - root_bounds.top + clamp(position[1], 0, 1) * bounds.height - view_point[1],
      left: Math.max(0, scroll_root.scrollLeft + bounds.left - root_bounds.left + clamp(position[0], 0, 1) * bounds.width - view_point[0]),
      behavior: 'instant',
    });
    // Browsers clamp scrolling near the document edges and center fitted pages.
    // Save the point actually visible, rather than an unreachable requested one.
    current_location.current = readLocation() ?? { ...target, page_number, zoom, rotation };
    setActivePage(current_location.current.page_number);
    pending_location.current = null;
    pending_anchor.current = null;
    pending_view_point.current = null;
    if (restoration_frame.current !== null) cancelAnimationFrame(restoration_frame.current);
    // PDF layout is synchronous; one frame suppresses scroll events generated
    // by this restoration before the user moves again.
    restoration_frame.current = requestAnimationFrame(() => {
      restoration_frame.current = null;
      reportLocation();
    });
  }, [loaded, zoom, rotation, scroll_root, navigation_key, target_location, paper.paper_id, view_revision, reader_mode, layout, references]);

  const resize_callback = useRef(() => {});
  resize_callback.current = () => {
    if (!scroll_root || !loaded || scroll_root.clientWidth <= 0 || scroll_root.clientHeight <= 0) return;
    const size = { width: scroll_root.clientWidth, height: scroll_root.clientHeight };
    if (viewport_size.current?.width === size.width && viewport_size.current.height === size.height) return;
    clearZoomPreview();
    viewport_size.current = size;
    // The saved page-relative point predates the resize. Reading it from the
    // shifted page DOM would lose the passage when the phone turns sideways.
    const source = pending_location.current ?? current_location.current;
    const next_zoom = zoom_mode.current === 'fit_width' ? fittedWidth(source.page_number, source.rotation) ?? source.zoom : source.zoom;
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
    if (!scroll_root || !loaded || !reading_active) return;
    return attachPdfZoomGestures(scroll_root, {
      get_zoom: () => zoom_preview.current?.zoom ?? zoom_ref.current,
      minimum_zoom,
      maximum_zoom,
      on_start: (point: PdfZoomPoint) => {
        // Anchor to a point in the PDF, not the app viewport. The midpoint may
        // move during a pinch, so retain this page-relative point until it ends.
        const pages = [...scroll_root.querySelectorAll<HTMLElement>('[data-page-number]')];
        let nearest: HTMLElement | null = null;
        let nearest_distance = Infinity;
        for (const page of pages) {
          const bounds = page.getBoundingClientRect();
          const distance = Math.hypot(
            point.client_x - clamp(point.client_x, bounds.left, bounds.right),
            point.client_y - clamp(point.client_y, bounds.top, bounds.bottom),
          );
          if (distance < nearest_distance) {
            nearest = page;
            nearest_distance = distance;
          }
        }
        if (!nearest) return false;
        const bounds = nearest.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return false;
        const root_bounds = scroll_root.getBoundingClientRect();
        // Promote only pages with a mounted bitmap, not the entire potentially
        // hundred-page strip. Capture geometry once, before any transforms.
        const preview_pages = pages.filter((page) => page.querySelector('canvas')).map((page) => {
          const element = page.closest<HTMLElement>('.pdf-page-wrap')!;
          const bounds = element.getBoundingClientRect();
          return { element, origin: { client_x: bounds.left, client_y: bounds.top } };
        });
        zoom_preview.current = {
          pages: preview_pages,
          scroll_root,
          root_origin: { client_x: root_bounds.left, client_y: root_bounds.top },
          start_point: point,
          anchor_offset: {
            client_x: clamp(point.client_x, bounds.left, bounds.right) - point.client_x,
            client_y: clamp(point.client_y, bounds.top, bounds.bottom) - point.client_y,
          },
          point,
          base_zoom: zoom_ref.current,
          zoom: zoom_ref.current,
          updated: false,
        };
        for (const { element } of preview_pages) element.setAttribute('data-zoom-preview-page', 'true');
        scroll_root.setAttribute('data-zoom-preview', 'true');
        setRenderPaused(true);
        zoom_anchor.current = locationAtElement(nearest, [
          clamp((point.client_x - bounds.left) / bounds.width, 0, 1),
          clamp((point.client_y - bounds.top) / bounds.height, 0, 1),
        ]);
        cancelPendingTap();
        gesture.current = null;
        const selection = window.getSelection();
        if (selection?.anchorNode && scroll_root.contains(selection.anchorNode)) selection.removeAllRanges();
        callbacks.current.on_selection(null);
        return true;
      },
      on_zoom: (next_zoom, point) => {
        const preview = zoom_preview.current;
        if (!preview) return;
        preview.zoom = next_zoom;
        preview.point = point;
        preview.updated = true;
        const scale = next_zoom / preview.base_zoom;
        for (const { element, origin } of preview.pages) {
          const x = point.client_x - origin.client_x - scale * (preview.start_point.client_x - origin.client_x);
          const y = point.client_y - origin.client_y - scale * (preview.start_point.client_y - origin.client_y);
          element.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
        }
      },
      on_end: (cancelled) => {
        const preview = zoom_preview.current;
        const anchor = zoom_anchor.current;
        if (!cancelled && preview?.updated && anchor) {
          zoom_mode.current = 'custom';
          fit_pending.current = false;
          pending_anchor.current = null;
          const scale = preview.zoom / preview.base_zoom;
          pending_view_point.current = [
            preview.point.client_x + preview.anchor_offset.client_x * scale - preview.root_origin.client_x,
            preview.point.client_y + preview.anchor_offset.client_y * scale - preview.root_origin.client_y,
          ];
          pending_location.current = {
            paper_id: paper.paper_id,
            ...anchor,
            zoom: preview.zoom,
            zoom_mode: 'custom',
            reader_mode,
            rotation: rotation_ref.current,
          };
          setZoom(preview.zoom);
          setViewRevision((value) => value + 1);
          setRenderPaused(false);
        } else {
          clearZoomPreview();
        }
        gesture.current = null;
        cancelPendingTap();
        last_scroll_at.current = performance.now();
      },
    });
  }, [scroll_root, loaded, reading_active, paper.paper_id, reader_mode, layout, view_revision]);

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
      // Moved figures can precede their source page. Selection follows the
      // displayed DOM order, including multiple independent crops per page.
      const pages = [...selection_pages.current.values()].sort((first, second) =>
        first.text_layer.compareDocumentPosition(second.text_layer) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
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

  function readLocation(): ReadingLocation | null {
    if (!scroll_root || scroll_root.clientWidth <= 0 || scroll_root.clientHeight <= 0) return null;
    const root_bounds = scroll_root.getBoundingClientRect();
    const pages = [...scroll_root.querySelectorAll<HTMLElement>('[data-page-number]')];
    const page = pages.find((candidate) => candidate.getBoundingClientRect().bottom > root_bounds.top + 26);
    if (!page) return null;
    const bounds = page.getBoundingClientRect();
    return {
      paper_id: current_paper_id.current,
      ...locationAtElement(page, [clamp((root_bounds.left + 20 - bounds.left) / bounds.width, 0, 1), clamp((root_bounds.top + 20 - bounds.top) / bounds.height, 0, 1)]),
      reader_mode,
      zoom: zoom_ref.current,
      zoom_mode: zoom_mode.current,
      rotation: rotation_ref.current,
    };
  }

  function reportLocation() {
    if (zoom_preview.current || pending_location.current || restoration_frame.current !== null) return;
    const location = readLocation();
    if (!location) return;
    current_location.current = location;
    setActivePage(location.page_number);
    callbacks.current.on_location_change(location);
  }

  function handleScroll() {
    last_scroll_at.current = performance.now();
    cancelPendingTap();
    if (zoom_preview.current) return;
    if (scroll_frame.current !== null) cancelAnimationFrame(scroll_frame.current);
    scroll_frame.current = requestAnimationFrame(() => {
      scroll_frame.current = null;
      reportLocation();
    });
  }

  function changeView(requested_zoom: number, next_rotation = rotation, next_mode: PdfZoomMode = 'custom') {
    clearZoomPreview();
    reportLocation();
    const source = pending_location.current ?? current_location.current;
    zoom_mode.current = next_mode;
    fit_pending.current = false;
    const next_zoom = clamp(next_mode === 'fit_width'
      ? fittedWidth(source.page_number, next_rotation) ?? requested_zoom
      : requested_zoom, minimum_zoom, maximum_zoom);
    const page = loaded?.pages[source.page_number - 1];
    let page_position = source.page_position;
    if (page && source.rotation !== next_rotation) {
      const old_viewport = page.getViewport({ scale: source.zoom, rotation: (page.rotate + source.rotation) % 360 });
      const pdf_point = old_viewport.convertToPdfPoint(source.page_position[0] * old_viewport.width, source.page_position[1] * old_viewport.height);
      const next_viewport = page.getViewport({ scale: next_zoom, rotation: (page.rotate + next_rotation) % 360 });
      const [x, y] = next_viewport.convertToViewportPoint(pdf_point[0], pdf_point[1]);
      page_position = [clamp(x / next_viewport.width, 0, 1), clamp(y / next_viewport.height, 0, 1)];
    }
    pending_location.current = { ...source, page_position, zoom: next_zoom, zoom_mode: next_mode, rotation: next_rotation };
    pending_anchor.current = null;
    pending_view_point.current = null;
    zoom_anchor.current = null;
    setZoom(pending_location.current.zoom);
    setRotation(next_rotation);
    setViewRevision((value) => value + 1);
  }

  function navigatePage(page_number: number) {
    if (!loaded) return;
    reportLocation();
    callbacks.current.on_navigate({
      kind: 'internal',
      location: { paper_id: paper.paper_id, page_number: clamp(page_number, 1, loaded.pages.length), page_position: [0, 0], zoom, zoom_mode: zoom_mode.current, rotation, reader_mode, reading_block_id: null },
    });
  }

  async function followLink(link: PdfLink, source_page: number) {
    reportLocation();
    if (link.url) {
      const url = link.url;
      const reference = referenceForUrl(references, url);
      if (reference && link.rect.length) {
        callbacks.current.on_navigate({ kind: 'reference', reference });
        return;
      }
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
      const explicit_zoom = kind === 'XYZ' && typeof destination[4] === 'number' && destination[4] > 0 ? destination[4] : null;
      const next_mode = explicit_zoom !== null ? 'custom' : zoom_mode.current;
      const next_zoom = explicit_zoom !== null ? clamp(explicit_zoom, minimum_zoom, maximum_zoom)
        : next_mode === 'fit_width' ? fittedWidth(index + 1, rotation) ?? zoom : zoom;
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
      const reference = link.rect.length ? referenceAtDestination(references, index + 1, [x, y]) : null;
      if (reference) {
        callbacks.current.on_navigate({ kind: 'reference', reference });
        return;
      }
      const [viewport_x, viewport_y] = viewport.convertToViewportPoint(x, y);
      callbacks.current.on_navigate({
        kind: 'internal',
        location: { paper_id: paper.paper_id, page_number: index + 1, page_position: [clamp(viewport_x / viewport.width, 0, 1), clamp(viewport_y / viewport.height, 0, 1)], zoom: next_zoom, zoom_mode: next_mode, rotation, reader_mode: 'pdf', reading_block_id: null },
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

  function blockZoom(block: ReadingBlock): number {
    const page = loaded?.pages[block.page_number - 1];
    if (!page || !scroll_root) return zoom;
    const region = regionGeometry(page, 1, rotation, block.source_rect);
    const pages = scroll_root.querySelector<HTMLElement>('.pdf-pages');
    const style = pages ? getComputedStyle(pages) : null;
    const padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 20;
    return zoom * Math.min(760, Math.max(40, scroll_root.clientWidth - padding - 4)) / region.width;
  }

  function locationAtElement(element: HTMLElement, position: [number, number]) {
    const page_number = Number(element.dataset.pageNumber);
    const block = reading ? layout?.blocks.find((item) => item.block_id === element.dataset.blockId) : null;
    const page = loaded?.pages[page_number - 1];
    return block && page
      ? { page_number, page_position: locationInRegion(position, regionGeometry(page, blockZoom(block), rotation, block.source_rect)), reading_block_id: block.block_id }
      : { page_number, page_position: position };
  }

  function viewOriginal(block?: ReadingBlock) {
    reportLocation();
    const source = pending_location.current ?? current_location.current;
    const page = block && loaded?.pages[block.page_number - 1];
    const page_position = block && page
      ? locationInRegion([0, 0], regionGeometry(page, 1, rotation, block.source_rect)) : source.page_position;
    callbacks.current.on_navigate({ kind: 'internal', location: {
      ...source, page_number: block?.page_number ?? source.page_number, page_position,
      reader_mode: 'pdf', reading_block_id: null, zoom_mode: 'fit_width', zoom: 1,
    } });
  }

  function fittedWidth(page_number: number, page_rotation: number): number | null {
    if (reading) return layout ? 1 : null;
    const page = loaded?.pages[clamp(page_number, 1, loaded.pages.length) - 1];
    if (!page || !scroll_root || scroll_root.clientWidth <= 0) return null;
    const width = page.getViewport({ scale: 1, rotation: (page.rotate + page_rotation) % 360 }).width;
    const pages = scroll_root.querySelector<HTMLElement>('.pdf-pages');
    const style = pages ? getComputedStyle(pages) : null;
    const padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 60;
    return clamp((scroll_root.clientWidth - padding - 4) / width, minimum_zoom, maximum_zoom);
  }

  function fitWidth() {
    changeView(zoom, rotation, 'fit_width');
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    cancelPendingTap();
    if (!reading_active || zoom_anchor.current) {
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
    const figure_id = reading && event.target instanceof Element ? event.target.closest<HTMLElement>('[data-figure-id]')?.dataset.figureId : null;
    const figure = figure_id ? layout?.blocks.find((block) => block.block_id === figure_id) : null;
    tap_timer.current = setTimeout(() => {
      tap_timer.current = null;
      if (callbacks.current.reading_active === false || hasSelection() || last_selection_at.current > pointer.timestamp || last_scroll_at.current > pointer.timestamp) return;
      if (figure) { reportLocation(); setEnlargedFigure(figure); }
      else callbacks.current.on_toggle_controls?.();
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
          <button type="button" title="Fit page width" aria-label="Fit page width" aria-pressed={zoom_mode.current === 'fit_width'} disabled={!loaded} onClick={fitWidth}><Scan size={16} /></button>
          <button type="button" title="Rotate clockwise" aria-label="Rotate clockwise" disabled={!loaded} onClick={() => changeView(zoom, (rotation + 90) % 360, zoom_mode.current)}><RotateCw size={16} /></button>
        </div>
      </div>
      {immersive && reading_active && <button type="button" className="pdf-controls-accessible" onClick={() => props.on_toggle_controls?.()}>{controls_visible ? 'Hide reading controls' : 'Show reading controls'}</button>}
      {immersive && reading_active && !controls_visible && show_tap_hint && <div className="pdf-tap-hint" aria-hidden="true">Tap the page to show reading controls</div>}
      <div className="pdf-scroll" ref={setScrollRoot} onScroll={handleScroll} inert={Boolean(enlarged_figure)}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => moveReaderGesture(gesture.current, event.pointerId, event.clientX, event.clientY)}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { gesture.current = null; cancelPendingTap(); }}
        tabIndex={0} aria-label={reading ? "Scrollable reading view" : "Scrollable PDF pages"}>
        {!loaded && <div className="pdf-loading" role="status">{error ? <p>{error}</p> : <><LoaderCircle className="pdf-spinner" size={24} /><p>Opening paper…</p></>}</div>}
        {loaded && reading && !layout && <div className="pdf-loading" role="status">
          {layout_error ? <><p>Reading view could not be prepared: {layout_error}</p><button type="button" onClick={retryLayout}>Try again</button></>
            : <><LoaderCircle className="pdf-spinner" size={24} /><p>Preparing Reading view… {layout_progress.completed} / {layout_progress.total || loaded.pages.length} pages</p><p>Finding margins, columns, and figures on this device.</p></>}
          <button type="button" onClick={() => viewOriginal()}>Return to original PDF</button>
        </div>}
        {loaded && (!reading || layout) && <div className={`pdf-pages ${reading ? `reading-pages ${controls_visible ? 'reading-pages-controls' : ''}` : ''}`}>
          {reading && layout ? layout.blocks.map((block) => <article className={`reading-block reading-block-${block.kind}`} key={`${paper.paper_id}-${block.block_id}`} data-figure-id={block.kind === 'figure' ? block.block_id : undefined}>
            <PdfPage page={loaded.pages[block.page_number - 1]} zoom={blockZoom(block)} rotation={rotation}
              source_rect={block.source_rect} block_id={block.block_id} render_paused={render_paused} scroll_root={scroll_root}
              annotations={matching_annotations} register_page={register_page} on_link={(link, page_number) => void followLink(link, page_number)} on_error={report_error} />
            <div className="reading-block-actions">
              <span>{(block.figure_label ? `Figure ${block.figure_label}` : null) ?? (block.kind === 'original' ? 'Original layout' : 'Source')} · p. {block.page_number}</span>
              {block.kind === 'figure' && <button type="button" aria-label={`Enlarge ${block.figure_label ? `Figure ${block.figure_label}` : 'figure'}`} onClick={() => { reportLocation(); setEnlargedFigure(block); }}><Expand size={15} /> Enlarge</button>}
              <button type="button" className="reading-source-button" title="View in PDF" onClick={() => viewOriginal(block)} aria-label={`View ${block.figure_label ?? 'block'} in PDF on page ${block.page_number}`}><FileText size={16} aria-hidden="true" /></button>
            </div>
            <ReferenceStrip references={block_references.get(block.block_id) ?? []} on_select={(reference) => {
              reportLocation();
              callbacks.current.on_navigate({ kind: 'reference', reference });
            }} />
          </article>) :
          loaded.pages.map((page) => <PdfPage
            key={`${paper.paper_id}-${page.pageNumber}`}
            page={page}
            zoom={zoom}
            rotation={rotation}
            render_paused={render_paused}
            scroll_root={scroll_root}
            annotations={matching_annotations}
            register_page={register_page}
            on_link={(link, page_number) => void followLink(link, page_number)}
            on_error={report_error}
          />)}
        </div>}
      </div>
      {enlarged_figure && loaded && <FigureDialog block={enlarged_figure} page={loaded.pages[enlarged_figure.page_number - 1]} annotations={matching_annotations}
        on_close={() => setEnlargedFigure(null)} on_link={(link, page_number) => { setEnlargedFigure(null); void followLink(link, page_number); }} on_source={() => { viewOriginal(enlarged_figure); setEnlargedFigure(null); }} on_error={report_error} />}
    </section>
  );
}
