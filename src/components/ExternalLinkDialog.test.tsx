// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalLinkDialog } from './ExternalLinkDialog';

const url = 'https://example.org:8443/papers/research.pdf?source=reference#page=3';

function props() {
  return { url, busy: false, error: null, on_confirm: vi.fn(), on_cancel: vi.fn() };
}

afterEach(cleanup);

describe('external link confirmation', () => {
  it('shows the domain and complete URL as plain text and opens only after confirmation', () => {
    const callbacks = props();
    render(<ExternalLinkDialog {...callbacks} />);
    expect(screen.getByRole('dialog', { name: 'Open external link?' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('example.org')).toBeTruthy();
    expect(screen.getByText(url).textContent).toBe(url);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(callbacks.on_confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(url));
    expect(callbacks.on_confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(callbacks.on_confirm).toHaveBeenCalledOnce();
  });

  it('contains keyboard focus and restores focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<ExternalLinkDialog {...props()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Open in browser' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    opener.focus();
    expect(document.activeElement).toBe(cancel);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('allows Escape, Cancel, and backdrop dismissal while idle', () => {
    const callbacks = props();
    const view = render(<ExternalLinkDialog {...callbacks} />);
    fireEvent.pointerDown(screen.getByText(url));
    expect(callbacks.on_cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.pointerDown(view.container.firstElementChild!);
    fireEvent.pointerUp(view.container.firstElementChild!);
    expect(callbacks.on_cancel).toHaveBeenCalledTimes(2);
    fireEvent.click(view.container.firstElementChild!);
    expect(callbacks.on_cancel).toHaveBeenCalledTimes(3);
    expect(callbacks.on_confirm).not.toHaveBeenCalled();
  });

  it('blocks repeated opening and dismissal while busy and allows retry after an error', () => {
    const callbacks = props();
    const view = render(<ExternalLinkDialog {...callbacks} />);
    view.rerender(<ExternalLinkDialog {...callbacks} busy />);
    expect(screen.getByRole('status').textContent).toContain('Opening browser');
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(view.container.firstElementChild!);
    fireEvent.pointerUp(view.container.firstElementChild!);
    fireEvent.click(view.container.firstElementChild!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(callbacks.on_cancel).not.toHaveBeenCalled();
    expect(callbacks.on_confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    view.rerender(<ExternalLinkDialog {...callbacks} error="Could not open the browser" />);
    expect(screen.getByRole('alert').textContent).toBe('Could not open the browser');
    expect(screen.getByText(url).textContent).toBe(url);
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(callbacks.on_confirm).toHaveBeenCalledOnce();
  });
});
