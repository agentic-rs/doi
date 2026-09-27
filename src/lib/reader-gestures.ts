export interface ReaderGesture {
  pointer_id: number;
  start_x: number;
  start_y: number;
  started_at: number;
  cancelled: boolean;
}

export interface ReaderPointerStart {
  pointer_id: number;
  client_x: number;
  client_y: number;
  timestamp: number;
  is_primary: boolean;
  button: number;
  interactive_target: boolean;
  has_selection: boolean;
}

export interface ReaderPointerEnd {
  pointer_id: number;
  client_x: number;
  client_y: number;
  timestamp: number;
  interactive_target: boolean;
  has_selection: boolean;
  last_scroll_at: number;
  last_selection_at: number;
}

const tap_distance = 10;
const tap_duration = 320;
const scroll_settle_duration = 180;
const selection_settle_duration = 250;

export function startReaderGesture(pointer: ReaderPointerStart): ReaderGesture | null {
  if (!pointer.is_primary || pointer.button !== 0 || pointer.interactive_target || pointer.has_selection) return null;
  return {
    pointer_id: pointer.pointer_id,
    start_x: pointer.client_x,
    start_y: pointer.client_y,
    started_at: pointer.timestamp,
    cancelled: false,
  };
}

export function moveReaderGesture(gesture: ReaderGesture | null, pointer_id: number, client_x: number, client_y: number): void {
  if (!gesture) return;
  if (pointer_id !== gesture.pointer_id || Math.hypot(client_x - gesture.start_x, client_y - gesture.start_y) > tap_distance) {
    gesture.cancelled = true;
  }
}

export function isReaderTap(gesture: ReaderGesture | null, pointer: ReaderPointerEnd): boolean {
  if (!gesture || gesture.cancelled || pointer.pointer_id !== gesture.pointer_id) return false;
  const duration = pointer.timestamp - gesture.started_at;
  return duration >= 0 && duration <= tap_duration
    && Math.hypot(pointer.client_x - gesture.start_x, pointer.client_y - gesture.start_y) <= tap_distance
    && !pointer.interactive_target && !pointer.has_selection
    && pointer.timestamp - pointer.last_scroll_at >= scroll_settle_duration
    && pointer.timestamp - pointer.last_selection_at >= selection_settle_duration;
}

export function interactiveReaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]'));
}
