export interface PdfZoomPoint {
  client_x: number;
  client_y: number;
}

export interface PdfZoomGestureOptions {
  get_zoom: () => number;
  minimum_zoom: number;
  maximum_zoom: number;
  on_start: (point: PdfZoomPoint) => boolean;
  on_zoom: (zoom: number, point: PdfZoomPoint) => void;
  on_end: () => void;
}

type TouchPair = [Touch, Touch];
type SafariGestureEvent = Event & { scale: number; clientX?: number; clientY?: number };
type ZoomGesture =
  | { kind: 'touch'; base_zoom: number; touch_ids: [number, number]; initial_distance: number }
  | { kind: 'safari'; base_zoom: number }
  | { kind: 'wheel'; current_zoom: number };

const wheel_end_delay = 150;
const native_wheel_suppression = 200;
const wheel_zoom_rate = 0.002;

function touchDistance(pair: TouchPair): number {
  return Math.hypot(pair[1].clientX - pair[0].clientX, pair[1].clientY - pair[0].clientY);
}

function touchCenter(pair: TouchPair): PdfZoomPoint {
  return {
    client_x: (pair[0].clientX + pair[1].clientX) / 2,
    client_y: (pair[0].clientY + pair[1].clientY) / 2,
  };
}

function validPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function attachPdfZoomGestures(element: HTMLElement, options: PdfZoomGestureOptions): () => void {
  let gesture: ZoomGesture | null = null;
  let pending: { zoom: number; point: PdfZoomPoint } | null = null;
  let frame: number | null = null;
  let wheel_timer: ReturnType<typeof setTimeout> | null = null;
  let wheel_suppressed_until = 0;
  let detached = false;
  let touch_sequence = false;

  function boundedZoom(value: number): number {
    return Math.min(options.maximum_zoom, Math.max(options.minimum_zoom, value));
  }

  function initialZoom(): number | null {
    const value = options.get_zoom();
    return validPositive(value) ? boundedZoom(value) : null;
  }

  function preventNative(event: Event) {
    if (event.cancelable) event.preventDefault();
  }

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function clearWheelTimer() {
    if (wheel_timer !== null) clearTimeout(wheel_timer);
    wheel_timer = null;
  }

  function flushUpdate() {
    const update = pending;
    pending = null;
    if (update) options.on_zoom(update.zoom, update.point);
  }

  function updateZoom(value: number, point: PdfZoomPoint) {
    if (!validPositive(value) || !Number.isFinite(point.client_x) || !Number.isFinite(point.client_y)) return;
    pending = { zoom: boundedZoom(value), point };
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null;
        flushUpdate();
      });
    }
  }

  function finishGesture() {
    if (!gesture) return;
    const native_gesture = gesture.kind !== 'wheel';
    gesture = null;
    clearWheelTimer();
    cancelFrame();
    if (native_gesture) wheel_suppressed_until = Date.now() + native_wheel_suppression;
    flushUpdate();
    options.on_end();
  }

  function trackedTouches(touches: TouchList, ids: [number, number]): TouchPair | null {
    const all = Array.from(touches);
    const first = all.find((touch) => touch.identifier === ids[0]);
    const second = all.find((touch) => touch.identifier === ids[1]);
    return first && second ? [first, second] : null;
  }

  function startTouch(event: TouchEvent) {
    // iOS sends gesturestart between the first and second touchstart. Record
    // the sequence now so the direct-touch path can own the actual pinch.
    touch_sequence = event.touches.length > 0;
    if (event.touches.length < 2) return;
    if (gesture?.kind === 'touch') {
      preventNative(event);
      return;
    }
    const pair: TouchPair = [event.touches[0], event.touches[1]];
    const distance = touchDistance(pair);
    if (!validPositive(distance)) return;
    const point = touchCenter(pair);
    // WebKit can deliver gesturestart before the second touchstart. Transfer
    // ownership without beginning the same physical pinch twice.
    if (gesture?.kind === 'safari') {
      const base_zoom = pending?.zoom ?? initialZoom() ?? gesture.base_zoom;
      gesture = { kind: 'touch', base_zoom, touch_ids: [pair[0].identifier, pair[1].identifier], initial_distance: distance };
      preventNative(event);
      return;
    }
    if (gesture) finishGesture();
    const base_zoom = initialZoom();
    if (base_zoom === null || !options.on_start(point)) return;
    gesture = { kind: 'touch', base_zoom, touch_ids: [pair[0].identifier, pair[1].identifier], initial_distance: distance };
    preventNative(event);
  }

  function moveTouch(event: TouchEvent) {
    if (gesture?.kind !== 'touch') return;
    const pair = trackedTouches(event.touches, gesture.touch_ids);
    if (!pair) {
      finishGesture();
      return;
    }
    preventNative(event);
    updateZoom(gesture.base_zoom * touchDistance(pair) / gesture.initial_distance, touchCenter(pair));
  }

  function endTouch(event: TouchEvent) {
    touch_sequence = event.touches.length > 0;
    if (gesture?.kind === 'touch' && !trackedTouches(event.touches, gesture.touch_ids)) finishGesture();
  }

  function cancelTouch(event: TouchEvent) {
    touch_sequence = event.touches.length > 0;
    if (gesture?.kind === 'touch') finishGesture();
  }

  function safariPoint(event: SafariGestureEvent): PdfZoomPoint {
    if (typeof event.clientX === 'number' && typeof event.clientY === 'number'
      && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      return { client_x: event.clientX, client_y: event.clientY };
    }
    const bounds = element.getBoundingClientRect();
    return { client_x: bounds.left + bounds.width / 2, client_y: bounds.top + bounds.height / 2 };
  }

  function startSafari(event: Event) {
    if (touch_sequence) {
      if (gesture?.kind === 'touch') preventNative(event);
      return;
    }
    if (gesture?.kind === 'touch' || gesture?.kind === 'safari') {
      preventNative(event);
      return;
    }
    const safari_event = event as SafariGestureEvent;
    if (!validPositive(safari_event.scale)) return;
    if (gesture) finishGesture();
    const base_zoom = initialZoom();
    if (base_zoom === null || !options.on_start(safariPoint(safari_event))) return;
    gesture = { kind: 'safari', base_zoom };
    preventNative(event);
  }

  function changeSafari(event: Event) {
    if (gesture?.kind === 'touch') {
      preventNative(event);
      return;
    }
    if (gesture?.kind !== 'safari') return;
    preventNative(event);
    const safari_event = event as SafariGestureEvent;
    updateZoom(gesture.base_zoom * safari_event.scale, safariPoint(safari_event));
  }

  function endSafari(event: Event) {
    if (gesture?.kind === 'touch') {
      preventNative(event);
      return;
    }
    if (gesture?.kind !== 'safari') return;
    preventNative(event);
    finishGesture();
  }

  function wheelZoom(event: WheelEvent) {
    if (!event.ctrlKey) return;
    if (gesture?.kind === 'touch' || gesture?.kind === 'safari' || Date.now() < wheel_suppressed_until) {
      preventNative(event);
      return;
    }
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const point = { client_x: event.clientX, client_y: event.clientY };
    if (!gesture) {
      const zoom = initialZoom();
      if (zoom === null || !options.on_start(point)) return;
      gesture = { kind: 'wheel', current_zoom: zoom };
    }
    if (gesture.kind !== 'wheel') return;
    preventNative(event);
    const delta_factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(1, element.clientHeight || window.innerHeight) : 1;
    const exponent = Math.min(20, Math.max(-20, -event.deltaY * delta_factor * wheel_zoom_rate));
    gesture.current_zoom = boundedZoom(gesture.current_zoom * Math.exp(exponent));
    updateZoom(gesture.current_zoom, point);
    clearWheelTimer();
    wheel_timer = setTimeout(finishGesture, wheel_end_delay);
  }

  const touch_options: AddEventListenerOptions = { passive: false };
  element.addEventListener('touchstart', startTouch, touch_options);
  element.addEventListener('touchmove', moveTouch, touch_options);
  element.addEventListener('touchend', endTouch, touch_options);
  element.addEventListener('touchcancel', cancelTouch, touch_options);
  element.addEventListener('gesturestart', startSafari, touch_options);
  element.addEventListener('gesturechange', changeSafari, touch_options);
  element.addEventListener('gestureend', endSafari, touch_options);
  element.addEventListener('wheel', wheelZoom, touch_options);

  return () => {
    if (detached) return;
    detached = true;
    element.removeEventListener('touchstart', startTouch);
    element.removeEventListener('touchmove', moveTouch);
    element.removeEventListener('touchend', endTouch);
    element.removeEventListener('touchcancel', cancelTouch);
    element.removeEventListener('gesturestart', startSafari);
    element.removeEventListener('gesturechange', changeSafari);
    element.removeEventListener('gestureend', endSafari);
    element.removeEventListener('wheel', wheelZoom);
    const active = gesture !== null;
    gesture = null;
    cancelFrame();
    clearWheelTimer();
    pending = null;
    if (active) options.on_end();
  };
}
