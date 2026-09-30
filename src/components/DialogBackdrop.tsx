import { useRef } from 'react';
import type { ReactNode } from 'react';

interface DialogBackdropProps {
  class_name: string;
  dismissible: boolean;
  on_dismiss: () => void;
  children: ReactNode;
}

export function DialogBackdrop({ class_name, dismissible, on_dismiss, children }: DialogBackdropProps) {
  const pressed_on_backdrop = useRef(false);

  return <div className={class_name}
    onPointerDownCapture={(event) => {
      pressed_on_backdrop.current = event.target === event.currentTarget;
      if (pressed_on_backdrop.current) event.stopPropagation();
    }}
    onPointerCancelCapture={() => { pressed_on_backdrop.current = false; }}
    onClick={(event) => {
      const started_on_backdrop = pressed_on_backdrop.current;
      pressed_on_backdrop.current = false;
      if (event.target !== event.currentTarget) return;
      // Keep the backdrop mounted through release so this click cannot land on
      // a link underneath. Consume it before dismissal exposes the reader.
      event.preventDefault();
      event.stopPropagation();
      if (started_on_backdrop && dismissible) on_dismiss();
    }}>
    {children}
  </div>;
}
