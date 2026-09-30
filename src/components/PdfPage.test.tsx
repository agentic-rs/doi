// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { SelectionPage } from '../lib/pdf-selection';
import type { Annotation } from '../lib/types';
import { PdfPage } from './PdfPage';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  RenderingCancelledException: class extends Error {},
  TextLayer: class {
    constructor({ textContentSource, container }: { textContentSource: { items: Array<{ str: string }> }; container: HTMLElement }) {
      for (const item of textContentSource.items) {
        const span = document.createElement('span');
        span.textContent = item.str;
        container.append(span);
      }
    }
    render() { return Promise.resolve(); }
    cancel() {}
  },
}));

function pageFixture() {
  const render_page = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const text = (str: string, y: number) => ({ str, transform: [10, 0, 0, 10, 100, y], width: 90, height: 10, fontName: 'body', dir: 'ltr', hasEOL: true });
  const page = {
    pageNumber: 3, rotate: 0, userUnit: 1,
    getViewport: ({ scale, offsetX = 0, offsetY = 0 } = { scale: 1 }) => {
      const toViewport = (x: number, y: number) => [x * scale + offsetX, (800 - y) * scale + offsetY];
      return {
        width: 600 * scale, height: 800 * scale, scale, rotation: 0,
        convertToViewportPoint: toViewport,
        convertToViewportRectangle: (rect: number[]) => [...toViewport(rect[0], rect[1]), ...toViewport(rect[2], rect[3])],
        convertToPdfPoint: (x: number, y: number) => [(x - offsetX) / scale, 800 - (y - offsetY) / scale],
      } as PageViewport;
    },
    streamTextContent: () => new ReadableStream({ start(controller) {
      controller.enqueue({ items: [text('Inside crop', 450), text('Outside crop', 650)], styles: {}, lang: null });
      controller.close();
    } }),
    getAnnotations: async () => [
      { subtype: 'Link', id: 'inside', rect: [180, 430, 260, 450], url: 'https://example.com/inside' },
      { subtype: 'Link', id: 'outside', rect: [180, 630, 260, 650], url: 'https://example.com/outside' },
    ],
    render: render_page,
  } as unknown as PDFPageProxy;
  return { page, render_page };
}

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PDF region rendering', () => {
  it('allocates a highlight layer only for actual page marks and preserves their geometry', async () => {
    const { page } = pageFixture();
    const props = { page, zoom: 2, rotation: 0, render_paused: false, scroll_root: document.createElement('div'),
      register_page: vi.fn(), on_link: vi.fn(), on_error: vi.fn() };
    const mark: Annotation = {
      schema_version: 1, annotation_id: 'mark', created_at: '', updated_at: '', body: { kind: 'note', content: 'Note' },
      target: { paper_id: 'paper', pdf_hash: '', page_anchors: [{ page_number: 3, quad_points: [[100, 450, 190, 450, 190, 440, 100, 440]],
        text_quote: { exact_text: 'Inside crop', prefix: '', suffix: '', normalization_version: 1 } }] },
    };
    const view = render(<PdfPage {...props} annotations={[]} />);
    await waitFor(() => expect(props.register_page).toHaveBeenCalled());
    expect(view.container.querySelector('.pdf-highlight-layer')).toBeNull();
    view.rerender(<PdfPage {...props} annotations={[mark]} />);
    expect(view.container.querySelector('polygon')?.getAttribute('points')).toBe('200,700 380,700 380,720 200,720');
    view.rerender(<PdfPage {...props} annotations={[{ ...mark, target: { ...mark.target,
      page_anchors: [{ ...mark.target.page_anchors[0], quad_points: [] }] } }]} />);
    expect(view.container.querySelector('.pdf-highlight-layer')).toBeNull();
  });

  it('distinguishes PDF, app, and browser link hints without adding visible icons', async () => {
    const { page } = pageFixture();
    page.getAnnotations = async () => [
      { subtype: 'Link', id: 'pdf', rect: [100, 430, 120, 450], dest: [0, { name: 'Fit' }] },
      { subtype: 'Link', id: 'app', rect: [130, 430, 150, 450], url: 'https://arxiv.org/abs/1706.03762' },
      { subtype: 'Link', id: 'external', rect: [160, 430, 180, 450], url: 'https://example.com/paper' },
    ];
    render(<PdfPage page={page} zoom={1} rotation={0} render_paused={false}
      scroll_root={document.createElement('div')} annotations={[]} register_page={vi.fn()} on_link={vi.fn()} on_error={vi.fn()} />);
    const pdf = await screen.findByRole('button', { name: 'Go to destination within this paper' });
    const app = screen.getByRole('button', { name: 'Open paper in Papertrail: https://arxiv.org/abs/1706.03762' });
    const external = screen.getByRole('button', { name: 'Open in browser: https://example.com/paper' });
    expect([pdf.dataset.linkKind, app.dataset.linkKind, external.dataset.linkKind]).toEqual(['pdf', 'app', 'external']);
    expect([pdf.title, app.title, external.title]).toEqual([
      'Within this paper', 'Open paper in Papertrail: https://arxiv.org/abs/1706.03762', 'Open in browser: https://example.com/paper',
    ]);
    expect([pdf.childElementCount, app.childElementCount, external.childElementCount]).toEqual([0, 0, 0]);
  });

  it('renders only the crop canvas and registers matching source coordinates and text', async () => {
    const { page, render_page } = pageFixture();
    const register_page = vi.fn<(id: string, selection: SelectionPage | null) => void>();
    const result = render(<PdfPage page={page} source_rect={[80, 400, 220, 500]} block_id="p3-figure1" zoom={2} rotation={0}
      render_paused={false} scroll_root={document.createElement('div')} annotations={[]}
      register_page={register_page} on_link={vi.fn()} on_error={vi.fn()} />);
    await waitFor(() => expect(register_page).toHaveBeenCalledWith('p3-figure1', expect.any(Object)));
    const selection = register_page.mock.calls.find(([, value]) => value)?.[1];
    expect(selection?.text).toBe('Inside crop\n');
    expect(selection?.viewport.convertToPdfPoint(40, 100)).toEqual([100, 450]);
    expect(result.container.querySelector('.textLayer')?.textContent).toBe('Inside crop');
    const canvas = result.container.querySelector('canvas');
    expect([canvas?.width, canvas?.height]).toEqual([280, 200]);
    const viewport = (render_page.mock.calls[0] as unknown as [{ viewport: PageViewport }])[0].viewport;
    expect(viewport.convertToViewportPoint(100, 450)).toEqual([40, 100]);
    const link = screen.getByRole('button', { name: 'Open in browser: https://example.com/inside' });
    expect([link.style.left, link.style.top, link.style.width, link.style.height]).toEqual(['200px', '100px', '80px', '40px']);
    expect(screen.queryByRole('button', { name: 'Open in browser: https://example.com/outside' })).toBeNull();
    expect(result.container.querySelector('.pdf-page-label')).toBeNull();
  });
});
