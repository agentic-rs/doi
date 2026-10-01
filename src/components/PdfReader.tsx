import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RotateCw, Scan, Expand, FileText, WrapText } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker_url from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PageAnchor, PdfReaderProps, PdfZoomMode, ReadingLocation, ReaderMode, ReaderTarget, ReadingBlock, ReferenceItem } from '../lib/types';
import { anchorViewportPosition, clamp, safeReferenceUrl } from '../lib/pdf-geometry';
import { extractReferences, referenceAtDestination, referencesForText } from '../lib/pdf-references';
import { extractCitationLinks, referenceForUrl } from '../lib/pdf-citation-links';
import type { CitationLink } from '../lib/pdf-citation-links';
import { classifyPaperUrl } from '../lib/paper-links';
import { selectionContext } from '../lib/pdf-selection';
import { readReferencePages } from '../lib/pdf-reference-discovery';
import { interactiveReaderTarget, isReaderTap, moveReaderGesture, startReaderGesture } from '../lib/reader-gestures';
import type { ReaderGesture } from '../lib/reader-gestures';
import { attachReaderEdgeSwipe } from '../lib/reader-edge-swipe';
import type { SelectionPage } from '../lib/pdf-selection';
import { attachPdfZoomGestures } from '../lib/pdf-zoom-gestures';
import type { PdfZoomPoint } from '../lib/pdf-zoom-gestures';
import { PdfPage } from './PdfPage';
import type { PdfLink } from './PdfPage';
import { regionGeometry } from '../lib/pdf-region';
import { useReadingLayout } from '../lib/use-reading-layout';
import { useReadingBlockPreferences } from '../lib/use-reading-block-preferences';
import { findReadingBlock, locationInRegion, positionInRegion } from '../lib/reading-navigation';
import { mapReadingNotes } from '../lib/reading-notes';
import { FigureDialog } from './FigureDialog';
import { ReferenceStrip } from './ReferenceStrip';
import { NoteCard } from './NoteCard';
import './pdf-reader.css';
import './reading-view.css';

GlobalWorkerOptions.workerSrc = worker_url;

const minimum_zoom = 0.1;
const maximum_zoom = 3;
const block_type_labels: Record<ReadingBlock['block_type'], string> = {
  content: 'Content',
  equation: 'Equation',
  graph: 'Graph',
  table: 'Table',
  reference: 'Reference',
  title: 'Title',
  others: 'Others',
};

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
  pages: Array<{ element: HTMLElement; origin: PdfZoomPoint; width: number; height: number; promoted: boolean }>;
  scroll_root: HTMLDivElement;
  root_origin: PdfZoomPoint;
  viewport: { width: number; height: number };
  layout_width: number;
  cull_offscreen: boolean;
  start_point: PdfZoomPoint;
  anchor_offset: PdfZoomPoint;
  point: PdfZoomPoint;
  base_zoom: number;
  zoom: number;
  updated: boolean;
}

function paintZoomPreview(preview: ZoomPreview, scale: number, point: PdfZoomPoint) {
  // Bitmap prefetch extends much farther than the viewport. Do not turn all
  // those articles (and their reference lists) into animated backing layers.
  // Use the frozen geometry, so every frame stays free of layout reads.
  const overscan = 128;
  for (const page of preview.pages) {
    const { element, origin } = page;
    const x = point.client_x - origin.client_x - scale * (preview.start_point.client_x - origin.client_x);
    const y = point.client_y - origin.client_y - scale * (preview.start_point.client_y - origin.client_y);
    const left = origin.client_x + x - preview.root_origin.client_x;
    const top = origin.client_y + y - preview.root_origin.client_y;
    const visible = !preview.cull_offscreen || (left < preview.viewport.width + overscan && top < preview.viewport.height + overscan
      && left + page.width * scale > -overscan && top + page.height * scale > -overscan);
    if (visible) {
      if (!page.promoted) element.setAttribute('data-zoom-preview-page', 'true');
      element.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    } else if (page.promoted) {
      element.style.removeProperty('transform');
      element.removeAttribute('data-zoom-preview-page');
    }
    page.promoted = visible;
  }
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
  const block_preferences = useReadingBlockPreferences(paper.paper_id, paper.pdf_hash, reading);
  const [split_status, setSplitStatus] = useState<Map<string, { state: string; message?: string }>>(new Map());
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
  const [displayed_notes, setDisplayedNotes] = useState({ annotations, enabled: props.inline_notes ?? false, edit: props.annotation_edit });
  // Stage editor entry/exit because it changes article height, but feed typing
  // directly back to the existing textarea. Replaying the previous value for
  // one commit would reset the caret to the end after every middle insertion.
  const displayed_edit = !render_paused && props.annotation_edit?.annotation_id === displayed_notes.edit?.annotation_id
    ? props.annotation_edit : displayed_notes.edit;
  const [note_revision, setNoteRevision] = useState(0);
  const note_layout_anchor = useRef<{ paper_id: string; candidates: Array<{ element: HTMLElement; top: number }> } | null>(null);
  const block_notes = useMemo(() => mapReadingNotes(layout, displayed_notes.enabled ? displayed_notes.annotations : [], paper.paper_id, paper.pdf_hash),
    [layout, displayed_notes.annotations, displayed_notes.enabled, paper.paper_id, paper.pdf_hash]);
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
  const link_navigation = useRef(0);
  const viewport_size = useRef<{ width: number; height: number } | null>(null);
  const gesture = useRef<ReaderGesture | null>(null);
  const edge_feedback = useRef<HTMLDivElement | null>(null);
  const edge_swiping = useRef(false);
  const tap_timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last_scroll_at = useRef(Number.NEGATIVE_INFINITY);
  const last_selection_at = useRef(Number.NEGATIVE_INFINITY);
  const hinted_paper = useRef<string | null>(null);
  const zoom_ref = useRef(zoom);
  const rotation_ref = useRef(rotation);
  zoom_ref.current = zoom;
  rotation_ref.current = rotation;

  useLayoutEffect(() => {
    // Resolving named destinations/page references can outlive a history jump,
    // mode switch, or document replacement.
    link_navigation.current++;
    return () => { link_navigation.current++; };
  }, [navigation_key, reader_mode, paper.paper_id, pdf_data]);

  const register_page = useMemo(() => (region_id: string, page_data: SelectionPage | null) => {
    if (page_data) selection_pages.current.set(region_id, page_data);
    else selection_pages.current.delete(region_id);
  }, []);
  const report_error = useMemo(() => (message: string) => callbacks.current.on_error(message), []);
  const split_layout_callback = useRef(() => {});
  split_layout_callback.current = () => {
    if (!reading || zoom_preview.current) return;
    if (!pending_location.current) pending_location.current = readLocation();
    setViewRevision((value) => value + 1);
  };
  const split_status_callback = useRef((_block_id: string, _state: string, _message?: string) => {});
  split_status_callback.current = (block_id, state, message) => {
    if (state === 'preparing' && !pending_location.current) pending_location.current = readLocation();
    setSplitStatus((previous) => {
      const current = previous.get(block_id);
      if (current?.state === state && current.message === message) return previous;
      return new Map(previous).set(block_id, { state, message });
    });
    if (state !== 'preparing') setViewRevision((value) => value + 1);
  };
  const on_split_layout_change = useMemo(() => () => split_layout_callback.current(), []);
  const on_split_status = useMemo(() => (block_id: string, state: 'preparing' | 'ready' | 'unavailable', message?: string) =>
    split_status_callback.current(block_id, state, message), []);
  const preserve_reference_location = useRef(() => {});
  preserve_reference_location.current = () => {
    if (reading && !pending_location.current) pending_location.current = readLocation();
  };

  function captureNoteLayout() {
    if (!reading || !scroll_root || zoom_preview.current || pending_location.current || note_layout_anchor.current) return;
    const root_bounds = scroll_root.getBoundingClientRect();
    // A long note can fill the viewport with its source crop already offscreen.
    // Retain a visible DOM region instead of clamping back into the next PDF crop.
    const regions = [...scroll_root.querySelectorAll<HTMLElement>('[data-page-number], .reference-strip, .note-card')]
      .map((element) => ({ element, bounds: element.getBoundingClientRect() }));
    const candidates = regions.filter(({ bounds }) => bounds.bottom > root_bounds.top + 20 && bounds.top < root_bounds.bottom)
      .map(({ element, bounds }) => ({ element, top: bounds.top - root_bounds.top }));
    if (candidates.length) {
      // If a deleted note occupied the entire viewport, reveal the nearest
      // following passage (or its source crop at the end of the document).
      const crops = regions.filter(({ element }) => element.hasAttribute('data-page-number'));
      const following = crops.find(({ bounds }) => bounds.top >= root_bounds.bottom);
      const preceding = crops.filter(({ bounds }) => bounds.bottom <= root_bounds.top + 20).at(-1);
      for (const fallback of [following, preceding]) {
        if (fallback) candidates.push({ element: fallback.element, top: 20 });
      }
      note_layout_anchor.current = { paper_id: paper.paper_id, candidates };
    }
  }

  function preserveNoteLayout() {
    captureNoteLayout();
    setNoteRevision((value) => value + 1);
  }

  const immersive = Boolean(props.on_toggle_controls);
  const controls_visible = props.controls_visible ?? true;
  const reading_active = (props.reading_active ?? true) && !enlarged_figure;

  useLayoutEffect(() => {
    // A dialog or inspector takes precedence over a pending destination. Only
    // invalidate on deactivation: following a figure link closes its dialog
    // and reactivates the reader while that new destination is resolving.
    if (!reading_active) link_navigation.current++;
  }, [reading_active]);

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
      preview.scroll_root.style.removeProperty('--zoom-preview-width');
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
    setSplitStatus(new Map());
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
      // Start near the end, then search backward for bibliographies that occur
      // before long appendices. Native links remain available while this runs.
      void (async () => {
        const text_pages = await readReferencePages(pages, () => !disposed);
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

  useEffect(() => {
    // New/saved/deleted notes must not change frozen article geometry mid-pinch.
    // Apply after the committed zoom's layout restoration, like parsed references.
    if (render_paused || zoom_preview.current) return;
    const enabled = props.inline_notes ?? false;
    if (displayed_notes.annotations === annotations && displayed_notes.enabled === enabled && displayed_notes.edit === props.annotation_edit) return;
    captureNoteLayout();
    setDisplayedNotes({ annotations, enabled, edit: props.annotation_edit });
  }, [annotations, props.inline_notes, props.annotation_edit, displayed_notes, render_paused]);

  useLayoutEffect(() => {
    const snapshot = note_layout_anchor.current;
    note_layout_anchor.current = null;
    if (!snapshot || snapshot.paper_id !== paper.paper_id || !scroll_root || !reading || zoom_preview.current || pending_location.current) return;
    const candidate = snapshot.candidates.find(({ element }) => scroll_root.contains(element));
    if (!candidate) return;
    const offset = candidate.element.getBoundingClientRect().top - scroll_root.getBoundingClientRect().top;
    scroll_root.scrollTo({ top: scroll_root.scrollTop + offset - candidate.top, behavior: 'instant' });
    reportLocation();
  }, [displayed_notes, note_revision, scroll_root, paper.paper_id, reading]);

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
    if (page?.dataset.splitPreparing === 'true') {
      // An offscreen saved split has not prepared yet. Reveal its source crop
      // first, keeping the destination pending until the exact mapping is ready.
      const bounds = page.getBoundingClientRect();
      const root_bounds = scroll_root.getBoundingClientRect();
      scroll_root.scrollTo({ top: scroll_root.scrollTop + bounds.top - root_bounds.top - 20,
        left: Math.max(0, scroll_root.scrollLeft + bounds.left - root_bounds.left - 20), behavior: 'instant' });
      return;
    }
    const mapped_page = block ? selection_pages.current.get(block.block_id) : null;
    const source_viewport = loaded.pages[page_number - 1].getViewport({ scale: 1, rotation: (loaded.pages[page_number - 1].rotate + rotation) % 360 });
    const source_point = source_viewport.convertToPdfPoint(target.page_position[0] * source_viewport.width, target.page_position[1] * source_viewport.height);
    const position = mapped_page?.position_for_source_point
      ? mapped_page.position_for_source_point(source_point as [number, number]) : block
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
    const preview = zoom_preview.current;
    if (preview) {
      const bounds = scroll_root.getBoundingClientRect();
      // WebKit can reclaim the scrollbar gutter for overflow:hidden. That
      // changes clientWidth/Height without resizing the reader itself.
      if (bounds.width === preview.viewport.width && bounds.height === preview.viewport.height) return;
    }
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
        const content_width = scroll_root.querySelector<HTMLElement>('.pdf-pages')!.getBoundingClientRect().width;
        // References and notes belong to their passage: preview the whole block
        // so its crop, background and appended rows move together. Keep this
        // limited to mounted bitmaps and blocks with inline items (a long list
        // can enter the viewport after its crop's bitmap has been unmounted).
        const preview_pages = pages.flatMap((page) => {
          const has_bitmap = Boolean(page.querySelector('canvas'));
          if (!reading && !has_bitmap) return [];
          const element = page.closest<HTMLElement>(reading ? '.reading-block' : '.pdf-page-wrap')!;
          const bounds = element.getBoundingClientRect();
          if (!has_bitmap && !element.querySelector('.reference-strip, .note-strip')) return [];
          return [{ element, origin: { client_x: bounds.left, client_y: bounds.top }, width: bounds.width, height: bounds.height, promoted: false }];
        });
        zoom_preview.current = {
          pages: preview_pages,
          scroll_root,
          root_origin: { client_x: root_bounds.left, client_y: root_bounds.top },
          viewport: { width: root_bounds.width, height: root_bounds.height },
          layout_width: scroll_root.clientWidth,
          cull_offscreen: reading,
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
        paintZoomPreview(zoom_preview.current, 1, point);
        scroll_root.style.setProperty('--zoom-preview-width', `${content_width}px`);
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
        paintZoomPreview(preview, scale, point);
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

  useLayoutEffect(() => {
    const action = props.edge_navigation;
    if (!scroll_root || !loaded || !reading_active || !action || !props.on_edge_navigation) return;
    const canSwipe = () => {
      const current = callbacks.current;
      const editing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
      return current.paper.paper_id === paper.paper_id && current.navigation_key === navigation_key
        && current.viewport_key === props.viewport_key && current.edge_navigation === action
        && current.reading_active !== false && !current.annotation_edit && !editing
        && !zoom_preview.current && !zoom_anchor.current && !pending_location.current && !hasSelection();
    };
    return attachReaderEdgeSwipe(scroll_root, {
      can_start: (target) => canSwipe() && !interactiveReaderTarget(target),
      is_current: canSwipe,
      on_claim: () => {
        edge_swiping.current = true;
        gesture.current = null;
        cancelPendingTap();
      },
      on_progress: (preview) => {
        const feedback = edge_feedback.current;
        if (feedback) {
          feedback.hidden = !preview;
          if (preview) {
            feedback.style.setProperty('--edge-swipe-progress', String(preview.progress));
            feedback.style.setProperty('--edge-swipe-y', `${preview.client_y}px`);
            feedback.dataset.ready = String(preview.ready);
          }
        }
        if (!preview && edge_swiping.current) {
          edge_swiping.current = false;
          gesture.current = null;
          cancelPendingTap();
          last_scroll_at.current = performance.now();
        }
      },
      on_complete: () => {
        // Capture the latest passage before reusing the app's Back/Close flow.
        reportLocation();
        callbacks.current.on_edge_navigation?.();
      },
    });
  }, [scroll_root, loaded, reading_active, paper.paper_id, navigation_key, reader_mode, props.viewport_key, props.edge_navigation, Boolean(props.on_edge_navigation)]);

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
      const inside_note = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.note-strip');
      if (inside_note(range.startContainer) || inside_note(range.endContainer)) {
        callbacks.current.on_selection(null);
        return;
      }
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
    link_navigation.current++;
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

  function navigate(target: ReaderTarget) {
    link_navigation.current++;
    callbacks.current.on_navigate(target);
  }

  function navigatePage(page_number: number) {
    if (!loaded) return;
    reportLocation();
    navigate({
      kind: 'pdf',
      location: { paper_id: paper.paper_id, page_number: clamp(page_number, 1, loaded.pages.length), page_position: [0, 0], zoom, zoom_mode: zoom_mode.current, rotation, reader_mode, reading_block_id: null },
    });
  }

  async function followLink(link: PdfLink, source_page: number) {
    const request_id = ++link_navigation.current;
    const isCurrent = () => request_id === link_navigation.current && loaded_ref.current?.document === loaded?.document;
    reportLocation();
    if (link.url) {
      const url = link.url;
      const reference = referenceForUrl(references, url);
      if (reference && link.rect.length) {
        navigate({ kind: 'reference', reference });
        return;
      }
      const target = classifyPaperUrl(url);
      if (target) navigate(target);
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
      if (!isCurrent()) return;
      if (!destination) throw new Error('The citation destination is missing.');
      const ref = destination[0];
      const index = typeof ref === 'number' ? ref : await loaded.document.getPageIndex(ref as { num: number; gen: number });
      if (!isCurrent()) return;
      const page = loaded.pages[index];
      if (!page) throw new Error('The citation points to an unavailable page.');
      const kind = (destination[1] as { name?: string })?.name;
      // Reading zoom is relative to each crop; a PDF's absolute XYZ scale
      // must not change it when following a section or figure link.
      const explicit_zoom = !reading && kind === 'XYZ' && typeof destination[4] === 'number' && destination[4] > 0 ? destination[4] : null;
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
        navigate({ kind: 'reference', reference });
        return;
      }
      const [viewport_x, viewport_y] = viewport.convertToViewportPoint(x, y);
      const location: ReadingLocation = {
        paper_id: paper.paper_id, page_number: index + 1,
        page_position: [clamp(viewport_x / viewport.width, 0, 1), clamp(viewport_y / viewport.height, 0, 1)],
        zoom: next_zoom, zoom_mode: next_mode, rotation, reader_mode, reading_block_id: null,
      };
      if (reading && layout) location.reading_block_id = findReadingBlock(layout, location, loaded.pages)?.block_id ?? null;
      navigate({ kind: 'pdf', location });
    } catch (failure) {
      if (isCurrent()) callbacks.current.on_error(failure instanceof Error ? failure.message : String(failure));
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
    const available_width = zoom_preview.current?.layout_width ?? scroll_root.clientWidth;
    return zoom * Math.min(760, Math.max(40, available_width - padding - 4)) / region.width;
  }

  async function toggleSplitLines(block: ReadingBlock) {
    reportLocation();
    const owns_pending_location = !pending_location.current;
    const source = pending_location.current ?? readLocation();
    if (source) pending_location.current = source;
    window.getSelection()?.removeAllRanges();
    const success = await block_preferences.setSplit(block, !block_preferences.isSplit(block));
    if (!success && owns_pending_location && pending_location.current === source) pending_location.current = null;
  }

  function locationAtElement(element: HTMLElement, position: [number, number]) {
    const page_number = Number(element.dataset.pageNumber);
    const block = reading ? layout?.blocks.find((item) => item.block_id === element.dataset.blockId) : null;
    const page = loaded?.pages[page_number - 1];
    const mapping = block ? selection_pages.current.get(block.block_id) : null;
    if (block && page && mapping?.source_point_for_position) {
      const source_point = mapping.source_point_for_position(position);
      const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const [x, y] = viewport.convertToViewportPoint(...source_point);
      return { page_number, page_position: [clamp(x / viewport.width, 0, 1), clamp(y / viewport.height, 0, 1)] as [number, number], reading_block_id: block.block_id };
    }
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
    navigate({ kind: 'pdf', location: {
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
    if (!reading_active || zoom_anchor.current || edge_swiping.current) {
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
    if (!callbacks.current.on_toggle_controls || !reading_active || edge_swiping.current) return;
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
      <div className="pdf-edge-feedback" ref={edge_feedback} hidden aria-hidden="true">
        <ChevronLeft size={18} /><span>{props.edge_navigation === 'back' ? 'Back' : 'Close'}</span>
      </div>
      <div className={`pdf-scroll${reading ? ' reading-scroll' : ''}`} ref={setScrollRoot} onScroll={handleScroll} inert={Boolean(enlarged_figure)}
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
        {reading && block_preferences.error && <div className="reading-preference-error" role="status">
          <span>{block_preferences.error}</span>{block_preferences.load_failed && <button type="button" onClick={block_preferences.retry}>Retry</button>}
        </div>}
        {loaded && (!reading || layout) && <div className={`pdf-pages ${reading ? `reading-pages ${controls_visible ? 'reading-pages-controls' : ''}` : ''}`}
          style={reading ? { '--reading-zoom': zoom } as CSSProperties : undefined}>
          {reading && layout ? layout.blocks.map((block) => <article className={`reading-block reading-block-${block.kind}`} key={`${paper.paper_id}-${block.block_id}`} data-figure-id={block.kind === 'figure' ? block.block_id : undefined}>
            <div className="reading-block-type" aria-label={`Block type: ${block_type_labels[block.block_type]}`}>{block_type_labels[block.block_type]}</div>
            <PdfPage page={loaded.pages[block.page_number - 1]} zoom={blockZoom(block)} rotation={rotation}
              source_rect={block.source_rect} block_id={block.block_id} render_paused={render_paused} scroll_root={scroll_root}
              split_lines={block.block_type === 'content' && block_preferences.isSplit(block)}
              on_split_status={on_split_status} on_layout_change={on_split_layout_change}
              annotations={matching_annotations} register_page={register_page} on_link={(link, page_number) => void followLink(link, page_number)} on_error={report_error} />
            <div className="reading-block-actions">
              <span>{(block.figure_label ? `Figure ${block.figure_label}` : null) ?? (block.kind === 'original' ? 'Original layout' : 'Source')} · p. {block.page_number}</span>
              {block.kind === 'figure' && <button type="button" aria-label={`Enlarge ${block.figure_label ? `Figure ${block.figure_label}` : 'figure'}`} onClick={() => { reportLocation(); setEnlargedFigure(block); }}><Expand size={15} /> Enlarge</button>}
              {block.block_type === 'content' && <button type="button" className="reading-source-button"
                title={block_preferences.isSplit(block) ? 'Restore original lines' : 'Split lines'}
                aria-label={`${block_preferences.isSplit(block) ? 'Restore original lines' : 'Split lines'} in block on page ${block.page_number}`}
                aria-pressed={block_preferences.isSplit(block)}
                disabled={block_preferences.loading || block_preferences.load_failed || Boolean(block_preferences.busy) || render_paused || !reading_active || split_status.get(block.block_id)?.state === 'preparing'}
                onClick={() => { void toggleSplitLines(block); }}>
                {block_preferences.busy === block.block_id || split_status.get(block.block_id)?.state === 'preparing'
                  ? <LoaderCircle size={16} className="pdf-spinner" aria-hidden="true" /> : <WrapText size={16} aria-hidden="true" />}
              </button>}
              <button type="button" className="reading-source-button" title="View in PDF" onClick={() => viewOriginal(block)} aria-label={`View ${block.figure_label ?? 'block'} in PDF on page ${block.page_number}`}><FileText size={16} aria-hidden="true" /></button>
            </div>
            {block_preferences.isSplit(block) && split_status.get(block.block_id)?.state === 'unavailable' && <p className="reading-split-status" role="status">{split_status.get(block.block_id)?.message}</p>}
            <ReferenceStrip references={block_references.get(block.block_id) ?? []} on_select={(reference) => {
              reportLocation();
              navigate({ kind: 'reference', reference });
            }} />
            {block_notes.has(block.block_id) && <aside className="note-strip" aria-label={`Notes for passage on page ${block.page_number}`}>
              {block_notes.get(block.block_id)!.map(({ annotation, anchor }) => <NoteCard key={annotation.annotation_id} annotation={annotation}
                busy={Boolean(props.annotation_busy)} pending={props.annotation_busy === annotation.annotation_id} frozen={render_paused}
                on_before_resize={preserveNoteLayout}
                edit_draft={props.on_edit_annotation ? (displayed_edit?.annotation_id === annotation.annotation_id ? displayed_edit.content : null) : undefined}
                on_edit_draft_change={props.on_edit_annotation ? (content) => props.on_edit_annotation?.(annotation, content) : undefined}
                on_update={props.on_update_annotation}
                on_delete={props.on_delete_annotation}
                on_navigate={() => { reportLocation(); props.on_navigate_annotation?.(annotation, anchor); }} />)}
            </aside>}
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
