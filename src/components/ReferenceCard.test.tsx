// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceCandidate, ReferenceItem } from '../lib/types';
import { ReferenceCard } from './ReferenceCard';

const reference: ReferenceItem = {
  reference_id: 'reference-12-4', label: 'VSP+17', page_number: 12,
  citation_text: '[VSP+17] A. Vaswani and N. Shazeer. 2017. Attention Is All You Need. NeurIPS. arXiv:1706.03762.',
  title: 'Attention Is All You Need', authors: ['A. Vaswani', 'N. Shazeer'], publication_year: '2017', venue: 'NeurIPS',
  parse_confidence: 'parsed', source_rect: [40, 200, 540, 270], arxiv_id: '1706.03762', doi: null, url: null,
};

function props(value = reference) {
  return { reference: value, busy: false, on_open: vi.fn(), on_find: vi.fn(), on_source: vi.fn() };
}

afterEach(cleanup);

describe('reference cards', () => {
  it('shows parsed metadata with the actual label, preserves the full original, and opens only on request', () => {
    const callbacks = props();
    render(<ReferenceCard {...callbacks} />);
    expect(screen.getByRole('article', { name: 'Reference VSP+17' })).toBeTruthy();
    expect(screen.getByText('VSP+17')).toBeTruthy();
    expect(screen.getByRole('heading', { name: reference.title! })).toBeTruthy();
    expect(screen.getByText('A. Vaswani, N. Shazeer · 2017 · arxiv:1706.03762')).toBeTruthy();
    expect(screen.getByText(reference.citation_text).closest('details')).toBeTruthy();
    const original = screen.getByText('Original citation');
    expect(original.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('button', { name: 'Find a match' })).toBeNull();
    expect(callbacks.on_open).not.toHaveBeenCalled();
    expect(callbacks.on_find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper' }));
    expect(callbacks.on_open).toHaveBeenCalledWith(reference);
    fireEvent.click(screen.getByRole('button', { name: 'View bibliography on page 12' }));
    expect(callbacks.on_source).toHaveBeenCalledWith(reference);
  });

  it('keeps uncertain references raw and does not invent an ordinal or metadata', () => {
    const raw: ReferenceItem = { ...reference, label: null, parse_confidence: 'raw', arxiv_id: null };
    const callbacks = props(raw);
    render(<ReferenceCard {...callbacks} />);
    expect(screen.getByRole('article', { name: 'Reference' })).toBeTruthy();
    expect(screen.getByText(raw.citation_text)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: raw.title! })).toBeNull();
    expect(screen.queryByText(raw.authors.join(', '))).toBeNull();
    expect(screen.queryByText('Original citation')).toBeNull();
    expect(screen.queryByText('05')).toBeNull();
    expect(callbacks.on_find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find a match' }));
    expect(callbacks.on_find).toHaveBeenCalledWith(raw);
  });

  it('recognizes arXiv URLs as app links even without a parsed identifier', () => {
    const value = { ...reference, arxiv_id: null, url: 'https://arxiv.org/pdf/1706.03762v7' };
    const callbacks = props(value);
    render(<ReferenceCard {...callbacks} />);
    const preview = screen.getByRole('button', { name: 'Preview paper' });
    expect(preview.getAttribute('data-link-kind')).toBe('app');
    expect(preview.title).toBe('Open paper in Paper Reader');
    expect(screen.queryByRole('button', { name: 'Find a match' })).toBeNull();
    fireEvent.click(preview);
    expect(callbacks.on_open).toHaveBeenCalledWith(value);
  });

  it.each([
    { doi: '10.1234/example', url: null, label: 'Open DOI' },
    { doi: null, url: 'https://example.org/paper', label: 'Open link' },
  ])('offers $label alongside lookup and retains a page source without exact geometry', ({ doi, url, label }) => {
    const value = { ...reference, arxiv_id: null, doi, url, source_rect: null };
    const callbacks = props(value);
    render(<ReferenceCard {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(callbacks.on_open).toHaveBeenCalledWith(value);
    expect(screen.getByRole('button', { name: 'Find a match' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View bibliography on page 12' }));
    expect(callbacks.on_source).toHaveBeenCalledWith(value);
  });

  it('keeps both arXiv preview and DOI available without changing the original reference', () => {
    const value = { ...reference, doi: '10.48550/arXiv.1706.03762' };
    const callbacks = props(value);
    render(<ReferenceCard {...callbacks} />);
    expect(screen.getByText(`DOI: ${value.doi}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open DOI' }));
    expect(callbacks.on_open).toHaveBeenCalledWith({ ...value, arxiv_id: null });
    expect(value.arxiv_id).toBe(reference.arxiv_id);
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper' }));
    expect(callbacks.on_open).toHaveBeenLastCalledWith(value);
  });

  it('presents candidate uncertainty, hides redundant lookup, and forwards the selected candidate', () => {
    const possible: ReferenceCandidate = {
      title: 'A possible related paper', authors: ['J. Smith'], publication_year: '2020', venue: 'Example Journal',
      match_kind: 'suggestion', arxiv_id: null, doi: '10.1234/possible', url: 'https://doi.org/10.1234/possible',
    };
    const exact: ReferenceCandidate = { ...possible, title: 'A paper matched by DOI', match_kind: 'identifier', doi: '10.1234/exact' };
    const callbacks = props({ ...reference, arxiv_id: null });
    const view = render(<ReferenceCard {...callbacks} resolution={{ busy: false, candidates: [possible, exact], error: null }} />);
    expect(screen.getByText('Possible match')).toBeTruthy();
    expect(screen.getByText('Identifier match')).toBeTruthy();
    expect(screen.getAllByText('J. Smith · 2020 · Example Journal')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Find a match' })).toBeNull();
    expect(callbacks.on_open).not.toHaveBeenCalled();
    const candidate = screen.getByRole('button', { name: `Open possible match: ${possible.title}` });
    expect(within(candidate).getByText('J. Smith · 2020 · Example Journal')).toBeTruthy();
    fireEvent.click(candidate);
    expect(callbacks.on_open).toHaveBeenCalledWith(possible);
    view.rerender(<ReferenceCard {...callbacks} busy resolution={{ busy: false, candidates: [possible], error: null }} />);
    expect((screen.getByRole('button', { name: `Open possible match: ${possible.title}` }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces lookup progress and errors, disables duplicate actions, and permits a retry', () => {
    const callbacks = props({ ...reference, arxiv_id: null, doi: '10.1234/example' });
    const view = render(<ReferenceCard {...callbacks} resolution={{ busy: true, candidates: [], error: null }} />);
    expect(screen.getByRole('status').textContent).toContain('Looking for matching references');
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ReferenceCard {...callbacks} resolution={{ busy: false, candidates: [], error: 'Lookup interrupted' }} />);
    expect(screen.getByRole('alert').textContent).toBe('Lookup interrupted');
    fireEvent.click(screen.getByRole('button', { name: 'Find a match' }));
    expect(callbacks.on_find).toHaveBeenCalledOnce();
    view.rerender(<ReferenceCard {...callbacks} resolution={{ busy: false, candidates: [], error: null }} />);
    expect(screen.getByRole('status').textContent).toBe('No matches found.');
  });
});
