// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceItem } from '../lib/types';
import { ReferenceStrip } from './ReferenceStrip';

const reference: ReferenceItem = {
  reference_id: 'reference-8-1', label: 'Smi20', citation_text: '[Smi20] J. Smith. 2020. A useful paper. Example journal.',
  title: 'A useful paper', authors: ['J. Smith'], publication_year: '2020', venue: 'Example journal, 18(4):1817–1853',
  parse_confidence: 'parsed', page_number: 8, source_rect: null, arxiv_id: null, doi: null, url: null,
};

afterEach(cleanup);

describe('block reference summaries', () => {
  it('preserves printed labels and forwards the exact reference for details', () => {
    const select = vi.fn();
    const view = render(<ReferenceStrip references={[reference]} on_select={select} />);
    expect(screen.getByRole('complementary', { name: 'References for this passage' })).toBeTruthy();
    expect(screen.getByText('Smi20')).toBeTruthy();
    expect(screen.getByText('J. Smith · 2020 · Example journal')).toBeTruthy();
    expect(screen.queryByText(/1817/)).toBeNull();
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reference Smi20: A useful paper' }));
    expect(select).toHaveBeenCalledWith(reference);
    view.rerender(<ReferenceStrip references={[{ ...reference, arxiv_id: '1706.03762v2' }]} on_select={select} />);
    expect(screen.getByText('J. Smith · 2020 · arxiv:1706.03762v2')).toBeTruthy();
    expect(screen.queryByText(/Example journal/)).toBeNull();
    view.rerender(<ReferenceStrip references={[{ ...reference, venue: null }]} on_select={select} />);
    expect(screen.getByText('J. Smith · 2020')).toBeTruthy();
    view.rerender(<ReferenceStrip references={[{ ...reference, authors: [], publication_year: null }]} on_select={select} />);
    expect(screen.getByText('Example journal')).toBeTruthy();
  });

  it('uses raw text for uncertain references without inventing a numeric label', () => {
    const raw = { ...reference, reference_id: 'raw-reference', label: null, parse_confidence: 'raw' as const };
    const view = render(<ReferenceStrip references={[raw]} on_select={vi.fn()} />);
    expect(screen.getByRole('button', { name: `Reference ${raw.citation_text}` })).toBeTruthy();
    expect(screen.getByText('Ref')).toBeTruthy();
    expect(screen.queryByText(raw.title!)).toBeNull();
    expect(screen.queryByText('J. Smith · 2020')).toBeNull();
    expect(screen.queryByText('01')).toBeNull();
    view.rerender(<ReferenceStrip references={[{ ...raw, arxiv_id: '1706.03762' }]} on_select={vi.fn()} />);
    expect(screen.getByText('arxiv:1706.03762')).toBeTruthy();
  });

  it('retains complete long text for accessibility despite the visual clamp', () => {
    const title = 'A very long reference '.repeat(30);
    render(<article className="reading-block"><ReferenceStrip references={[{ ...reference, title }]} on_select={vi.fn()} /></article>);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(`Reference Smi20: ${title}`);
    expect(document.querySelector('.reference-strip-title')!.textContent).toBe(title);

  });

  it('does not add a reference region when the block has no associated references', () => {
    const view = render(<ReferenceStrip references={[]} on_select={vi.fn()} />);
    expect(view.container.childElementCount).toBe(0);
  });

  it.each([0.75, 1, 2])('keeps passage cards and source controls proportional at %sx without enlarging dialog controls', (zoom) => {
    const styles = document.createElement('style');
    // JSDOM applies the real CSS cascade but does not resolve CSS variables.
    // Substitute the reader's inherited scale to verify the length rules and
    // their scope; native layout still covers actual variable inheritance.
    styles.textContent = ['reading-view.css', 'reference-components.css']
      .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8'))
      .join('\n').replace(/var\(--reading-zoom(?:,\s*1)?\)/g, String(zoom));
    document.head.append(styles);
    try {
      const view = render(<>
        <div className="reading-pages"><article className="reading-block reading-block-figure">
          <div className="reading-block-actions">
            <span>Figure 1 · p. 1</span>
            <button type="button"><svg width="15" height="15" />Enlarge</button>
            <button type="button" className="reading-source-button" aria-label="View in PDF"><svg width="16" height="16" /></button>
          </div>
          <ReferenceStrip references={[reference]} on_select={vi.fn()} />
        </article></div>
        <div className="figure-dialog-toolbar"><button type="button">Fit figure</button></div>
      </>);
      const styleOf = (selector: string) => getComputedStyle(view.container.querySelector(selector)!);
      const scaled = (pixels: number) => `calc(${pixels * zoom}px)`;
      expect(styleOf('.reference-strip').paddingTop).toBe(scaled(8));
      expect(styleOf('.reference-strip').borderTopWidth).toBe(scaled(1));
      expect(styleOf('.reference-strip button').minHeight).toBe(`calc(44px * ${zoom})`);
      expect(styleOf('.reference-strip-title').fontSize).toBe(scaled(13));
      expect(styleOf('.reference-strip-publication').fontSize).toBe(scaled(12));
      expect(styleOf('.reference-strip button > svg').width).toBe(scaled(16));
      expect(styleOf('.reading-block-actions').fontSize).toBe(scaled(11));
      expect(styleOf('.reading-source-button').width).toBe(scaled(44));
      expect(styleOf('.reading-source-button').height).toBe(scaled(44));
      expect(styleOf('.reading-source-button > svg').width).toBe(scaled(16));
      expect(styleOf('.reading-block-actions button > svg').width).toBe(scaled(15));
      expect(styleOf('.reading-pages').gap).toBe(`calc(12px * ${zoom})`);
      expect(styleOf('.figure-dialog-toolbar button').minWidth).toBe('44px');
      expect(styleOf('.figure-dialog-toolbar button').minHeight).toBe('44px');
    } finally {
      styles.remove();
    }
  });
});
