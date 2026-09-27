// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Paper } from '../lib/types';
import { PaperInfoSheet } from './PaperInfoSheet';

const paper: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.\nWe propose a new simple network architecture.',
  pdf_url: 'https://arxiv.org/pdf/1706.03762v7', pdf_hash: 'a'.repeat(64),
  downloaded_at: '2026-09-27T00:00:00Z', last_location: null,
};

afterEach(cleanup);

describe('paper information sheet', () => {
  it('shows the full available metadata and abstract, with an explicitly cached date', () => {
    const openSource = vi.fn();
    const close = vi.fn();
    render(<PaperInfoSheet paper={paper} on_close={close} on_open_source={openSource} />);
    expect(screen.getByRole('dialog', { name: paper.title }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(paper.authors.join(', '))).toBeTruthy();
    expect(screen.getByText(paper.arxiv_id)).toBeTruthy();
    expect(screen.getByText('v7')).toBeTruthy();
    expect(screen.getByText('Cached on')).toBeTruthy();
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(paper.downloaded_at);
    expect(screen.getByRole('region', { name: 'Abstract' }).textContent).toContain(paper.abstract);
    fireEvent.click(screen.getByRole('button', { name: 'View on arXiv' }));
    expect(openSource).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read paper' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('contains keyboard focus, dismisses with Escape, and returns focus to its opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const view = render(<PaperInfoSheet paper={paper} on_close={close} on_open_source={vi.fn()} resume />);
    const dialog = screen.getByRole('dialog', { name: paper.title });
    const firstControl = screen.getByRole('button', { name: 'Close paper information' });
    const lastControl = screen.getByRole('button', { name: 'Resume reading' });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstControl);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastControl);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstControl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not dismiss when interacting with paper details and handles missing optional metadata', () => {
    const close = vi.fn();
    const { container } = render(<PaperInfoSheet paper={{ ...paper, authors: [], abstract: '', downloaded_at: '' }} on_close={close} on_open_source={vi.fn()} />);
    expect(screen.getByText('Not provided')).toBeTruthy();
    expect(screen.getByText('An abstract was not provided for this paper.')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('heading', { name: paper.title }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(container.firstElementChild!);
    expect(close).toHaveBeenCalledOnce();
  });
});
