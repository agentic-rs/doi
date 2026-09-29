// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaperTabs } from './PaperTabs';

const tabs = [{ paper_id: 'a', title: 'Paper A' }, { paper_id: 'b', title: 'Paper B' }];

afterEach(cleanup);

describe('paper tabs', () => {
  it('provides controlled home, activate, and close actions without nesting buttons', () => {
    const home = vi.fn();
    const activate = vi.fn();
    const close = vi.fn();
    render(<PaperTabs tabs={tabs} active_paper_id="a" on_home={home} on_activate={activate} on_close={close} />);
    expect(screen.getByRole('button', { name: 'Paper A' }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('button button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Paper B' }));
    expect(activate).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: 'Close Paper A' }));
    expect(close).toHaveBeenCalledWith('a');
    expect(activate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    expect(home).toHaveBeenCalledOnce();
  });

  it('supports keyboard navigation, wrapping, and Delete for paper tabs only', () => {
    const home = vi.fn();
    const activate = vi.fn();
    const close = vi.fn();
    render(<PaperTabs tabs={tabs} active_paper_id={null} on_home={home} on_activate={activate} on_close={close} />);
    const homeButton = screen.getByRole('button', { name: 'Library home' });
    homeButton.focus();
    fireEvent.keyDown(homeButton, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Paper A' }));
    expect(activate).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Paper B' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(close).toHaveBeenCalledWith('b');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(homeButton);
    expect(home).toHaveBeenCalledOnce();
    fireEvent.keyDown(homeButton, { key: 'Delete' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['a', null])('restores keyboard focus to the selected destination when a focused close button disappears (%s)', (active) => {
    const props = { tabs, active_paper_id: 'b', on_home: vi.fn(), on_activate: vi.fn(), on_close: vi.fn() };
    const view = render(<PaperTabs {...props} />);
    const close = screen.getByRole('button', { name: 'Close Paper B' });
    close.focus();
    fireEvent.click(close);
    view.rerender(<PaperTabs {...props} tabs={[tabs[0]]} active_paper_id={active} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: active ? 'Paper A' : 'Library home' }));
  });

  it('prevents navigation and closing while disabled', () => {
    const home = vi.fn();
    const activate = vi.fn();
    const close = vi.fn();
    render(<PaperTabs tabs={tabs} active_paper_id="a" disabled on_home={home} on_activate={activate} on_close={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paper B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Paper A' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Paper A' }), { key: 'ArrowRight' });
    expect(home).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
