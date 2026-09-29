// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaperPreview } from '../lib/types';
import { PaperPreviewDialog } from './PaperPreviewDialog';

const preview: PaperPreview = {
  preview_id: 'preview-1', library_paper: null,
  metadata: {
    paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
    title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: 'A new architecture.\nAttention connects every position.',
    pdf_url: 'https://arxiv.org/pdf/1706.03762v7',
  },
};

afterEach(cleanup);

describe('paper preview', () => {
  it('shows metadata before download and offers only download and cancel', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(<PaperPreviewDialog preview={preview} busy={false} message={null} error={null} on_confirm={confirm} on_cancel={cancel} />);
    expect(screen.getByRole('dialog', { name: preview.metadata.title }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(preview.metadata.authors.join(', '))).toBeTruthy();
    expect(screen.getByText('1706.03762')).toBeTruthy();
    expect(screen.getByText('v7')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Abstract' }).textContent).toContain(preview.metadata.abstract);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download & add to library' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps cancellation available during download and retries through the same primary button', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const props = { preview, busy: true, message: 'Downloading 40%', error: null, on_confirm: confirm, on_cancel: cancel };
    const view = render(<PaperPreviewDialog {...props} />);
    expect(screen.getByRole('status').textContent).toContain('Downloading 40%');
    expect((screen.getByRole('button', { name: 'Download & add to library' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    view.rerender(<PaperPreviewDialog {...props} busy={false} message={null} error="Network interrupted" />);
    expect(screen.getByRole('alert').textContent).toBe('Network interrupted');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Download & add to library' }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('traps focus, preserves it across status updates, and restores the opener after cancellation', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const cancel = vi.fn();
    const props = { preview, busy: false, message: null, error: null, on_confirm: vi.fn(), on_cancel: cancel };
    const view = render(<PaperPreviewDialog {...props} />);
    const dialog = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: 'Cancel' });
    const last = screen.getByRole('button', { name: 'Download & add to library' });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    view.rerender(<PaperPreviewDialog {...props} busy message="Downloading…" />);
    expect(document.activeElement).toBe(first);
    opener.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('dismisses the backdrop only and uses the latest cancellation callback', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const props = { preview, busy: false, message: null, error: null, on_confirm: vi.fn(), on_cancel: first };
    const view = render(<PaperPreviewDialog {...props} />);
    view.rerender(<PaperPreviewDialog {...props} on_cancel={latest} />);
    fireEvent.pointerDown(screen.getByRole('heading', { name: preview.metadata.title }));
    expect(latest).not.toHaveBeenCalled();
    fireEvent.pointerDown(view.container.firstElementChild!);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
});
