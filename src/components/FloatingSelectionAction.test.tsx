// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingSelectionAction } from './FloatingSelectionAction';

let area_width = 320;
let area_height = 480;
let area_top = 8;
const resize_callbacks = new Set<() => void>();
const captured_pointers = new Set<number>();
const capture_descriptors = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture']
  .map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

beforeEach(() => {
  area_width = 320;
  area_height = 480;
  area_top = 8;
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resize_callbacks.add(callback); }
    observe() {}
    disconnect() { resize_callbacks.delete(this.callback); }
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: (id: number) => captured_pointers.add(id) },
    hasPointerCapture: { configurable: true, value: (id: number) => captured_pointers.has(id) },
    releasePointerCapture: { configurable: true, value: (id: number) => captured_pointers.delete(id) },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('floating-selection-action')) return rect(12, area_top, area_width, area_height);
    return rect(12 + Number.parseFloat(this.style.left || String(area_width - 48)),
      area_top + Number.parseFloat(this.style.top || String(area_height - 48)), 48, 48);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of capture_descriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  captured_pointers.clear();
  resize_callbacks.clear();
});

function action() {
  return screen.getByRole('button', { name: 'Ask AI or add a note to this passage' });
}

function pointer(button: HTMLElement, type: string, x: number, y: number, pointer_id = 1) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: pointer_id, clientX: x, clientY: y });
  fireEvent(button, event);
  return event;
}

function clickPointer(button: HTMLElement) {
  fireEvent.click(button, { detail: 1 });
}

describe('floating passage action', () => {
  it('is an icon-only accessible button that keeps text selection during an ordinary tap', () => {
    const on_activate = vi.fn();
    render(<><p>Selected passage</p><FloatingSelectionAction visible on_activate={on_activate} /></>);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('Selected passage'));
    selection.addRange(range);
    const button = action();
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.style.left).toBe('272px');
    expect(button.style.top).toBe('432px');
    expect(pointer(button, 'pointerdown', 300, 460).defaultPrevented).toBe(true);
    pointer(button, 'pointermove', 302, 462);
    pointer(button, 'pointerup', 302, 462);
    clickPointer(button);
    expect(on_activate).toHaveBeenCalledOnce();
    expect(selection.toString()).toBe('Selected passage');
    expect(button.style.left).toBe('272px');
    expect(captured_pointers.size).toBe(0);
    selection.removeAllRanges();
  });

  it('drags independently without activating on release, then permits the next tap', () => {
    const on_activate = vi.fn();
    render(<FloatingSelectionAction visible on_activate={on_activate} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    expect(captured_pointers.has(1)).toBe(true);
    pointer(button, 'pointermove', 190, 200);
    expect(button.style.left).toBe('162px');
    expect(button.style.top).toBe('172px');
    expect(button.getAttribute('data-dragging')).toBe('true');
    pointer(button, 'pointerup', 190, 200);
    clickPointer(button);
    expect(on_activate).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-dragging')).toBe(false);
    pointer(button, 'pointerdown', 190, 200);
    pointer(button, 'pointerup', 190, 200);
    clickPointer(button);
    expect(on_activate).toHaveBeenCalledOnce();
  });

  it('clamps a drag to the safe bounds and reclamps after rotation or resize', () => {
    render(<FloatingSelectionAction visible on_activate={vi.fn()} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    pointer(button, 'pointermove', -500, -500);
    expect(button.style.left).toBe('0px');
    expect(button.style.top).toBe('0px');
    pointer(button, 'pointermove', 900, 900);
    expect(button.style.left).toBe('272px');
    expect(button.style.top).toBe('432px');
    act(() => {
      area_width = 180;
      area_height = 120;
      resize_callbacks.forEach((callback) => callback());
    });
    expect(button.style.left).toBe('132px');
    expect(button.style.top).toBe('72px');
    expect(captured_pointers.size).toBe(0);
    expect(button.hasAttribute('data-dragging')).toBe(false);
    pointer(button, 'pointermove', 100, 100);
    expect(button.style.left).toBe('132px');
  });

  it('keeps its position when hidden and reopened, including interrupted drags', () => {
    const on_activate = vi.fn();
    const view = render(<FloatingSelectionAction visible on_activate={on_activate} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    pointer(button, 'pointermove', 190, 200);
    view.rerender(<FloatingSelectionAction visible={false} on_activate={on_activate} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(captured_pointers.size).toBe(0);
    expect(resize_callbacks.size).toBe(0);
    view.rerender(<FloatingSelectionAction visible on_activate={on_activate} />);
    expect(action().style.left).toBe('162px');
    expect(action().style.top).toBe('172px');
    expect(action().hasAttribute('data-dragging')).toBe(false);
    expect(on_activate).not.toHaveBeenCalled();
  });

  it('cancels interrupted pointers and ignores other pointers during a drag', () => {
    const on_activate = vi.fn();
    render(<FloatingSelectionAction visible on_activate={on_activate} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    pointer(button, 'pointermove', 190, 200, 2);
    pointer(button, 'pointercancel', 190, 200, 2);
    expect(captured_pointers.has(1)).toBe(true);
    expect(button.style.left).toBe('272px');
    pointer(button, 'pointermove', 190, 200);
    pointer(button, 'pointercancel', 190, 200);
    pointer(button, 'pointerup', 190, 200);
    clickPointer(button);
    expect(on_activate).not.toHaveBeenCalled();
    expect(captured_pointers.size).toBe(0);
    expect(button.hasAttribute('data-dragging')).toBe(false);
  });

  it('keeps the chosen screen position through controls and composer toggles, clamping only when covered', () => {
    const on_activate = vi.fn();
    const view = render(<FloatingSelectionAction visible controls_visible={false} on_activate={on_activate} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    pointer(button, 'pointermove', 190, 200);
    pointer(button, 'pointerup', 190, 200);
    const chosen_top = button.getBoundingClientRect().top;
    area_top = 125;
    area_height = 363;
    view.rerender(<FloatingSelectionAction visible controls_visible on_activate={on_activate} />);
    expect(button.getBoundingClientRect().top).toBe(chosen_top);
    view.rerender(<FloatingSelectionAction visible={false} controls_visible on_activate={on_activate} />);
    area_top = 8;
    area_height = 480;
    view.rerender(<FloatingSelectionAction visible controls_visible={false} on_activate={on_activate} />);
    expect(action().getBoundingClientRect().top).toBe(chosen_top);
    pointer(button, 'pointerdown', 190, 200);
    pointer(button, 'pointermove', 190, 0);
    pointer(button, 'pointerup', 190, 0);
    expect(button.getBoundingClientRect().top).toBe(8);
    area_top = 125;
    area_height = 363;
    view.rerender(<FloatingSelectionAction visible controls_visible on_activate={on_activate} />);
    expect(button.getBoundingClientRect().top).toBe(125);
    expect(on_activate).not.toHaveBeenCalled();
  });

  it('preserves native keyboard and assistive activation after a drag', () => {
    const on_activate = vi.fn();
    render(<FloatingSelectionAction visible on_activate={on_activate} />);
    const button = action();
    pointer(button, 'pointerdown', 300, 460);
    pointer(button, 'pointermove', 190, 200);
    pointer(button, 'pointerup', 190, 200);
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button, { detail: 0 });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyUp(button, { key: ' ' });
    fireEvent.click(button, { detail: 0 });
    expect(document.activeElement).toBe(button);
    expect(on_activate).toHaveBeenCalledTimes(2);
  });

  it('releases pointer capture and resize listeners when unmounted during a drag', () => {
    const view = render(<FloatingSelectionAction visible on_activate={vi.fn()} />);
    pointer(action(), 'pointerdown', 300, 460);
    view.unmount();
    expect(captured_pointers.size).toBe(0);
    expect(resize_callbacks.size).toBe(0);
  });
});
