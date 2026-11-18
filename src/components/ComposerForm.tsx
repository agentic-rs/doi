import type { ReactNode } from 'react';

/** Apell disables native form submission. Buttons invoke the same action directly. */
export function ComposerForm({ className, children, on_action }: { className: string; children: ReactNode; on_action: () => void }) {
  return <form className={className} onSubmit={e => { e.preventDefault(); on_action(); }} onKeyDown={e => {
    if (e.target instanceof HTMLTextAreaElement && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!e.repeat) on_action();
    }
  }}>{children}</form>;
}
