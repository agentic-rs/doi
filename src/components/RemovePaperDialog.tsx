import { useId } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { Paper } from '../lib/types';
import { LibraryDialog } from './LibraryDialog';
import './remove-paper-dialog.css';

interface RemovePaperDialogProps {
  paper: Paper;
  busy: boolean;
  error: string | null;
  on_confirm: () => void;
  on_cancel: () => void;
}

export function RemovePaperDialog(props: RemovePaperDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  return <LibraryDialog dialog_key={props.paper.paper_id} title_id={titleId}
    description_id={descriptionId} class_name="remove-paper-dialog" initial_focus="cancel"
    dismissible={!props.busy} on_cancel={props.on_cancel}>
    <div className="library-dialog-scroll remove-paper-content">
      <span className="remove-paper-symbol"><Trash2 size={22} aria-hidden="true" /></span>
      <h2 id={titleId}>Remove paper?</h2>
      <p className="remove-paper-title">{props.paper.title}</p>
      <p id={descriptionId}>This removes the downloaded PDF, notes, and AI conversations for this paper from this device.</p>
      {props.busy && <p className="library-dialog-message" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" /> Removing paper…</p>}
      {props.error && <p className="library-dialog-error" role="alert">{props.error}</p>}
    </div>
    <footer className="library-dialog-actions">
      <button type="button" className="library-dialog-cancel" data-dialog-cancel disabled={props.busy} onClick={props.on_cancel}>Cancel</button>
      <button type="button" className="remove-paper-confirm" disabled={props.busy} onClick={props.on_confirm}>Remove paper</button>
    </footer>
  </LibraryDialog>;
}
