import { useId } from 'react';
import { BookOpen, Download, LoaderCircle } from 'lucide-react';
import type { PaperPreview } from '../lib/types';
import { LibraryDialog } from './LibraryDialog';
import './paper-preview-dialog.css';

interface PaperPreviewDialogProps {
  preview: PaperPreview;
  busy: boolean;
  message: string | null;
  error: string | null;
  on_confirm: () => void;
  on_cancel: () => void;
}

export function PaperPreviewDialog(props: PaperPreviewDialogProps) {
  const titleId = useId();
  const abstractId = useId();
  const paper = props.preview.metadata;

  return <LibraryDialog dialog_key={props.preview.preview_id} title_id={titleId}
    class_name="paper-preview-dialog" dismissible on_cancel={props.on_cancel}>
    <div className="library-dialog-scroll paper-preview-content">
      <p className="paper-preview-eyebrow"><BookOpen size={18} aria-hidden="true" /> arXiv preview</p>
      <h1 id={titleId}>{paper.title}</h1>
      <dl className="paper-preview-metadata">
        <div className="paper-preview-authors"><dt>Authors</dt><dd>{paper.authors.length ? paper.authors.join(', ') : 'Not provided'}</dd></div>
        <div><dt>arXiv ID</dt><dd>{paper.arxiv_id}</dd></div>
        <div><dt>Version</dt><dd>v{paper.arxiv_version}</dd></div>
      </dl>
      <section className="paper-preview-abstract" aria-labelledby={abstractId}>
        <h2 id={abstractId}>Abstract</h2>
        <p>{paper.abstract.trim() || 'An abstract was not provided for this paper.'}</p>
      </section>
      {props.preview.library_paper && <p className="paper-preview-cached">This version is already in your library.</p>}
      {(props.busy || props.message) && <p className="library-dialog-message" role="status">
        {props.busy && <LoaderCircle size={18} className="spin" aria-hidden="true" />}
        {props.message || 'Downloading paper…'}
      </p>}
      {props.error && <p className="library-dialog-error" role="alert">{props.error}</p>}
    </div>
    <footer className="library-dialog-actions">
      <button type="button" className="library-dialog-cancel" data-dialog-cancel onClick={props.on_cancel}>Cancel</button>
      <button type="button" className="library-dialog-confirm" disabled={props.busy} onClick={props.on_confirm}>
        <Download size={18} aria-hidden="true" /> Download &amp; add to library
      </button>
    </footer>
  </LibraryDialog>;
}
