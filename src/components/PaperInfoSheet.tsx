import { useEffect, useId, useRef } from 'react';
import { ArrowRight, BookOpen, ExternalLink, X } from 'lucide-react';
import type { Paper } from '../lib/types';
import { DialogBackdrop } from './DialogBackdrop';
import './paper-info.css';

interface PaperInfoSheetProps {
  paper: Paper;
  on_close: () => void;
  on_open_source: () => void;
  resume?: boolean;
}

function formatCachedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function PaperInfoSheet({ paper, on_close, on_open_source, resume = false }: PaperInfoSheetProps) {
  const titleId = useId();
  const abstractId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(on_close);

  useEffect(() => { closeRef.current = on_close; }, [on_close]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const focusInside = controls.some((control) => control === document.activeElement);
      if (event.shiftKey && (!focusInside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!focusInside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <DialogBackdrop class_name="paper-info-backdrop" dismissible on_dismiss={on_close}>
      <section className="paper-info-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <header className="paper-info-heading">
          <span className="paper-info-eyebrow"><BookOpen size={18} aria-hidden="true" /> About this paper</span>
          <button type="button" className="paper-info-close" aria-label="Close paper information" onClick={on_close}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="paper-info-content">
          <h1 id={titleId}>{paper.title}</h1>
          <dl className="paper-info-metadata">
            <div className="paper-info-authors">
              <dt>Authors</dt>
              <dd>{paper.authors.length ? paper.authors.join(', ') : 'Not provided'}</dd>
            </div>
            <div>
              <dt>arXiv ID</dt>
              <dd>{paper.arxiv_id}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>v{paper.arxiv_version}</dd>
            </div>
            <div className="paper-info-cache-date">
              <dt>Cached on</dt>
              <dd><time dateTime={paper.downloaded_at}>{formatCachedDate(paper.downloaded_at)}</time></dd>
            </div>
          </dl>
          <section className="paper-info-abstract" aria-labelledby={abstractId}>
            <h2 id={abstractId}>Abstract</h2>
            <p>{paper.abstract.trim() || 'An abstract was not provided for this paper.'}</p>
          </section>
        </div>
        <footer className="paper-info-actions">
          <button type="button" className="paper-info-source" onClick={on_open_source}><ExternalLink size={17} aria-hidden="true" /> View on arXiv</button>
          <button type="button" className="paper-info-read" onClick={on_close}>{resume ? 'Resume reading' : 'Read paper'}<ArrowRight size={18} aria-hidden="true" /></button>
        </footer>
      </section>
    </DialogBackdrop>
  );
}
