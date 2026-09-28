import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText, Minus, Plus, X } from 'lucide-react';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Annotation, ReadingBlock } from '../lib/types';
import { PdfPage } from './PdfPage';
import type { PdfLink } from './PdfPage';
import { regionGeometry } from '../lib/pdf-region';
import { clamp } from '../lib/pdf-geometry';
import { attachPdfZoomGestures } from '../lib/pdf-zoom-gestures';
import type { PdfZoomPoint } from '../lib/pdf-zoom-gestures';

interface FigureDialogProps {
  block: ReadingBlock;
  page: PDFPageProxy;
  annotations: Annotation[];
  on_close: () => void;
  on_source: () => void;
  on_link: (link: PdfLink, page_number: number) => void;
  on_error: (message: string) => void;
}

const ignoreRegistration = () => {};

interface FigureAnchor {
  position: [number, number];
  view_point: [number, number];
}

interface FigurePreview {
  wrapper: HTMLElement;
  origin: PdfZoomPoint;
  start: PdfZoomPoint;
  point: PdfZoomPoint;
  anchor: FigureAnchor;
  anchor_offset: [number, number];
  base_zoom: number;
  zoom: number;
}

export function FigureDialog(props: FigureDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scroll_root, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [render_paused, setRenderPaused] = useState(false);
  const [view_revision, setViewRevision] = useState(0);
  const zoom_ref = useRef(zoom);
  zoom_ref.current = zoom;
  const size_ref = useRef(size);
  size_ref.current = size;
  const preview = useRef<FigurePreview | null>(null);
  const pending_anchor = useRef<FigureAnchor | null>(null);
  const center_position = useRef<[number, number] | null>(null);
  const detach_gestures = useRef<(() => void) | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const source = useMemo(() => regionGeometry(props.page, 1, 0, props.block.source_rect), [props.page, props.block]);
  const fit_scale = Math.min(Math.min(size.width, 1100) / source.width, size.height / source.height);

  function clearPreview() {
    const current = preview.current;
    current?.wrapper.style.removeProperty('transform');
    current?.wrapper.removeAttribute('data-zoom-preview-page');
    scroll_root?.removeAttribute('data-zoom-preview');
    preview.current = null;
  }

  function captureAnchor(point: PdfZoomPoint): FigureAnchor | null {
    const page = scroll_root?.querySelector<HTMLElement>('.pdf-page');
    if (!scroll_root || !page) return null;
    const bounds = page.getBoundingClientRect();
    const root = scroll_root.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      position: [clamp((point.client_x - bounds.left) / bounds.width, 0, 1), clamp((point.client_y - bounds.top) / bounds.height, 0, 1)],
      view_point: [point.client_x - root.left, point.client_y - root.top],
    };
  }

  function changeZoom(next_zoom: number) {
    if (!scroll_root) return;
    detach_gestures.current?.();
    detach_gestures.current = null;
    clearPreview();
    const root = scroll_root.getBoundingClientRect();
    pending_anchor.current = captureAnchor({ client_x: root.left + scroll_root.clientWidth / 2, client_y: root.top + scroll_root.clientHeight / 2 });
    setRenderPaused(false);
    setZoom(clamp(next_zoom, 1, 4));
    setViewRevision((value) => value + 1);
  }

  function rememberCenter() {
    if (!scroll_root || preview.current || scroll_root.clientWidth !== size_ref.current.width + 32
      || scroll_root.clientHeight !== size_ref.current.height + 32) return;
    const root = scroll_root.getBoundingClientRect();
    const anchor = captureAnchor({ client_x: root.left + scroll_root.clientWidth / 2, client_y: root.top + scroll_root.clientHeight / 2 });
    center_position.current = anchor?.position ?? null;
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { previous?.focus(); };
  }, []);
  useLayoutEffect(() => {
    if (!scroll_root) return;
    const update = () => {
      const next = { width: Math.max(40, scroll_root.clientWidth - 32), height: Math.max(40, scroll_root.clientHeight - 32) };
      const previous = size_ref.current;
      if (next.width === previous.width && next.height === previous.height) return;
      detach_gestures.current?.();
      detach_gestures.current = null;
      clearPreview();
      if (center_position.current) {
        // Auto-centering can shift the figure before ResizeObserver runs.
        // Restore the point recorded before that layout change.
        pending_anchor.current = { position: center_position.current, view_point: [scroll_root.clientWidth / 2, scroll_root.clientHeight / 2] };
      }
      setRenderPaused(false);
      size_ref.current = next;
      setSize(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll_root);
    return () => observer.disconnect();
  }, [scroll_root]);

  useLayoutEffect(() => {
    const anchor = pending_anchor.current;
    if (!scroll_root) return;
    if (!anchor) { rememberCenter(); return; }
    clearPreview();
    const page = scroll_root.querySelector<HTMLElement>('.pdf-page');
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    const root = scroll_root.getBoundingClientRect();
    scroll_root.scrollTo({
      left: Math.max(0, scroll_root.scrollLeft + bounds.left - root.left + anchor.position[0] * bounds.width - anchor.view_point[0]),
      top: Math.max(0, scroll_root.scrollTop + bounds.top - root.top + anchor.position[1] * bounds.height - anchor.view_point[1]),
      behavior: 'instant',
    });
    pending_anchor.current = null;
    rememberCenter();
  }, [scroll_root, fit_scale, zoom, view_revision, size.width, size.height]);

  useEffect(() => {
    if (!scroll_root || !size.width || !size.height) return;
    const detach = attachPdfZoomGestures(scroll_root, {
      get_zoom: () => preview.current?.zoom ?? zoom_ref.current,
      minimum_zoom: 1,
      maximum_zoom: 4,
      on_start: (point) => {
        const wrapper = scroll_root.querySelector<HTMLElement>('.pdf-page-wrap');
        const page = wrapper?.querySelector<HTMLElement>('.pdf-page');
        const anchor = captureAnchor(point);
        if (!wrapper || !page || !anchor) return false;
        const bounds = page.getBoundingClientRect();
        const origin = wrapper.getBoundingClientRect();
        preview.current = {
          wrapper, origin: { client_x: origin.left, client_y: origin.top }, start: point, point, anchor,
          anchor_offset: [clamp(point.client_x, bounds.left, bounds.right) - point.client_x, clamp(point.client_y, bounds.top, bounds.bottom) - point.client_y],
          base_zoom: zoom_ref.current, zoom: zoom_ref.current,
        };
        scroll_root.setAttribute('data-zoom-preview', 'true');
        wrapper.setAttribute('data-zoom-preview-page', 'true');
        const selected = window.getSelection();
        if (selected?.anchorNode && scroll_root.contains(selected.anchorNode)) selected.removeAllRanges();
        setRenderPaused(true);
        return true;
      },
      on_zoom: (next_zoom, point) => {
        const current = preview.current;
        if (!current) return;
        current.zoom = next_zoom;
        current.point = point;
        const scale = next_zoom / current.base_zoom;
        const x = point.client_x - current.origin.client_x - scale * (current.start.client_x - current.origin.client_x);
        const y = point.client_y - current.origin.client_y - scale * (current.start.client_y - current.origin.client_y);
        current.wrapper.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      },
      on_end: (cancelled) => {
        const current = preview.current;
        if (cancelled || !current) {
          clearPreview();
          setRenderPaused(false);
          return;
        }
        const root = scroll_root.getBoundingClientRect();
        const scale = current.zoom / current.base_zoom;
        pending_anchor.current = { position: current.anchor.position, view_point: [
          current.point.client_x - root.left + current.anchor_offset[0] * scale,
          current.point.client_y - root.top + current.anchor_offset[1] * scale,
        ] };
        setZoom(current.zoom);
        setRenderPaused(false);
        setViewRevision((value) => value + 1);
      },
    });
    detach_gestures.current = detach;
    return () => {
      detach();
      if (detach_gestures.current === detach) detach_gestures.current = null;
      clearPreview();
    };
  }, [scroll_root, size.width, size.height, view_revision]);

  return <dialog ref={dialog} className="figure-dialog" aria-label={`${props.block.figure_label ? `Figure ${props.block.figure_label}` : 'Figure'} enlarged`} onCancel={(event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks.current.on_close();
  }}>
    <div className="figure-dialog-toolbar">
      <strong>{props.block.figure_label ? `Figure ${props.block.figure_label}` : 'Figure'} <small>· p. {props.block.page_number}</small></strong>
      <button type="button" aria-label="Zoom out figure" disabled={zoom <= 1} onClick={() => changeZoom(zoom - 0.5)}><Minus size={18} /></button>
      <button type="button" aria-label="Zoom in figure" disabled={zoom >= 4} onClick={() => changeZoom(zoom + 0.5)}><Plus size={18} /></button>
      <button type="button" aria-label="View in PDF" title="View in PDF" onClick={props.on_source}><FileText size={18} /></button>
      <button type="button" autoFocus aria-label="Close enlarged figure" onClick={props.on_close}><X size={20} /></button>
    </div>
    <div className="figure-dialog-scroll" ref={setScrollRoot} onScroll={rememberCenter} tabIndex={0} aria-label="Enlarged figure">
      {size.width > 0 && size.height > 0 && <PdfPage page={props.page} zoom={fit_scale * zoom} rotation={0} source_rect={props.block.source_rect}
        block_id={`enlarged-${props.block.block_id}`} render_paused={render_paused} scroll_root={scroll_root} annotations={props.annotations}
        register_page={ignoreRegistration} on_link={props.on_link} on_error={props.on_error} />}
    </div>
  </dialog>;
}
