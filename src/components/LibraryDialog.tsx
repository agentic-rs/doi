import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import './library-dialog.css';

interface LibraryDialogProps {
  dialog_key: string;
  title_id: string;
  description_id?: string;
  class_name?: string;
  dismissible: boolean;
  on_cancel: () => void;
  initial_focus?: 'dialog' | 'cancel';
  children: ReactNode;
}

export function LibraryDialog(props: LibraryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]',
    )).filter((element) => element.tabIndex >= 0 && !element.closest('[hidden], [inert]'));
    const initial = latest.current.initial_focus === 'cancel'
      ? dialog.querySelector<HTMLButtonElement>('[data-dialog-cancel]') : dialog;
    initial?.focus({ preventScroll: true });

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (latest.current.dismissible) latest.current.on_cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      const inside = items.includes(document.activeElement as HTMLElement);
      if (!first || !last) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
      } else if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    function keepFocus(event: FocusEvent) {
      if (event.target instanceof Node && !dialog?.contains(event.target)) {
        (controls()[0] ?? dialog)?.focus({ preventScroll: true });
      }
    }

    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('focusin', keepFocus, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('focusin', keepFocus, true);
      if (previous?.isConnected && !previous.closest('[inert]')) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [props.dialog_key]);

  return <div className="library-dialog-backdrop" onPointerDown={(event) => {
    if (event.target === event.currentTarget && props.dismissible) props.on_cancel();
  }}>
    <section ref={dialogRef} className={`library-dialog ${props.class_name ?? ''}`}
      role="dialog" aria-modal="true" aria-labelledby={props.title_id}
      aria-describedby={props.description_id} tabIndex={-1}>
      {props.children}
    </section>
  </div>;
}
