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

export function PdfPage({ page, source_rect, block_id, zoom, rotation, render_paused, scroll_root, annotations, register_page, on_link, on_error }: PdfPageProps) {
  const page_ref = useRef<HTMLDivElement>(null);
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const text_ref = useRef<HTMLDivElement>(null);
  const completed_page = useRef<SelectionPage | null>(null);
  const [visible, setVisible] = useState(!source_rect && page.pageNumber <= 2);
  const [rendered_viewport, setRenderedViewport] = useState<PageViewport | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const geometry = useMemo(() => regionGeometry(page, zoom, rotation, source_rect), [page, zoom, rotation, source_rect]);
  const { viewport, render_viewport, left: crop_left, top: crop_top, width, height } = geometry;
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
    if (render_paused) return;
    let disposed = false;
    let render_task: RenderTask | undefined;
    let text_layer: TextLayer | undefined;
    const canvas = canvas_ref.current;
    const text_element = text_ref.current;
    const page_element = page_ref.current;
    if (!visible || !canvas || !text_element || !page_element) {
      completed_page.current = null;
      setRenderedViewport(null);
      return;
    }
    // A dismissed or unmoved pinch can reuse its already finished page.
    if (completed_page.current?.viewport === render_viewport) {
      register_page(region_id, completed_page.current);
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
      const pixel_ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (width * height)));
      buffer.width = Math.max(1, Math.floor(width * pixel_ratio));
      buffer.height = Math.max(1, Math.floor(height * pixel_ratio));
      render_task = page.render({ canvas: buffer, viewport: render_viewport, transform: [pixel_ratio, 0, 0, pixel_ratio, 0, 0] });
      // Cancellation can precede text extraction finishing. Mark the render
      // rejection handled immediately, then surface it in the combined await.
      void render_task.promise.catch(() => undefined);
      const [content, embedded_annotations] = await read_page_data();
      if (disposed) return;
      const region_content = source_rect ? regionTextContent(content, source_rect) : content;
      text_layer = new TextLayer({ textContentSource: region_content, container: text_buffer, viewport });
      await Promise.all([render_task.promise, text_layer.render()]);
      if (disposed) return;
      const context = canvas!.getContext('2d');
      if (!context) throw new Error('A canvas drawing context is unavailable.');
      canvas!.width = buffer.width;
      canvas!.height = buffer.height;
      context.drawImage(buffer, 0, 0);
      // PDF.js writes scale/rotation metadata as well as text nodes.
      text_element!.style.cssText = text_buffer.style.cssText;
      const text_rotation = text_buffer.getAttribute('data-main-rotation');
      if (text_rotation === null) text_element!.removeAttribute('data-main-rotation');
      else text_element!.setAttribute('data-main-rotation', text_rotation);
      text_element!.replaceChildren(...text_buffer.childNodes);
      const selection_page = {
        page_number: page.pageNumber,
        page_element: page_element!,
        text_layer: text_element!,
        viewport: render_viewport,
        text: pdfContentText(region_content),
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
    }

    void renderPage().catch(async (error: unknown) => {
      render_task?.cancel();
      await render_task?.promise.catch(() => undefined);
      if (!disposed && !(error instanceof RenderingCancelledException)) {
        on_error(`Page ${page.pageNumber} could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
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
  }, [page, region_id, visible, viewport, render_viewport, width, height, source_rect, render_paused, read_page_data, register_page, on_error]);

  const page_annotations = annotations.flatMap((annotation) => annotation.target.page_anchors
    .filter((anchor) => anchor.page_number === page.pageNumber && anchor.quad_points.length > 0)
    .map((anchor, anchor_index) => ({ annotation, anchor, anchor_index })));

  return (
    <div className="pdf-page-wrap">
      <div
        className="pdf-page"
        data-page-number={page.pageNumber}
        data-block-id={block_id}
        ref={page_ref}
        style={{ width, height, overflow: source_rect ? 'hidden' : undefined, '--total-scale-factor': viewport.scale * page.userUnit } as CSSProperties}
        aria-label={`Page ${page.pageNumber}`}
      >
        {visible && <>
          <canvas ref={canvas_ref} className="pdf-page-canvas" aria-hidden="true" />
          {source_rect ? (
            <div style={{ position: 'absolute', left: -crop_left, top: -crop_top, width: viewport.width, height: viewport.height }}>
              <div className="textLayer" ref={text_ref} hidden={render_paused || rendered_viewport !== render_viewport} />
            </div>
          ) : <div className="textLayer" ref={text_ref} hidden={render_paused || rendered_viewport !== render_viewport} />}
          {page_annotations.length > 0 && <svg className="pdf-highlight-layer" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {page_annotations.flatMap(({ annotation, anchor, anchor_index }) => anchor.quad_points.map((quad, index) => (
              <polygon
                key={`${annotation.annotation_id}-${anchor_index}-${index}`}
                points={quadToSvgPoints(quad, render_viewport)}
                className={annotation.body.kind === 'ai_answer' ? 'pdf-highlight-ai' : 'pdf-highlight-note'}
              />
            )))}
          </svg>}
          <div className="pdf-link-layer">
            {links.map((link) => {
              const rect = render_viewport.convertToViewportRectangle(link.rect);
              const left = Math.max(0, Math.min(rect[0], rect[2]));
              const top = Math.max(0, Math.min(rect[1], rect[3]));
              const right = Math.min(width, Math.max(rect[0], rect[2]));
              const bottom = Math.min(height, Math.max(rect[1], rect[3]));
              if (right <= left || bottom <= top) return null;
              const target = link.url ? classifyPaperUrl(link.url) : null;
              const link_kind = target?.kind ?? 'pdf';
              const title = target?.kind === 'app' ? 'Open paper in Papertrail'
                : target?.kind === 'external' ? 'Open in browser' : 'Within this paper';
              return (
                <button
                  key={link.link_id}
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
            })}
          </div>
        </>}
        {!rendered_viewport && <div className="pdf-page-placeholder" aria-hidden="true">{visible ? 'Rendering page…' : `Page ${page.pageNumber}`}</div>}
      </div>
      {!source_rect && <span className="pdf-page-label" aria-hidden="true">{page.pageNumber}</span>}
    </div>
  );
}
