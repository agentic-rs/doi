// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalLinkDialog } from './ExternalLinkDialog';

afterEach(cleanup);
it('offers a selectable address without attempting unsupported navigation', () => {
  const on_confirm = vi.fn(); const on_cancel = vi.fn();
  const url = 'https://example.org/paper?q=one#page=2';
  render(<ExternalLinkDialog url={url} busy={false} error={null} on_confirm={on_confirm} on_cancel={on_cancel} />);
  expect(screen.getByRole('dialog', { name: 'External link' })).toBeTruthy();
  const address = screen.getByRole('textbox', { name: 'Link address' }) as HTMLInputElement;
  expect(address.value).toBe(url);
  fireEvent.focus(address);
  expect(address.selectionEnd).toBe(url.length);
  expect(screen.queryByRole('link')).toBeNull();
  expect(on_confirm).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(on_cancel).toHaveBeenCalledOnce();
});
