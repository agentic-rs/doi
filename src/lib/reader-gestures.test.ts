import { describe, expect, it } from 'vitest';
import { isReaderTap, moveReaderGesture, startReaderGesture } from './reader-gestures';
import type { ReaderPointerEnd, ReaderPointerStart } from './reader-gestures';

const start: ReaderPointerStart = {
  pointer_id: 1, client_x: 30, client_y: 40, timestamp: 1_000,
  is_primary: true, button: 0, interactive_target: false, has_selection: false,
};
const end: ReaderPointerEnd = {
  pointer_id: 1, client_x: 31, client_y: 41, timestamp: 1_120,
  interactive_target: false, has_selection: false, last_scroll_at: 0, last_selection_at: 0,
};

describe('reading-control tap gestures', () => {
  it('accepts a short, stationary tap on the reading surface', () => {
    expect(isReaderTap(startReaderGesture(start), end)).toBe(true);
  });

  it('keeps text selection and embedded links available', () => {
    expect(startReaderGesture({ ...start, has_selection: true })).toBeNull();
    expect(startReaderGesture({ ...start, interactive_target: true })).toBeNull();
    expect(isReaderTap(startReaderGesture(start), { ...end, has_selection: true })).toBe(false);
    expect(isReaderTap(startReaderGesture(start), { ...end, interactive_target: true })).toBe(false);
    expect(isReaderTap(startReaderGesture(start), { ...end, last_selection_at: 1_000 })).toBe(false);
  });

  it('ignores long presses, secondary pointers, and mouse context clicks', () => {
    expect(isReaderTap(startReaderGesture(start), { ...end, timestamp: 1_500 })).toBe(false);
    expect(startReaderGesture({ ...start, is_primary: false })).toBeNull();
    expect(startReaderGesture({ ...start, button: 2 })).toBeNull();
    expect(isReaderTap(startReaderGesture(start), { ...end, pointer_id: 2 })).toBe(false);
  });

  it('does not treat a drag returning to its origin as a tap', () => {
    const gesture = startReaderGesture(start);
    moveReaderGesture(gesture, 1, 60, 40);
    moveReaderGesture(gesture, 1, 30, 40);
    expect(isReaderTap(gesture, end)).toBe(false);
  });

  it('cancels multiple-touch gestures and taps during scrolling', () => {
    const gesture = startReaderGesture(start);
    moveReaderGesture(gesture, 2, 30, 40);
    expect(isReaderTap(gesture, end)).toBe(false);
    expect(isReaderTap(startReaderGesture(start), { ...end, last_scroll_at: 1_100 })).toBe(false);
  });
});
