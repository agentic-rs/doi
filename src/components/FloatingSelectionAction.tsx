import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Sparkles } from 'lucide-react';
import './floating-selection-action.css';

interface FloatingSelectionActionProps {
  visible: boolean;
  controls_visible?: boolean;
  on_activate: () => void;
}

interface Point {
  x: number;
  y: number;
}

interface Drag {
  pointer_id: number;
  start: Point;
  origin: Point;
  moved: boolean;
}

const BUTTON_SIZE = 48;
const DRAG_THRESHOLD = 6;

/** Keep this mounted while hidden so a reader's chosen position is retained. */
export function FloatingSelectionAction({ visible, controls_visible = true, on_activate }: FloatingSelectionActionProps) {
  const bounds_ref = useRef<HTMLDivElement>(null);
  const button_ref = useRef<HTMLButtonElement>(null);
  const position_ref = useRef<Point | null>(null);
  const bounds_origin = useRef<Point | null>(null);
  const drag_ref = useRef<Drag | null>(null);
  const suppress_click = useRef(false);
  const [position, setPosition] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);

  function placePosition(next: Point | null, bounds = bounds_ref.current?.getBoundingClientRect()) {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const max_x = Math.max(0, bounds.width - BUTTON_SIZE);
    const max_y = Math.max(0, bounds.height - BUTTON_SIZE);
    const clamped = {
      x: Math.min(max_x, Math.max(0, next?.x ?? max_x)),
      y: Math.min(max_y, Math.max(0, next?.y ?? max_y)),
    };
    if (position_ref.current?.x === clamped.x && position_ref.current?.y === clamped.y) return;
    position_ref.current = clamped;
    setPosition(clamped);
  }

  function releasePointer(pointer_id: number) {
    const button = button_ref.current;
    if (button?.hasPointerCapture?.(pointer_id)) button.releasePointerCapture(pointer_id);
  }

  function cancelDrag() {
    const drag = drag_ref.current;
    if (!drag) return;
    drag_ref.current = null;
    suppress_click.current = true;
    releasePointer(drag.pointer_id);
    setDragging(false);
  }

  useLayoutEffect(() => {
    if (!visible) {
      cancelDrag();
      setDragging(false);
      return;
    }
    const bounds = bounds_ref.current;
    if (!bounds) return;
    const resize = () => {
      cancelDrag();
      setDragging(false);
      const rect = bounds.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const previous_origin = bounds_origin.current;
      const previous_position = position_ref.current;
      bounds_origin.current = { x: rect.left, y: rect.top };
      // Controls and safe areas move the bounds; keep the chosen screen position.
      const next = previous_position && previous_origin ? {
        x: previous_position.x + previous_origin.x - rect.left,
        y: previous_position.y + previous_origin.y - rect.top,
      } : previous_position;
      placePosition(next, rect);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(bounds);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      const drag = drag_ref.current;
      drag_ref.current = null;
      if (drag) {
        suppress_click.current = true;
        releasePointer(drag.pointer_id);
      }
    };
  }, [visible, controls_visible]);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag_ref.current) return;
    // Preserve the source text selection instead of moving focus into this button.
    event.preventDefault();
    event.stopPropagation();
    const bounds = bounds_ref.current?.getBoundingClientRect();
    const button = event.currentTarget.getBoundingClientRect();
    if (!bounds) return;
    suppress_click.current = false;
    drag_ref.current = {
      pointer_id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { x: button.left - bounds.left, y: button.top - bounds.top },
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = drag_ref.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const delta_x = event.clientX - drag.start.x;
    const delta_y = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(delta_x, delta_y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    suppress_click.current = true;
    setDragging(true);
    placePosition({ x: drag.origin.x + delta_x, y: drag.origin.y + delta_y });
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = drag_ref.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    event.stopPropagation();
    drag_ref.current = null;
    suppress_click.current = drag.moved;
    releasePointer(event.pointerId);
    setDragging(false);
  }

  return <div ref={bounds_ref} className="floating-selection-action" data-controls-visible={controls_visible || undefined} hidden={!visible}>
    <button
      ref={button_ref}
      type="button"
      className="floating-selection-button"
      aria-label="Ask AI or add a note to this passage"
      title="Ask AI or add a note"
      data-dragging={dragging || undefined}
      style={position ? { left: position.x, top: position.y } : undefined}
      draggable={false}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => {
        if (event.pointerId === drag_ref.current?.pointer_id) cancelDrag();
      }}
      onLostPointerCapture={(event) => {
        if (event.pointerId === drag_ref.current?.pointer_id) cancelDrag();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') suppress_click.current = false;
      }}
      onClick={(event) => {
        event.stopPropagation();
        // Keyboard and assistive activation have no pointer click count.
        if (suppress_click.current && event.detail > 0) {
          event.preventDefault();
          return;
        }
        on_activate();
      }}
    ><Sparkles size={21} aria-hidden="true" /></button>
  </div>;
}
