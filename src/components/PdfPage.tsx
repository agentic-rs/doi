import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { RenderingCancelledException, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Annotation, PdfSourceRect } from '../lib/types';
import { quadToSvgPoints, safeReferenceUrl } from '../lib/pdf-geometry';
import { regionGeometry, regionTextContent } from '../lib/pdf-region';
import type { SelectionPage } from '../lib/pdf-selection';
import { pdfContentText } from '../lib/pdf-text';
import { readPdfTextContent } from '../lib/pdf-compatibility';
import { classifyPaperUrl } from '../lib/paper-links';
import { createSplitTextLayer, prepareSplitPdfText } from '../lib/pdf-split-text';
import type { PreparedSplitText } from '../lib/pdf-split-text';
import { mapSplitDisplayPoint, mapSplitSourcePoint, mapSplitSourceRect, refineSplitLineCuts, splitLineInkCovered } from '../lib/pdf-line-layout';
import type { SplitLineRect } from '../lib/pdf-line-layout';

export interface PdfLink {
  link_id: string;
  rect: number[];
  url: string | null;
  destination: string | unknown[] | null;
  action: string | null;
}

export interface PdfPageProps {
  page: PDFPageProxy;
  source_rect?: PdfSourceRect;
  block_id?: string;
  split_lines?: boolean;
  on_split_status?: (block_id: string, status: 'preparing' | 'ready' | 'unavailable', message?: string) => void;
  on_layout_change?: () => void;
  zoom: number;
  rotation: number;
  render_paused: boolean;
  scroll_root: HTMLDivElement | null;
  annotations: Annotation[];
  register_page: (region_id: string, data: SelectionPage | null) => void;
  on_link: (link: PdfLink, page_number: number) => void;
  on_error: (message: string) => void;
}

type PageData = [Awaited<ReturnType<PDFPageProxy['getTextContent']>>, Awaited<ReturnType<PDFPageProxy['getAnnotations']>>];
const page_data_cache = new WeakMap<PDFPageProxy, Promise<PageData>>();

function readPageData(page: PDFPageProxy): Promise<PageData> {
  const cached = page_data_cache.get(page);
  if (cached) return cached;
  // Reordered blocks on the same page share text and link extraction.
  const task = Promise.all([readPdfTextContent(page), page.getAnnotations({ intent: 'display' })]).catch((error: unknown) => {
    page_data_cache.delete(page);
    throw error;
  });
  page_data_cache.set(page, task);
  return task;
}

export function PdfPage({ page, source_rect, block_id, split_lines = false, on_split_status, on_layout_change,
  zoom, rotation, render_paused, scroll_root, annotations, register_page, on_link, on_error }: PdfPageProps) {
  const page_ref = useRef<HTMLDivElement>(null);
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const text_ref = useRef<HTMLDivElement>(null);
  const completed_page = useRef<SelectionPage | null>(null);
  const was_split_rendered = useRef(false);
  const split_preparing_anchor = useRef(false);
  const refined_preparations = useRef(new WeakSet<PreparedSplitText>());
  const [visible, setVisible] = useState(!source_rect && page.pageNumber <= 2);
  const [rendered_viewport, setRenderedViewport] = useState<PageViewport | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const split_callbacks = useRef({ on_split_status, on_layout_change });
  split_callbacks.current = { on_split_status, on_layout_change };
  const [split_result, setSplitResult] = useState<{ page: PDFPageProxy; source_key: string; prepared: PreparedSplitText | null } | null>(null);
  const source_key = source_rect?.join(',') ?? '';
  const split_eligible = split_lines && !!source_rect && !!block_id && page.rotate % 360 === 0 && rotation % 360 === 0;
  const current_result = split_result?.page === page && split_result.source_key === source_key ? split_result : null;
  const prepared = split_eligible ? current_result?.prepared ?? null : null;
  const split_pending = split_eligible && !current_result;
  const original_geometry = useMemo(() => regionGeometry(page, zoom, rotation, source_rect), [page, zoom, rotation, source_rect]);
  const source_zoom = prepared ? original_geometry.width / prepared.layout.width : zoom;
  const has_prepared = !!prepared;
  const geometry = useMemo(() => has_prepared ? regionGeometry(page, source_zoom, rotation, source_rect) : original_geometry,
    [page, source_zoom, rotation, source_rect, original_geometry, has_prepared]);
  const { viewport, render_viewport, left: crop_left, top: crop_top } = geometry;
  const width = prepared ? prepared.layout.width * source_zoom : geometry.width;
  const height = prepared ? prepared.layout.height * source_zoom : geometry.height;
  const region_id = block_id ?? String(page.pageNumber);
  const read_page_data = useMemo(() => {
    let task: ReturnType<typeof readPageData> | null = null;
    return () => task ??= readPageData(page).catch((error: unknown) => {
      task = null;
      throw error;
    });
  }, [page]);

  useEffect(() => {
    const element = page_ref.current;
    if (!element || !scroll_root || render_paused) return;
    let observing = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (observing && entry && !scroll_root.hasAttribute('data-zoom-preview')) setVisible(entry.isIntersecting);
    }, {
      root: scroll_root,
      rootMargin: '1000px 600px',
    });
    observer.observe(element);
    return () => { observing = false; observer.disconnect(); };
  }, [scroll_root, render_paused]);

  useEffect(() => {
    if (!split_lines) {
      if (split_result?.prepared) split_callbacks.current.on_layout_change?.();
      setSplitResult(null);
      return;
    }
    if (!visible || render_paused || !source_rect || !block_id || !page_ref.current) return;
    if (!split_eligible) {
      if (was_split_rendered.current) split_callbacks.current.on_layout_change?.();
      split_callbacks.current.on_split_status?.(block_id, 'unavailable', page.rotate % 360 !== 0
        ? 'This PDF page is rotated; split lines is unavailable.' : 'Set the page rotation to 0° to split lines.');
      return;
    }
    if (current_result) return;
    let disposed = false;
    split_preparing_anchor.current = true;
    split_callbacks.current.on_split_status?.(block_id, 'preparing');
    void prepareSplitPdfText(page, source_rect, page_ref.current).then((value) => {
      if (disposed) return;
      split_callbacks.current.on_layout_change?.();
      setSplitResult({ page, source_key, prepared: value });
    }).catch((error: unknown) => {
      if (disposed) return;
      setSplitResult({ page, source_key, prepared: null });
      split_callbacks.current.on_split_status?.(block_id, 'unavailable', error instanceof Error ? error.message : 'This block cannot be split safely.');
    });
    return () => { disposed = true; };
  }, [page, source_key, source_rect, block_id, split_lines, split_eligible, visible, render_paused, current_result, split_result]);

  useEffect(() => {
    if (render_paused || split_pending) return;
    let disposed = false;
    let render_task: RenderTask | undefined;
    let text_layer: TextLayer | undefined;
    const canvas = canvas_ref.current;
    const text_element = text_ref.current;
    const page_element = page_ref.current;
    function notifyLayoutReady() {
      const notify_layout = !!prepared || was_split_rendered.current || split_preparing_anchor.current;
      was_split_rendered.current = !!prepared;
      split_preparing_anchor.current = false;
      if (notify_layout) split_callbacks.current.on_layout_change?.();
      if (prepared && block_id) split_callbacks.current.on_split_status?.(block_id, 'ready');
    }
    if (!visible || !canvas || !text_element || !page_element) {
      completed_page.current = null;
      setRenderedViewport(null);
      return;
    }
    // A dismissed or unmoved pinch can reuse its already finished page.
    if (completed_page.current?.viewport === render_viewport && text_element.contains(completed_page.current.text_layer)) {
      register_page(region_id, completed_page.current);
      notifyLayoutReady();
      return () => register_page(region_id, null);
    }
    setLinks([]);
    // Keep the last finished bitmap visible while PDF.js draws the new scale.
    // A cancelled render must never clear or overwrite the visible canvas.
    const buffer = document.createElement('canvas');
    const text_buffer = document.createElement('div');
    function releaseBuffer() {
      buffer.width = 0;
      buffer.height = 0;
    }

    async function renderPage() {
      // Restrict canvas memory on high DPI displays and very large pages.
      const pixel_ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / Math.max(width * height, geometry.width * geometry.height)));
      buffer.width = Math.max(1, Math.floor(geometry.width * pixel_ratio));
      buffer.height = Math.max(1, Math.floor(geometry.height * pixel_ratio));
      render_task = page.render({ canvas: buffer, viewport: render_viewport, transform: [pixel_ratio, 0, 0, pixel_ratio, 0, 0] });
      // Cancellation can precede text extraction finishing. Mark the render
      // rejection handled immediately, then surface it in the combined await.
      void render_task.promise.catch(() => undefined);
      const [content, embedded_annotations] = await read_page_data();
      if (disposed) return;
      const region_content = source_rect ? regionTextContent(content, source_rect) : content;
      if (!prepared) text_layer = new TextLayer({ textContentSource: region_content, container: text_buffer, viewport });
      await Promise.all([render_task.promise, text_layer?.render()]);
      if (disposed) return;
      let final_prepared = prepared;
      if (prepared) {
        const source_context = buffer.getContext('2d');
        if (source_context?.getImageData) {
          const raster = source_context.getImageData(0, 0, buffer.width, buffer.height);
          const refined = refineSplitLineCuts(prepared.layout, raster, source_zoom * pixel_ratio);
          if (!refined || (refined !== prepared.layout && refined_preparations.current.has(prepared))) {
            throw new Error('A line break would cut through printed text. Its original lines are kept.');
          }
          if (!splitLineInkCovered(refined, raster, source_zoom * pixel_ratio)) {
            throw new Error('The printed content could not be split without clipping. Its original lines are kept.');
          }
          final_prepared = refined === prepared.layout ? prepared : { ...prepared, layout: refined };
          refined_preparations.current.add(final_prepared);
          if (refined.width !== prepared.layout.width) {
            // A corrected gutter can make one half slightly wider. Refine at
            // most once, then render the crop at its final fitting scale.
            split_callbacks.current.on_layout_change?.();
            setSplitResult({ page, source_key, prepared: final_prepared });
            return;
          }
        }
      }
      const split_text = final_prepared ? createSplitTextLayer(final_prepared, source_zoom) : null;
      const context = canvas!.getContext('2d');
      if (!context) throw new Error('A canvas drawing context is unavailable.');
      canvas!.width = Math.max(1, Math.floor(width * pixel_ratio));
      canvas!.height = Math.max(1, Math.floor(height * pixel_ratio));
      if (final_prepared) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas!.width, canvas!.height);
        const raster_scale = source_zoom * pixel_ratio;
        for (const piece of final_prepared.layout.pieces) {
          const [left, top, right, bottom] = piece.source_rect;
          const [display_left, display_top] = piece.display_rect;
          context.drawImage(buffer, left * raster_scale, top * raster_scale, (right - left) * raster_scale, (bottom - top) * raster_scale,
            display_left * raster_scale, display_top * raster_scale, (right - left) * raster_scale, (bottom - top) * raster_scale);
        }
      } else context.drawImage(buffer, 0, 0);
      let selection_element = text_element!;
      if (split_text) {
        text_element!.style.cssText = '';
        text_element!.removeAttribute('data-main-rotation');
        text_element!.replaceChildren(split_text.element);
        selection_element = split_text.element;
      } else {
        // PDF.js writes scale/rotation metadata as well as text nodes.
        text_element!.style.cssText = text_buffer.style.cssText;
        const text_rotation = text_buffer.getAttribute('data-main-rotation');
        if (text_rotation === null) text_element!.removeAttribute('data-main-rotation');
        else text_element!.setAttribute('data-main-rotation', text_rotation);
        text_element!.replaceChildren(...text_buffer.childNodes);
      }
      const selection_page: SelectionPage = {
        page_number: page.pageNumber,
        page_element: page_element!,
        text_layer: selection_element,
        viewport: render_viewport,
        text: final_prepared?.text ?? pdfContentText(region_content),
        ...(final_prepared && split_text ? {
          quads_for_range: split_text.quads_for_range,
          source_point_for_position: (position: [number, number]): [number, number] => {
            const point = mapSplitDisplayPoint(final_prepared.layout, [position[0] * final_prepared.layout.width, position[1] * final_prepared.layout.height]) ?? [0, 0];
            return final_prepared.viewport.convertToPdfPoint(point[0], point[1]) as [number, number];
          },
          position_for_source_point: (point: [number, number]): [number, number] => {
            const source = final_prepared.viewport.convertToViewportPoint(point[0], point[1]) as [number, number];
            const display = mapSplitSourcePoint(final_prepared.layout, source) ?? [0, 0];
            return [display[0] / final_prepared.layout.width, display[1] / final_prepared.layout.height];
          },
        } : {}),
      };
      completed_page.current = selection_page;
      register_page(region_id, selection_page);
      setLinks(embedded_annotations.filter((annotation) => annotation.subtype === 'Link' && Array.isArray(annotation.rect))
        .map((annotation) => ({
          link_id: String(annotation.id),
          rect: annotation.rect as number[],
          url: typeof annotation.url === 'string' ? safeReferenceUrl(annotation.url) : null,
          destination: typeof annotation.dest === 'string' || Array.isArray(annotation.dest) ? annotation.dest : null,
          action: typeof annotation.action === 'string' ? annotation.action : null,
        }))
        .filter((link) => link.url || link.destination || link.action));
      setRenderedViewport(render_viewport);
      if (final_prepared !== prepared) setSplitResult({ page, source_key, prepared: final_prepared });
      notifyLayoutReady();
    }

    void renderPage().catch(async (error: unknown) => {
      render_task?.cancel();
      await render_task?.promise.catch(() => undefined);
      if (!disposed && !(error instanceof RenderingCancelledException)) {
        if (prepared && block_id) {
          split_callbacks.current.on_layout_change?.();
          setSplitResult({ page, source_key, prepared: null });
          split_callbacks.current.on_split_status?.(block_id, 'unavailable', `Split lines could not be displayed: ${error instanceof Error ? error.message : String(error)}`);
        } else on_error(`Page ${page.pageNumber} could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).finally(async () => {
      // Even cancellation settles asynchronously. Release the staging bitmap
      // only after PDF.js has stopped using its drawing context.
      await render_task?.promise.catch(() => undefined);
      releaseBuffer();
    });
    return () => {
      disposed = true;
      register_page(region_id, null);
      render_task?.cancel();
      // Text extraction may still be pending. Do not retain cancelled bitmaps
      // until it finishes when a rapid pinch starts another render each frame.
      if (render_task) void render_task.promise.then(releaseBuffer, releaseBuffer);
      else releaseBuffer();
      text_layer?.cancel();
    };
  }, [page, region_id, visible, viewport, render_viewport, width, height, geometry, source_rect, source_key, source_zoom,
    prepared, split_pending, block_id, render_paused, read_page_data, register_page, on_error]);

  const page_annotations = annotations.flatMap((annotation) => annotation.target.page_anchors
    .filter((anchor) => anchor.page_number === page.pageNumber && anchor.quad_points.length > 0)
    .map((anchor, anchor_index) => ({ annotation, anchor, anchor_index })));

  function displayRects(pdf_rect: number[]): SplitLineRect[] {
    const rect = (prepared?.viewport ?? render_viewport).convertToViewportRectangle(pdf_rect);
    const source: SplitLineRect = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    return prepared ? mapSplitSourceRect(prepared.layout, source).map((part) => part.map((value) => value * source_zoom) as SplitLineRect) : [source];
  }

  return (
    <div className="pdf-page-wrap">
      <div
        className="pdf-page"
        data-page-number={page.pageNumber}
        data-block-id={block_id}
        data-split-preparing={split_pending || (prepared && rendered_viewport !== render_viewport) ? 'true' : undefined}
        ref={page_ref}
        style={{ width, height, overflow: source_rect ? 'hidden' : undefined, '--total-scale-factor': viewport.scale * page.userUnit } as CSSProperties}
        aria-label={`Page ${page.pageNumber}`}
      >
        {visible && <>
          <canvas ref={canvas_ref} className="pdf-page-canvas" aria-hidden="true" />
          {source_rect && !prepared ? (
            <div style={{ position: 'absolute', left: -crop_left, top: -crop_top, width: viewport.width, height: viewport.height }}>
              <div className="textLayer" ref={text_ref} hidden={render_paused || rendered_viewport !== render_viewport} />
            </div>
          ) : <div className="textLayer" ref={text_ref} hidden={render_paused || rendered_viewport !== render_viewport} />}
          {page_annotations.length > 0 && <svg className="pdf-highlight-layer" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {page_annotations.flatMap(({ annotation, anchor, anchor_index }) => anchor.quad_points.flatMap((quad, index) => {
              const points = prepared ? displayRects([
                Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]),
                Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7]),
              ]).map(([left, top, right, bottom]) => `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`)
                : [quadToSvgPoints(quad, render_viewport)];
              return points.map((value, part_index) => <polygon
                key={`${annotation.annotation_id}-${anchor_index}-${index}-${part_index}`}
                points={value}
                className={annotation.body.kind === 'ai_answer' ? 'pdf-highlight-ai' : 'pdf-highlight-note'}
              />);
            }))}
          </svg>}
          <div className="pdf-link-layer">
            {links.flatMap((link) => displayRects(link.rect).map((rect, part_index) => {
              const left = Math.max(0, rect[0]);
              const top = Math.max(0, rect[1]);
              const right = Math.min(width, rect[2]);
              const bottom = Math.min(height, rect[3]);
              if (right <= left || bottom <= top) return null;
              const target = link.url ? classifyPaperUrl(link.url) : null;
              const link_kind = target?.kind ?? 'pdf';
              const title = target?.kind === 'app' ? 'Open paper in Papertrail'
                : target?.kind === 'external' ? 'Open in browser' : 'Within this paper';
              return (
                <button
                  key={`${link.link_id}-${part_index}`}
                  type="button"
                  className="pdf-embedded-link"
                  data-link-kind={link_kind}
                  disabled={render_paused}
                  style={{ left, top, width: right - left, height: bottom - top }}
                  title={target ? `${title}: ${target.url}` : title}
                  aria-label={target ? `${title}: ${target.url}` : 'Go to destination within this paper'}
                  onClick={() => on_link(link, page.pageNumber)}
                />
              );
            }))}
          </div>
        </>}
        {!rendered_viewport && <div className="pdf-page-placeholder" aria-hidden="true">{visible ? 'Rendering page…' : `Page ${page.pageNumber}`}</div>}
      </div>
      {!source_rect && <span className="pdf-page-label" aria-hidden="true">{page.pageNumber}</span>}
    </div>
  );
}
