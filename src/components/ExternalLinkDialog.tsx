import { useId } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import { LibraryDialog } from './LibraryDialog';
import './external-link-dialog.css';

interface ExternalLinkDialogProps {
  url: string;
  busy: boolean;
  error: string | null;
  on_confirm: () => void;
  on_cancel: () => void;
}

export function ExternalLinkDialog(props: ExternalLinkDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const destination = new URL(props.url);

  return <LibraryDialog dialog_key={props.url} title_id={titleId}
    description_id={descriptionId} class_name="external-link-dialog" initial_focus="cancel"
    dismissible={!props.busy} on_cancel={props.on_cancel}>
    <div className="library-dialog-scroll external-link-content">
      <span className="external-link-symbol"><ArrowUpRight size={22} aria-hidden="true" /></span>
      <h2 id={titleId}>External link</h2>
      <p id={descriptionId}>Copy this address to open it in your browser. Apell does not open external links yet.</p>
      <dl className="external-link-destination">
        <div><dt>Domain</dt><dd dir="ltr">{destination.hostname}</dd></div>
        <div><dt>Full URL</dt><dd className="external-link-url" dir="ltr"><input aria-label="Link address" readOnly value={props.url} onFocus={(event) => event.currentTarget.select()} /></dd></div>
      </dl>
      {props.busy && <p className="library-dialog-message" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" /> Opening browser…</p>}
      {props.error && <p className="library-dialog-error" role="alert">{props.error}</p>}
    </div>
    <footer className="library-dialog-actions">
      <button type="button" className="library-dialog-cancel" data-dialog-cancel disabled={props.busy} onClick={props.on_cancel}>Cancel</button>
    </footer>
  </LibraryDialog>;
}
