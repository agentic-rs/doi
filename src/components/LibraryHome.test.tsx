// @vitest-environment jsdom
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Paper } from '../lib/types';
import { LibraryHome } from './LibraryHome';

const paperA: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], abstract: '',
  pdf_url: 'https://arxiv.org/pdf/1706.03762v7', pdf_hash: 'a'.repeat(64),
  downloaded_at: '2026-09-20T00:00:00Z', last_opened_at: '2026-09-29T00:00:00Z', last_location: null,
};
const paperB: Paper = { ...paperA, paper_id: '2005.14165v4', arxiv_id: '2005.14165', arxiv_version: 4, title: 'Language Models Are Few-Shot Learners', authors: ['Tom Brown'], downloaded_at: '2026-09-28T00:00:00Z', last_opened_at: null };

function props(overrides: Partial<ComponentProps<typeof LibraryHome>> = {}): ComponentProps<typeof LibraryHome> {
  return {
    papers: [paperB, paperA], is_native: true, loading: false, error: null,
    input: '1706.03762', search: '', lookup_busy: false, lookup_message: null, lookup_error: null,
    on_input_change: vi.fn(), on_search_change: vi.fn(), on_lookup: vi.fn(), on_cancel_lookup: vi.fn(),
    on_open: vi.fn(), on_remove: vi.fn(), on_retry_library: vi.fn(), on_settings: vi.fn(), ...overrides,
  };
}

afterEach(cleanup);

describe('library home', () => {
  it('orders recent papers by last opening with downloaded-date fallback without mutating the library', () => {
    const values = props();
    render(<LibraryHome {...values} />);
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]).getByRole('heading', { name: paperA.title })).toBeTruthy();
    expect(within(cards[1]).getByRole('heading', { name: paperB.title })).toBeTruthy();
    expect(values.papers[0]).toBe(paperB);
    fireEvent.click(screen.getByRole('button', { name: `Open ${paperA.title}` }));
    expect(values.on_open).toHaveBeenCalledWith(paperA);
    expect(values.on_remove).not.toHaveBeenCalled();
  });

  it('filters by title, author, and versioned arXiv ID using the controlled search', () => {
    const values = props();
    const view = render(<LibraryHome {...values} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search your library' }), { target: { value: 'Tom Brown' } });
    expect(values.on_search_change).toHaveBeenCalledWith('Tom Brown');
    for (const search of ['few-shot', 'Tom Brown', '2005.14165v4']) {
      view.rerender(<LibraryHome {...values} search={search} />);
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: paperB.title })).toBeTruthy();
    }
    view.rerender(<LibraryHome {...values} search="Missing paper" />);
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('No papers match “Missing paper”.')).toBeTruthy();
  });

  it('submits a lookup, exposes the input ref, and keeps cancellation available during progress', () => {
    const inputRef = createRef<HTMLInputElement>();
    const values = props({ input_ref: inputRef });
    const view = render(<LibraryHome {...values} />);
    const input = screen.getByRole('textbox', { name: 'arXiv ID or link' });
    expect(inputRef.current).toBe(input);
    fireEvent.change(input, { target: { value: 'https://arxiv.org/abs/1706.03762' } });
    expect(values.on_input_change).toHaveBeenCalledWith('https://arxiv.org/abs/1706.03762');
    fireEvent.submit(input.closest('form')!);
    expect(values.on_lookup).toHaveBeenCalledOnce();
    view.rerender(<LibraryHome {...values} lookup_busy lookup_message="Reading metadata…" />);
    expect(screen.getByRole('status').textContent).toContain('Reading metadata');
    expect((screen.getByRole('button', { name: 'Find paper' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest('form')!);
    expect(values.on_lookup).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(values.on_cancel_lookup).toHaveBeenCalledOnce();
    view.rerender(<LibraryHome {...values} lookup_error="Paper not found" />);
    expect(screen.getByRole('alert').textContent).toContain('Paper not found');
  });

  it.each([{ input: ' ' }, { is_native: false }])('does not start an unavailable or empty lookup (%j)', (override) => {
    const values = props(override);
    render(<LibraryHome {...values} />);
    fireEvent.submit(screen.getByRole('textbox', { name: 'arXiv ID or link' }).closest('form')!);
    expect(values.on_lookup).not.toHaveBeenCalled();
  });

  it('reveals Remove only through the paper menu and restores focus when dismissed', () => {
    const values = props();
    render(<LibraryHome {...values} />);
    const more = screen.getByRole('button', { name: `More actions for ${paperA.title}` });
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
    fireEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Remove' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Paper Reader' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(values.on_remove).not.toHaveBeenCalled();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(values.on_remove).toHaveBeenCalledWith(paperA);
    expect(values.on_open).not.toHaveBeenCalled();
  });

  it('separates library loading, empty, and error states, with retry and cached papers still usable', () => {
    const values = props({ papers: [], loading: true });
    const view = render(<LibraryHome {...values} />);
    expect(screen.getByRole('status').textContent).toContain('Opening your library');
    expect(screen.queryByText('Your next idea starts here.')).toBeNull();
    view.rerender(<LibraryHome {...values} loading={false} error="Database temporarily unavailable" papers={[paperA]} />);
    expect(screen.getByRole('alert').textContent).toContain('Database temporarily unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(values.on_retry_library).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: `Open ${paperA.title}` }));
    expect(values.on_open).toHaveBeenCalledWith(paperA);
    view.rerender(<LibraryHome {...values} loading={false} />);
    expect(screen.getByText('Your next idea starts here.')).toBeTruthy();
  });
});
