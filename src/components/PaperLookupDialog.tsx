import { useId } from 'react';
import { LoaderCircle } from 'lucide-react';
import { LibraryDialog } from './LibraryDialog';
import './paper-lookup-dialog.css';

interface PaperLookupDialogProps {
  label: string;
  message: string;
  error?: string | null;
  on_cancel: () => void;
}

export function PaperLookupDialog(props: PaperLookupDialogProps) {
  const titleId = useId();

  return <LibraryDialog dialog_key="paper-lookup" title_id={titleId}
    class_name="paper-lookup-dialog" dismissible on_cancel={props.on_cancel}>
    <div className="library-dialog-scroll paper-lookup-content">
      <h2 id={titleId}>{props.label}</h2>
      <p className="library-dialog-message" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" />{props.message}</p>
      {props.error && <p className="library-dialog-error" role="alert">{props.error}</p>}
    </div>
    <footer className="library-dialog-actions"><button type="button" className="library-dialog-cancel" data-dialog-cancel onClick={props.on_cancel}>Cancel</button></footer>
  </LibraryDialog>;
}
