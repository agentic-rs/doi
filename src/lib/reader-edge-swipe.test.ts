// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachReaderEdgeSwipe, type ReaderEdgeSwipeOptions } from './reader-edge-swipe';

let cleanups: (() => void)[];

beforeEach(() => {
  cleanups = [];
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 390);
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(overrides: Partial<ReaderEdgeSwipeOptions> = {}) {
  const element = document.createElement('div');
  const child = document.createElement('span');
  element.append(child);
  document.body.append(element);
  const bounds = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 60, right: 390, bottom: 800, width: 390, height: 740, x: 0, y: 60, toJSON: () => ({}),
  });
  const options = {
    can_start: vi.fn(overrides.can_start ?? (() => true)),
    is_current: vi.fn(overrides.is_current ?? (() => true)),
    on_claim: vi.fn(overrides.on_claim ?? (() => {})),
    on_progress: vi.fn(overrides.on_progress ?? (() => {})),
    on_complete: vi.fn(overrides.on_complete ?? (() => {})),
  };
  const cleanup = attachReaderEdgeSwipe(element, options);
  cleanups.push(cleanup);
  return { element, child, bounds, options, cleanup };
}

function touch(identifier: number, client_x: number, client_y = 200): Touch {
  return { identifier, clientX: client_x, clientY: client_y } as Touch;
}

function dispatchTouch(target: EventTarget, kind: string, touches: Touch[], changed_touches = touches, cancelable = true) {
  const event = new Event(kind, { bubbles: true, cancelable });
  Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changed_touches } });
  target.dispatchEvent(event);
  return event;
}

function click(target: EventTarget, client_x: number, client_y = 200, detail = 1) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: client_x, clientY: client_y, detail });
  target.dispatchEvent(event);
  return event;
}

describe('reader left-edge swipe', () => {
  it('leaves a tap untouched and claims a deliberate right drag before ordinary reader handlers', () => {
    const { child, element, options, bounds } = fixture();
    const ordinary_move = vi.fn();
    element.addEventListener('touchmove', ordinary_move);
    expect(dispatchTouch(child, 'touchstart', [touch(7, 12)]).defaultPrevented).toBe(false);
    expect(dispatchTouch(child, 'touchmove', [touch(7, 17)]).defaultPrevented).toBe(false);
    expect(options.on_claim).not.toHaveBeenCalled();
    expect(options.on_progress).not.toHaveBeenCalled();
    expect(dispatchTouch(child, 'touchmove', [touch(7, 32, 203)]).defaultPrevented).toBe(true);
    expect(ordinary_move).toHaveBeenCalledTimes(1);
    expect(options.on_claim).toHaveBeenCalledOnce();
    expect(options.on_progress).toHaveBeenLastCalledWith({ progress: 20 / 85.8, client_y: 200, ready: false });
    expect(dispatchTouch(child, 'touchmove', [touch(7, 130, 207)]).defaultPrevented).toBe(true);
    expect(options.on_progress).toHaveBeenLastCalledWith({ progress: 1, client_y: 200, ready: true });
    expect(options.on_complete).not.toHaveBeenCalled();
    expect(bounds).toHaveBeenCalledOnce();
    expect(dispatchTouch(child, 'touchend', [], [touch(7, 130, 207)]).defaultPrevented).toBe(true);
    expect(options.on_progress).toHaveBeenLastCalledWith(null);
    expect(options.on_complete).toHaveBeenCalledOnce();
    expect(options.on_progress.mock.invocationCallOrder.at(-1)).toBeLessThan(options.on_complete.mock.invocationCallOrder[0]);
    expect(bounds).toHaveBeenCalledOnce();
  });

  it('never claims taps or completes a short swipe', () => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    expect(dispatchTouch(element, 'touchend', [], [touch(1, 14)]).defaultPrevented).toBe(false);
    expect(options.on_progress).not.toHaveBeenCalled();
    expect(click(element, 14).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchstart', [touch(2, 12)]);
    dispatchTouch(element, 'touchmove', [touch(2, 42)]);
    dispatchTouch(element, 'touchend', [], [touch(2, 42)]);
    expect(options.on_claim).toHaveBeenCalledOnce();
    expect(options.on_progress).toHaveBeenLastCalledWith(null);
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it.each([
    ['outside the edge', 25, 200], ['negative screen coordinate', -1, 200],
    ['above the reader', 12, 59], ['below the reader', 12, 801], ['invalid coordinate', NaN, 200],
  ])('ignores a start %s', (_reason, x, y) => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, x, y)]);
    expect(dispatchTouch(element, 'touchmove', [touch(1, 150, y)]).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchend', [], [touch(1, 150, y)]);
    expect(options.on_claim).not.toHaveBeenCalled();
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it('requires the reader to occupy the left screen edge, not a panel interior edge', () => {
    const { element, bounds, options } = fixture();
    bounds.mockReturnValue({ ...element.getBoundingClientRect(), left: 10, right: 400 });
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    dispatchTouch(element, 'touchmove', [touch(1, 150)]);
    dispatchTouch(element, 'touchend', [], [touch(1, 150)]);
    expect(options.on_claim).not.toHaveBeenCalled();
  });

  it.each([
    ['vertical scrolling', 18, 240], ['leftward panning', 1, 200], ['diagonal scrolling', 42, 225],
  ])('releases the candidate for %s without later changing its mind', (_reason, x, y) => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    expect(dispatchTouch(element, 'touchmove', [touch(1, x, y)]).defaultPrevented).toBe(false);
    expect(dispatchTouch(element, 'touchmove', [touch(1, 180)]).defaultPrevented).toBe(false);
    dispatchTouch(element, 'touchend', [], [touch(1, 180)]);
    expect(options.on_claim).not.toHaveBeenCalled();
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it('uses the release position so crossing the threshold and dragging back cancels', () => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    dispatchTouch(element, 'touchmove', [touch(1, 130)]);
    expect(options.on_progress).toHaveBeenLastCalledWith({ progress: 1, client_y: 200, ready: true });
    dispatchTouch(element, 'touchmove', [touch(1, 60)]);
    expect(options.on_progress.mock.calls.at(-1)![0]!.ready).toBe(false);
    // The last touchend can travel farther back than the final touchmove.
    dispatchTouch(element, 'touchend', [], [touch(1, 30)]);
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it.each(['touchcancel', 'blur', 'resize', 'orientationchange'])('cancels without navigation on %s', (kind) => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    dispatchTouch(element, 'touchmove', [touch(1, 130)]);
    if (kind === 'touchcancel') dispatchTouch(element, kind, [], [touch(1, 130)]);
    else window.dispatchEvent(new Event(kind));
    dispatchTouch(element, 'touchend', [], [touch(1, 130)]);
    expect(options.on_progress).toHaveBeenLastCalledWith(null);
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it('leaves pinch available and cancels if a second finger starts outside the reader', () => {
    const { element, options } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12), touch(2, 150)]);
    expect(dispatchTouch(element, 'touchmove', [touch(1, 40), touch(2, 200)]).defaultPrevented).toBe(false);
    expect(options.on_claim).not.toHaveBeenCalled();
    dispatchTouch(element, 'touchend', [], [touch(1, 40), touch(2, 200)]);
    dispatchTouch(element, 'touchstart', [touch(3, 12)]);
    dispatchTouch(element, 'touchmove', [touch(3, 120)]);
    const outside = document.createElement('div');
    document.body.append(outside);
    expect(dispatchTouch(outside, 'touchstart', [touch(3, 120), touch(4, 200)]).defaultPrevented).toBe(false);
    expect(options.on_progress).toHaveBeenLastCalledWith(null);
    dispatchTouch(element, 'touchend', [], [touch(3, 120)]);
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it('rejects changed touch identity, missing release identity, and an uncancelable native move', () => {
    for (const invalid of ['identity', 'release', 'noncancelable']) {
      const { element, options } = fixture();
      dispatchTouch(element, 'touchstart', [touch(1, 12)]);
      dispatchTouch(element, 'touchmove', [touch(1, 130)]);
      if (invalid === 'identity') dispatchTouch(element, 'touchmove', [touch(2, 150)]);
      if (invalid === 'noncancelable') {
        expect(dispatchTouch(element, 'touchmove', [touch(1, 150)], undefined, false).defaultPrevented).toBe(false);
      }
      dispatchTouch(element, 'touchend', [], [touch(invalid === 'release' ? 2 : 1, 150)]);
      expect(options.on_progress).toHaveBeenLastCalledWith(null);
      expect(options.on_complete).not.toHaveBeenCalled();
    }
  });

  it('honors start guards and changing reader identity/state during the gesture or release', () => {
    const blocked = fixture({ can_start: () => false });
    dispatchTouch(blocked.child, 'touchstart', [touch(1, 12)]);
    dispatchTouch(blocked.child, 'touchmove', [touch(1, 130)]);
    expect(blocked.options.can_start).toHaveBeenCalledWith(blocked.child);
    expect(blocked.options.on_claim).not.toHaveBeenCalled();
    for (const phase of ['start', 'move', 'release']) {
      let valid = phase !== 'start';
      const { element, options } = fixture({ is_current: () => valid });
      dispatchTouch(element, 'touchstart', [touch(1, 12)]);
      dispatchTouch(element, 'touchmove', [touch(1, 130)]);
      valid = false;
      if (phase === 'move') dispatchTouch(element, 'touchmove', [touch(1, 150)]);
      dispatchTouch(element, 'touchend', [], [touch(1, 150)]);
      expect(options.on_complete).not.toHaveBeenCalled();
    }
  });

  it('cancels if claiming invalidates the reader and never emits a stale preview', () => {
    let valid = true;
    const { element, options } = fixture({ is_current: () => valid, on_claim: () => { valid = false; } });
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    dispatchTouch(element, 'touchmove', [touch(1, 130)]);
    dispatchTouch(element, 'touchend', [], [touch(1, 130)]);
    expect(options.on_claim).toHaveBeenCalledOnce();
    expect(options.on_progress).toHaveBeenCalledExactlyOnceWith(null);
    expect(options.on_complete).not.toHaveBeenCalled();
  });

  it('bounds the completion distance on narrow phones and wider tablets', () => {
    for (const [width, threshold] of [[300, 72], [1024, 112]]) {
      vi.stubGlobal('innerWidth', width);
      const { element, options } = fixture();
      dispatchTouch(element, 'touchstart', [touch(1, 12)]);
      dispatchTouch(element, 'touchmove', [touch(1, 12 + threshold - 1)]);
      expect(options.on_progress.mock.calls.at(-1)![0]!.ready).toBe(false);
      dispatchTouch(element, 'touchmove', [touch(1, 12 + threshold)]);
      expect(options.on_progress.mock.calls.at(-1)![0]!.ready).toBe(true);
      dispatchTouch(element, 'touchend', [], [touch(1, 12 + threshold)]);
      expect(options.on_complete).toHaveBeenCalledOnce();
    }
  });

  it('suppresses a synthesized click after an owned short or completed swipe', () => {
    for (const distance of [40, 130]) {
      const { child, options } = fixture();
      const target_click = vi.fn();
      child.addEventListener('click', target_click);
      dispatchTouch(child, 'touchstart', [touch(1, 12)]);
      dispatchTouch(child, 'touchmove', [touch(1, distance)]);
      dispatchTouch(child, 'touchend', [], [touch(1, distance)]);
      expect(click(child, distance).defaultPrevented).toBe(true);
      expect(target_click).not.toHaveBeenCalled();
      expect(options.on_complete).toHaveBeenCalledTimes(distance === 130 ? 1 : 0);
      expect(click(child, distance).defaultPrevented).toBe(false);
    }
  });

  it('does not suppress a later independent tap, keyboard click, distant click, or expired click', () => {
    for (const kind of ['new-touch', 'keyboard', 'distant', 'expired']) {
      const { element } = fixture();
      dispatchTouch(element, 'touchstart', [touch(1, 12)]);
      dispatchTouch(element, 'touchmove', [touch(1, 120)]);
      dispatchTouch(element, 'touchend', [], [touch(1, 120)]);
      if (kind === 'new-touch') {
        dispatchTouch(document.body, 'touchstart', [touch(2, 120)]);
        dispatchTouch(document.body, 'touchend', [], [touch(2, 120)]);
      }
      if (kind === 'expired') vi.advanceTimersByTime(701);
      expect(click(element, kind === 'distant' ? 300 : 120, 200, kind === 'keyboard' ? 0 : 1).defaultPrevented).toBe(false);
    }
  });

  it('cancels for a removed reader and cleanup is idempotent and detaches listeners', () => {
    const { element, options, cleanup } = fixture();
    dispatchTouch(element, 'touchstart', [touch(1, 12)]);
    dispatchTouch(element, 'touchmove', [touch(1, 130)]);
    element.remove();
    dispatchTouch(element, 'touchend', [], [touch(1, 130)]);
    expect(options.on_complete).not.toHaveBeenCalled();
    document.body.append(element);
    dispatchTouch(element, 'touchstart', [touch(2, 12)]);
    dispatchTouch(element, 'touchmove', [touch(2, 130)]);
    cleanup();
    cleanup();
    expect(options.on_progress).toHaveBeenLastCalledWith(null);
    const calls = options.on_progress.mock.calls.length;
    dispatchTouch(element, 'touchend', [], [touch(2, 130)]);
    window.dispatchEvent(new Event('resize'));
    dispatchTouch(element, 'touchstart', [touch(3, 12)]);
    expect(dispatchTouch(element, 'touchmove', [touch(3, 130)]).defaultPrevented).toBe(false);
    expect(click(element, 130).defaultPrevented).toBe(false);
    expect(options.on_progress).toHaveBeenCalledTimes(calls);
    expect(options.on_complete).not.toHaveBeenCalled();
  });
});
