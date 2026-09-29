import { useId } from 'react';
import { BookOpen, X } from 'lucide-react';
import { LibraryDialog } from './LibraryDialog';
import { ReferenceCard } from './ReferenceCard';
import type { ReferenceCardProps } from './ReferenceCard';
import './reference-components.css';

export interface ReferenceDetailsDialogProps extends ReferenceCardProps {
  on_close: () => void;
}

export function ReferenceDetailsDialog(props: ReferenceDetailsDialogProps) {
  const title_id = useId();
  return <LibraryDialog dialog_key={props.reference.reference_id} title_id={title_id}
    class_name="reference-details-dialog" dismissible on_cancel={props.on_close}>
    <header className="reference-details-heading">
      <h2 id={title_id}><BookOpen size={18} aria-hidden="true" />Reference details</h2>
      <button type="button" aria-label="Close reference details" data-dialog-cancel onClick={props.on_close}>
        <X size={20} aria-hidden="true" />
      </button>
    </header>
    <div className="library-dialog-scroll reference-details-content">
      <ReferenceCard reference={props.reference} resolution={props.resolution} busy={props.busy}
        on_open={props.on_open} on_find={props.on_find} on_source={props.on_source} />
    </div>
  </LibraryDialog>;
}
