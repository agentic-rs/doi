// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPdfZoomGestures } from './pdf-zoom-gestures';
import type { PdfZoomGestureOptions } from './pdf-zoom-gestures';

let frames: Map<number, FrameRequestCallback>;
let frame_id: number;
let cleanups: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  frame_id = 0;
  cleanups = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frame_id, callback);
    return frame_id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function flushFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

function fixture(overrides: Partial<PdfZoomGestureOptions> = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  let current_zoom = 1;
  const options = {
    get_zoom: overrides.get_zoom ?? (() => current_zoom),
    minimum_zoom: overrides.minimum_zoom ?? 0.1,
    maximum_zoom: overrides.maximum_zoom ?? 4,
    on_start: vi.fn(overrides.on_start ?? (() => true)),
    on_zoom: vi.fn(overrides.on_zoom ?? ((zoom: number) => { current_zoom = zoom; })),
    on_end: vi.fn(overrides.on_end ?? (() => {})),
  };
  const cleanup = attachPdfZoomGestures(element, options);
  cleanups.push(cleanup);
  return { element, options, cleanup };
}

function touch(identifier: number, client_x: number, client_y = 100): Touch {
  return { identifier, clientX: client_x, clientY: client_y } as Touch;
}

function dispatchTouch(element: HTMLElement, kind: string, touches: Touch[]) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  element.dispatchEvent(event);
  return event;
}

function dispatchSafari(element: HTMLElement, kind: string, scale: number, client_x = 100, client_y = 100) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    scale: { value: scale }, clientX: { value: client_x }, clientY: { value: client_y },
  });
  element.dispatchEvent(event);
  return event;
}

function dispatchWheel(element: HTMLElement, delta_y: number, ctrl_key = true, delta_mode = 0) {
  const event = new WheelEvent('wheel', {
    bubbles: true, cancelable: true, ctrlKey: ctrl_key, deltaY: Number.isFinite(delta_y) ? delta_y : 0,
    deltaMode: delta_mode, clientX: 150, clientY: 90,
  });
  if (!Number.isFinite(delta_y)) Object.defineProperty(event, 'deltaY', { value: delta_y });
  element.dispatchEvent(event);
  return event;
}

describe('PDF zoom gestures', () => {
  it('leaves ordinary wheel scrolling and single-touch scrolling/selection untouched', () => {
    const { element, options } = fixture();
    expect(dispatchTouch(element, 'touchstart', [touch(1, 100)]).defaultPrevented).toBe(false);
    expect(dispatchTouch(element, 'touchmove', [touch(1, 120)]).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchend', []);
    expect(dispatchWheel(element, 100, false).defaultPrevented).toBe(false);
    expect(options.on_start).not.toHaveBeenCalled();
    expect(options.on_zoom).not.toHaveBeenCalled();
    expect(options.on_end).not.toHaveBeenCalled();
  });

  it('tracks the same fingers, coalesces updates, and flushes the last pinch before ending', () => {
    const { element, options } = fixture();
    expect(dispatchTouch(element, 'touchstart', [touch(4, 100), touch(8, 200)]).defaultPrevented).toBe(true);
    expect(options.on_start).toHaveBeenCalledWith({ client_x: 150, client_y: 100 });
    // TouchList order can change; a third finger must not change the baseline.
    expect(dispatchTouch(element, 'touchmove', [touch(8, 300), touch(9, 600), touch(4, 100)]).defaultPrevented).toBe(true);
    dispatchTouch(element, 'touchmove', [touch(8, 350), touch(4, 100)]);
    expect(frames.size).toBe(1);
    expect(options.on_zoom).not.toHaveBeenCalled();
    dispatchTouch(element, 'touchend', [touch(4, 100)]);
    expect(options.on_zoom).toHaveBeenCalledExactlyOnceWith(2.5, { client_x: 225, client_y: 100 });
    expect(options.on_end).toHaveBeenCalledExactlyOnceWith(false);
    expect(options.on_zoom.mock.invocationCallOrder[0]).toBeLessThan(options.on_end.mock.invocationCallOrder[0]);
    expect(frames.size).toBe(0);
    expect(dispatchTouch(element, 'touchmove', [touch(4, 120)]).defaultPrevented).toBe(false);
  });

  it('leaves native handling available when the parent rejects starting a gesture', () => {
    const { element, options } = fixture({ on_start: vi.fn(() => false) });
    expect(dispatchTouch(element, 'touchstart', [touch(1, 100), touch(2, 200)]).defaultPrevented).toBe(false);
    expect(dispatchTouch(element, 'touchmove', [touch(1, 100), touch(2, 300)]).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchend', []);
    expect(dispatchSafari(element, 'gesturestart', 1).defaultPrevented).toBe(false);
    expect(dispatchSafari(element, 'gesturechange', 2).defaultPrevented).toBe(false);
    expect(dispatchWheel(element, 100).defaultPrevented).toBe(false);
    expect(options.on_zoom).not.toHaveBeenCalled();
    expect(options.on_end).not.toHaveBeenCalled();
  });

  it('uses Safari cumulative scale from the initial zoom and guards invalid scales and bounds', () => {
    const { element, options } = fixture({ get_zoom: () => 2 });
    expect(dispatchSafari(element, 'gesturestart', 1).defaultPrevented).toBe(true);
    dispatchSafari(element, 'gesturechange', 1.5);
    flushFrame();
    expect(options.on_zoom).toHaveBeenLastCalledWith(3, { client_x: 100, client_y: 100 });
    dispatchSafari(element, 'gesturechange', 2);
    dispatchSafari(element, 'gesturechange', Number.NaN);
    dispatchSafari(element, 'gesturechange', -1);
    dispatchSafari(element, 'gesturechange', 0);
    flushFrame();
    expect(options.on_zoom).toHaveBeenLastCalledWith(4, { client_x: 100, client_y: 100 });
    dispatchSafari(element, 'gesturechange', 0.001);
    dispatchSafari(element, 'gestureend', 0.001);
    expect(options.on_zoom).toHaveBeenLastCalledWith(0.1, { client_x: 100, client_y: 100 });
    expect(options.on_start).toHaveBeenCalledOnce();
    expect(options.on_end).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('accumulates ctrl-wheel zoom and flushes the final update at the idle boundary', () => {
    const { element, options } = fixture();
    expect(dispatchWheel(element, -100).defaultPrevented).toBe(true);
    dispatchWheel(element, -100);
    flushFrame();
    expect(options.on_zoom).toHaveBeenCalledTimes(1);
    expect(options.on_zoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.4));
    dispatchWheel(element, 50);
    vi.advanceTimersByTime(149);
    expect(options.on_end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(options.on_zoom.mock.calls[1][0]).toBeCloseTo(Math.exp(0.3));
    expect(options.on_end).toHaveBeenCalledExactlyOnceWith(false);
    expect(options.on_start).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it('normalizes wheel line/page deltas and rejects unusable gesture input', () => {
    const { element, options } = fixture();
    expect(dispatchSafari(element, 'gesturestart', Number.NaN).defaultPrevented).toBe(false);
    expect(dispatchTouch(element, 'touchstart', [touch(1, 100), touch(2, 100)]).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchend', []);
    expect(dispatchWheel(element, Number.NaN).defaultPrevented).toBe(false);
    expect(dispatchWheel(element, 0).defaultPrevented).toBe(false);
    expect(options.on_start).not.toHaveBeenCalled();
    dispatchWheel(element, -1, true, WheelEvent.DOM_DELTA_LINE);
    flushFrame();
    expect(options.on_zoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.032));
    Object.defineProperty(element, 'clientHeight', { value: 400 });
    dispatchWheel(element, 1, true, WheelEvent.DOM_DELTA_PAGE);
    flushFrame();
    expect(options.on_zoom.mock.calls[1][0]).toBeCloseTo(Math.exp(0.032 - 0.8));
  });

  it('keeps direct touch in control across iOS Safari events and suppresses duplicate wheel zoom', () => {
    const { element, options } = fixture();
    // iOS delivers gesturestart before reporting the second touchstart.
    dispatchTouch(element, 'touchstart', [touch(1, 100)]);
    dispatchSafari(element, 'gesturestart', 1);
    expect(options.on_start).not.toHaveBeenCalled();
    dispatchTouch(element, 'touchstart', [touch(1, 100), touch(2, 200)]);
    dispatchTouch(element, 'touchmove', [touch(1, 100), touch(2, 300)]);
    expect(dispatchSafari(element, 'gesturechange', 2).defaultPrevented).toBe(true);
    expect(dispatchWheel(element, -100).defaultPrevented).toBe(true);
    dispatchSafari(element, 'gestureend', 2);
    expect(options.on_end).not.toHaveBeenCalled();
    dispatchTouch(element, 'touchend', []);
    expect(options.on_zoom).toHaveBeenCalledExactlyOnceWith(2, { client_x: 200, client_y: 100 });
    expect(options.on_start).toHaveBeenCalledOnce();
    expect(dispatchWheel(element, -100).defaultPrevented).toBe(true);
    expect(options.on_start).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(201);
    dispatchSafari(element, 'gesturestart', 1);
    expect(dispatchWheel(element, -100).defaultPrevented).toBe(true);
    dispatchSafari(element, 'gesturechange', 1.25);
    dispatchSafari(element, 'gestureend', 1.25);
    expect(options.on_start).toHaveBeenCalledTimes(2);
    expect(options.on_zoom).toHaveBeenLastCalledWith(2.5, { client_x: 100, client_y: 100 });
  });

  it('transfers a Safari-started gesture to direct touch without restarting or losing applied scale', () => {
    const { element, options } = fixture();
    dispatchSafari(element, 'gesturestart', 1);
    dispatchSafari(element, 'gesturechange', 1.5);
    flushFrame();
    dispatchTouch(element, 'touchstart', [touch(1, 100)]);
    dispatchTouch(element, 'touchstart', [touch(1, 100), touch(2, 200)]);
    dispatchTouch(element, 'touchmove', [touch(1, 100), touch(2, 300)]);
    dispatchTouch(element, 'touchend', []);
    expect(options.on_start).toHaveBeenCalledOnce();
    expect(options.on_end).toHaveBeenCalledExactlyOnceWith(false);
    expect(options.on_zoom).toHaveBeenLastCalledWith(3, { client_x: 200, client_y: 100 });
  });

  it('flushes a valid touch cancellation, but cleanup discards queued updates and is idempotent', () => {
    const touch_fixture = fixture();
    dispatchTouch(touch_fixture.element, 'touchstart', [touch(1, 100), touch(2, 200)]);
    dispatchTouch(touch_fixture.element, 'touchmove', [touch(1, 100), touch(2, 250)]);
    dispatchTouch(touch_fixture.element, 'touchcancel', []);
    expect(touch_fixture.options.on_zoom).toHaveBeenCalledExactlyOnceWith(1.5, { client_x: 175, client_y: 100 });
    expect(touch_fixture.options.on_end).toHaveBeenCalledExactlyOnceWith(false);

    const wheel_fixture = fixture();
    dispatchWheel(wheel_fixture.element, -100);
    wheel_fixture.cleanup();
    wheel_fixture.cleanup();
    flushFrame();
    vi.advanceTimersByTime(1000);
    expect(wheel_fixture.options.on_zoom).not.toHaveBeenCalled();
    expect(wheel_fixture.options.on_end).toHaveBeenCalledExactlyOnceWith(true);
    expect(dispatchWheel(wheel_fixture.element, -100).defaultPrevented).toBe(false);
    expect(wheel_fixture.options.on_start).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});
