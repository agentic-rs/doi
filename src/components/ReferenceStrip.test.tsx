// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceItem } from '../lib/types';
import { ReferenceStrip } from './ReferenceStrip';

const reference: ReferenceItem = {
  reference_id: 'reference-8-1', label: 'Smi20', citation_text: '[Smi20] J. Smith. 2020. A useful paper. Example journal.',
  title: 'A useful paper', authors: ['J. Smith'], publication_year: '2020', venue: 'Example journal',
  parse_confidence: 'parsed', page_number: 8, source_rect: null, arxiv_id: null, doi: null, url: null,
};

afterEach(cleanup);

describe('block reference summaries', () => {
  it('preserves printed labels and forwards the exact reference for details', () => {
    const select = vi.fn();
    render(<ReferenceStrip references={[reference]} on_select={select} />);
    expect(screen.getByRole('complementary', { name: 'References for this passage' })).toBeTruthy();
    expect(screen.getByText('Smi20')).toBeTruthy();
    expect(screen.getByText('J. Smith · 2020')).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reference Smi20: A useful paper' }));
    expect(select).toHaveBeenCalledWith(reference);
  });

  it('uses raw text for uncertain references without inventing a numeric label', () => {
    const raw = { ...reference, reference_id: 'raw-reference', label: null, parse_confidence: 'raw' as const };
    render(<ReferenceStrip references={[raw]} on_select={vi.fn()} />);
    expect(screen.getByRole('button', { name: `Reference ${raw.citation_text}` })).toBeTruthy();
    expect(screen.getByText('Ref')).toBeTruthy();
    expect(screen.queryByText(raw.title!)).toBeNull();
    expect(screen.queryByText('J. Smith · 2020')).toBeNull();
    expect(screen.queryByText('01')).toBeNull();
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
});
