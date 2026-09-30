// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogBackdrop } from './DialogBackdrop';

function pointerEvent(target: Element, type: string, pointer_type = 'mouse') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointer_type },
    isPrimary: { value: true },
    button: { value: 0 },
    buttons: { value: type === 'pointerdown' ? 1 : 0 },
  });
  fireEvent(target, event);
  return event;
}

function callbacks() {
  return { on_dismiss: vi.fn(), on_background: vi.fn(), on_bubble: vi.fn(), on_internal: vi.fn() };
}

function Harness(props: ReturnType<typeof callbacks> & { dismissible?: boolean }) {
  const [open, setOpen] = useState(true);
  return <div onClick={props.on_bubble}>
    <main inert={open}>
      <a href="#underlying-paper" onClick={(event) => {
        event.preventDefault();
        props.on_background();
      }}>Underlying paper link</a>
    </main>
    {open && <DialogBackdrop class_name="test-backdrop" dismissible={props.dismissible ?? true} on_dismiss={() => {
      props.on_dismiss();
      setOpen(false);
    }}>
      <section role="dialog" aria-label="Reference details">
        <p>Reference content</p>
        <button type="button" onClick={props.on_internal}>Preview paper</button>
      </section>
    </DialogBackdrop>}
  </div>;
}

function getBackdrop(container: HTMLElement) {
  const backdrop = container.querySelector('.test-backdrop');
  if (!backdrop) throw new Error('Missing backdrop');
  return backdrop;
}

function clickBackdrop(backdrop: Element) {
  const event = createEvent.click(backdrop, { button: 0, detail: 1 });
  fireEvent(backdrop, event);
  return event;
}

afterEach(cleanup);

describe('dialog backdrop dismissal', () => {
  it.each(['mouse', 'touch'])('consumes the whole %s dismissal gesture before exposing the paper link', (pointer_type) => {
    const handlers = callbacks();
    const view = render(<Harness {...handlers} />);
    const backdrop = getBackdrop(view.container);
    const background = screen.getByRole('link', { name: 'Underlying paper link' });

    pointerEvent(backdrop, 'pointerdown', pointer_type);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(background.closest('main')?.hasAttribute('inert')).toBe(true);
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    pointerEvent(backdrop, 'pointerup', pointer_type);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(background.closest('main')?.hasAttribute('inert')).toBe(true);

    const click = clickBackdrop(backdrop);
    expect(click.defaultPrevented).toBe(true);
    expect(handlers.on_dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(handlers.on_background).not.toHaveBeenCalled();
    expect(handlers.on_bubble).not.toHaveBeenCalled();

    fireEvent.click(background);
    expect(handlers.on_background).toHaveBeenCalledOnce();
    expect(handlers.on_bubble).toHaveBeenCalledOnce();
  });

  it('leaves content controls usable without treating their click as dismissal', () => {
    const handlers = callbacks();
    render(<Harness {...handlers} />);
    const control = screen.getByRole('button', { name: 'Preview paper' });
    pointerEvent(control, 'pointerdown');
    pointerEvent(control, 'pointerup');
    fireEvent.click(control);
    expect(handlers.on_internal).toHaveBeenCalledOnce();
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    expect(handlers.on_background).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps a drag from dialog content to the backdrop from dismissing the dialog', () => {
    const handlers = callbacks();
    const view = render(<Harness {...handlers} />);
    const backdrop = getBackdrop(view.container);
    pointerEvent(screen.getByText('Reference content'), 'pointerdown');
    pointerEvent(backdrop, 'pointerup');
    const click = clickBackdrop(backdrop);
    expect(click.defaultPrevented).toBe(true);
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    expect(handlers.on_bubble).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('does not dismiss after a canceled pointer sequence and accepts the next complete gesture', () => {
    const handlers = callbacks();
    const view = render(<Harness {...handlers} />);
    const backdrop = getBackdrop(view.container);
    pointerEvent(backdrop, 'pointerdown', 'touch');
    pointerEvent(backdrop, 'pointercancel', 'touch');
    clickBackdrop(backdrop);
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    pointerEvent(backdrop, 'pointerdown', 'touch');
    pointerEvent(backdrop, 'pointerup', 'touch');
    clickBackdrop(backdrop);
    expect(handlers.on_dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('consumes backdrop clicks while dismissal is disabled', () => {
    const handlers = callbacks();
    const view = render(<Harness {...handlers} dismissible={false} />);
    const backdrop = getBackdrop(view.container);
    pointerEvent(backdrop, 'pointerdown');
    pointerEvent(backdrop, 'pointerup');
    const click = clickBackdrop(backdrop);
    expect(click.defaultPrevented).toBe(true);
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    expect(handlers.on_bubble).not.toHaveBeenCalled();
    expect(handlers.on_background).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('uses the current dismissal permission when the click completes', () => {
    const handlers = callbacks();
    const view = render(<Harness {...handlers} />);
    const backdrop = getBackdrop(view.container);
    pointerEvent(backdrop, 'pointerdown');
    view.rerender(<Harness {...handlers} dismissible={false} />);
    pointerEvent(backdrop, 'pointerup');
    clickBackdrop(backdrop);
    expect(handlers.on_dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
