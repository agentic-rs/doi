// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Paper } from '../lib/types';
import { RemovePaperDialog } from './RemovePaperDialog';

const paper: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'Attention Is All You Need', authors: [], abstract: '',
  pdf_url: 'https://arxiv.org/pdf/1706.03762v7', pdf_hash: 'a'.repeat(64),
  downloaded_at: '2026-09-29T00:00:00Z', last_location: null,
};

afterEach(cleanup);

describe('remove paper confirmation', () => {
  it('names the paper and all removed data, with cancel focused before any destructive action', () => {
    const confirm = vi.fn();
    render(<RemovePaperDialog paper={paper} busy={false} error={null} on_confirm={confirm} on_cancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Remove paper?' });
    expect(dialog.textContent).toContain(paper.title);
    expect(dialog.textContent).toContain('notes, and its AI conversations from your library');
    expect(dialog.textContent).toContain('Apell may retain the downloaded PDF in its cache');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove paper' }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('blocks dismissal while removing, keeps focus contained, and offers retry after an error', () => {
    const cancel = vi.fn();
    const confirm = vi.fn();
    const props = { paper, busy: false, error: null, on_confirm: confirm, on_cancel: cancel };
    const view = render(<RemovePaperDialog {...props} />);
    view.rerender(<RemovePaperDialog {...props} busy />);
    expect(screen.getByRole('status').textContent).toContain('Removing paper');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(view.container.firstElementChild!);
    fireEvent.pointerUp(view.container.firstElementChild!);
    fireEvent.click(view.container.firstElementChild!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove paper' }));
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    view.rerender(<RemovePaperDialog {...props} error="Could not remove the cached PDF" />);
    expect(screen.getByRole('alert').textContent).toBe('Could not remove the cached PDF');
    fireEvent.click(screen.getByRole('button', { name: 'Remove paper' }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('allows Escape and backdrop cancellation while idle without dismissing from its content', () => {
    const cancel = vi.fn();
    const view = render(<RemovePaperDialog paper={paper} busy={false} error={null} on_confirm={vi.fn()} on_cancel={cancel} />);
    fireEvent.pointerDown(screen.getByText(paper.title));
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(view.container.firstElementChild!);
    fireEvent.pointerUp(view.container.firstElementChild!);
    expect(cancel).toHaveBeenCalledOnce();
    fireEvent.click(view.container.firstElementChild!);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
