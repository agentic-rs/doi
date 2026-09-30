// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceItem } from '../lib/types';
import { ReferenceDetailsDialog } from './ReferenceDetailsDialog';

const reference: ReferenceItem = {
  reference_id: 'reference-7-2', label: '9', citation_text: '[9] A. Author. 2021. The complete cited paper. Example proceedings.',
  title: 'The complete cited paper', authors: ['A. Author'], publication_year: '2021', venue: 'Example proceedings',
  parse_confidence: 'parsed', page_number: 7, source_rect: [40, 100, 500, 150], arxiv_id: '2101.12345', doi: null, url: null,
};

function props() {
  return { reference, busy: false, on_open: vi.fn(), on_find: vi.fn(), on_source: vi.fn(), on_close: vi.fn() };
}

afterEach(cleanup);

describe('reference details dialog', () => {
  it('uses the library focus trap, includes original-citation disclosure, and restores its opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const callbacks = props();
    const view = render(<ReferenceDetailsDialog {...callbacks} />);
    const dialog = screen.getByRole('dialog', { name: 'Reference details' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    const first = screen.getByRole('button', { name: 'Close reference details' });
    const last = screen.getByRole('button', { name: 'View bibliography on page 7' });
    const original = screen.getByText('Original citation');
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    original.focus();
    expect(document.activeElement).toBe(original);
    view.rerender(<ReferenceDetailsDialog {...callbacks} busy />);
    expect(document.activeElement).toBe(original);
    opener.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(callbacks.on_close).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('forwards reference actions and dismisses only the backdrop or close control', () => {
    const callbacks = props();
    const view = render(<ReferenceDetailsDialog {...callbacks} />);
    expect(screen.getByText(reference.citation_text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper' }));
    expect(callbacks.on_open).toHaveBeenCalledWith(reference);
    fireEvent.click(screen.getByRole('button', { name: 'View bibliography on page 7' }));
    expect(callbacks.on_source).toHaveBeenCalledWith(reference);
    fireEvent.pointerDown(screen.getByRole('heading', { name: reference.title! }));
    expect(callbacks.on_close).not.toHaveBeenCalled();
    fireEvent.pointerDown(view.container.firstElementChild!);
    fireEvent.pointerUp(view.container.firstElementChild!);
    expect(callbacks.on_close).not.toHaveBeenCalled();
    expect(fireEvent.click(view.container.firstElementChild!)).toBe(false);
    expect(callbacks.on_close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close reference details' }));
    expect(callbacks.on_close).toHaveBeenCalledTimes(2);
  });
});
