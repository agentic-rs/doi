export interface ReaderEdgeSwipePreview {
  progress: number;
  client_y: number;
  ready: boolean;
}

export interface ReaderEdgeSwipeOptions {
  can_start: (target: EventTarget | null) => boolean;
  is_current: () => boolean;
  on_claim: () => void;
  on_progress: (preview: ReaderEdgeSwipePreview | null) => void;
  on_complete: () => void;
}

interface EdgeSwipe {
  touch_id: number;
  start_x: number;
  start_y: number;
  client_x: number;
  client_y: number;
  threshold: number;
  claimed: boolean;
}

const edge_width = 24;
const claim_distance = 8;
const click_delay = 700;

function finiteTouch(touch: Touch): boolean {
  return Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY);
}

/** Owns only deliberate, single-finger drags that begin at the screen's left edge. */
export function attachReaderEdgeSwipe(element: HTMLElement, options: ReaderEdgeSwipeOptions): () => void {
  const owner_document = element.ownerDocument;
  const view = owner_document.defaultView;
  if (!view) return () => {};

  let gesture: EdgeSwipe | null = null;
  let suppressed_click: { client_x: number; client_y: number; until: number } | null = null;
  let detached = false;

  function isCurrent(): boolean {
    return !detached && element.isConnected && options.is_current();
  }

  function stopNative(event: Event) {
    if (event.cancelable) event.preventDefault();
    // The reader's ordinary touch/tap handlers must not interpret an owned swipe.
    event.stopPropagation();
  }

  function clearGesture() {
    const previous = gesture;
    gesture = null;
    if (previous?.claimed) {
      suppressed_click = { client_x: previous.client_x, client_y: previous.client_y, until: Date.now() + click_delay };
      options.on_progress(null);
    }
  }

  function observeTouchStart(event: TouchEvent) {
    // A later independent tap must never be swallowed by the fallback for a
    // synthesized click from the preceding swipe (even if that tap is elsewhere).
    suppressed_click = null;
    if (gesture && event.touches.length !== 1) clearGesture();
  }

  function startTouch(event: TouchEvent) {
    if (gesture || event.defaultPrevented || event.touches.length !== 1 || !isCurrent() || !options.can_start(event.target)) return;
    const touch = event.touches[0];
    if (!finiteTouch(touch) || touch.clientX < 0 || touch.clientX > edge_width) return;
    const bounds = element.getBoundingClientRect();
    const viewport_width = view!.innerWidth;
    if (!Number.isFinite(viewport_width) || viewport_width <= 0 || Math.abs(bounds.left) > 1
      || touch.clientX < bounds.left || touch.clientX > bounds.right
      || touch.clientY < bounds.top || touch.clientY > bounds.bottom) return;
    gesture = {
      touch_id: touch.identifier, start_x: touch.clientX, start_y: touch.clientY,
      client_x: touch.clientX, client_y: touch.clientY,
      threshold: Math.min(112, Math.max(72, viewport_width * 0.22)), claimed: false,
    };
  }

  function moveTouch(event: TouchEvent) {
    const current = gesture;
    if (!current) return;
    const touch = event.touches[0];
    if (!isCurrent() || event.defaultPrevented || !event.cancelable || event.touches.length !== 1
      || touch.identifier !== current.touch_id || !finiteTouch(touch)) {
      clearGesture();
      return;
    }
    current.client_x = touch.clientX;
    current.client_y = touch.clientY;
    const distance_x = touch.clientX - current.start_x;
    const distance_y = Math.abs(touch.clientY - current.start_y);
    if (distance_x <= -claim_distance || (distance_y >= claim_distance && distance_x <= 2 * distance_y)) {
      clearGesture();
      return;
    }
    if (!current.claimed) {
      if (distance_x < claim_distance || distance_x <= 2 * distance_y) return;
      current.claimed = true;
      stopNative(event);
      options.on_claim();
      if (gesture !== current || !isCurrent()) {
        clearGesture();
        return;
      }
    } else {
      stopNative(event);
    }
    options.on_progress({
      progress: Math.min(1, Math.max(0, distance_x / current.threshold)),
      client_y: current.start_y,
      ready: distance_x >= current.threshold,
    });
  }

  function endTouch(event: TouchEvent) {
    const current = gesture;
    if (!current) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.touch_id);
    const valid_release = isCurrent() && !event.defaultPrevented && event.touches.length === 0 && touch && finiteTouch(touch);
    if (touch && finiteTouch(touch)) {
      current.client_x = touch.clientX;
      current.client_y = touch.clientY;
    }
    const distance_x = current.client_x - current.start_x;
    const distance_y = Math.abs(current.client_y - current.start_y);
    const complete = valid_release && current.claimed && distance_x >= current.threshold && distance_x > 2 * distance_y;
    if (current.claimed) stopNative(event);
    clearGesture();
    if (complete) options.on_complete();
  }

  function cancelTouch() {
    clearGesture();
  }

  function suppressClick(event: MouseEvent) {
    const suppression = suppressed_click;
    if (!suppression) return;
    suppressed_click = null;
    if (Date.now() > suppression.until || event.detail === 0
      || Math.hypot(event.clientX - suppression.client_x, event.clientY - suppression.client_y) > 32) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const touch_options: AddEventListenerOptions = { capture: true, passive: false };
  owner_document.addEventListener('touchstart', observeTouchStart, { capture: true, passive: true });
  element.addEventListener('touchstart', startTouch, touch_options);
  element.addEventListener('touchmove', moveTouch, touch_options);
  element.addEventListener('touchend', endTouch, touch_options);
  element.addEventListener('touchcancel', cancelTouch, touch_options);
  element.addEventListener('click', suppressClick, true);
  view.addEventListener('blur', cancelTouch);
  view.addEventListener('resize', cancelTouch);
  view.addEventListener('orientationchange', cancelTouch);

  return () => {
    if (detached) return;
    detached = true;
    clearGesture();
    suppressed_click = null;
    owner_document.removeEventListener('touchstart', observeTouchStart, true);
    element.removeEventListener('touchstart', startTouch, true);
    element.removeEventListener('touchmove', moveTouch, true);
    element.removeEventListener('touchend', endTouch, true);
    element.removeEventListener('touchcancel', cancelTouch, true);
    element.removeEventListener('click', suppressClick, true);
    view.removeEventListener('blur', cancelTouch);
    view.removeEventListener('resize', cancelTouch);
    view.removeEventListener('orientationchange', cancelTouch);
  };
}
