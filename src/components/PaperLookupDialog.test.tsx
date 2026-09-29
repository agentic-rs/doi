// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaperLookupDialog } from './PaperLookupDialog';

afterEach(cleanup);

describe('paper lookup dialog', () => {
  it('announces progress with a single cancel action and keeps focus stable during updates', () => {
    const cancel = vi.fn();
    const view = render(<PaperLookupDialog label="Find referenced paper" message="Looking up arXiv metadata…" on_cancel={cancel} />);
    expect(screen.getByRole('dialog', { name: 'Find referenced paper' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Looking up arXiv metadata');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Tab' });
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(button);
    view.rerender(<PaperLookupDialog label="Find referenced paper" message="Retrying the metadata request…" on_cancel={cancel} />);
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('status').textContent).toContain('Retrying');
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
