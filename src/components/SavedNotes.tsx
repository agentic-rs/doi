import { useRef } from 'react';
import { ArrowDownToLine, FileText, LoaderCircle, Upload } from 'lucide-react';
import type { AiCitation, Annotation } from '../lib/types';
import { NoteCard } from './NoteCard';

interface SavedNotesProps {
  annotations: Annotation[];
  busy_annotation_id: string | null;
  edit: { annotation_id: string; content: string } | null;
  importing: boolean;
  exporting: boolean;
  on_edit: (annotation: Annotation, content: string | null) => void;
  on_update: (annotation: Annotation, content: string) => Promise<boolean>;
  on_delete: (annotation: Annotation) => Promise<boolean>;
  on_navigate: (annotation: Annotation) => void;
  on_read_citation?: (annotation: Annotation, citation: AiCitation) => void;
  on_open_origin?: (annotation: Annotation) => void;
  reopened_id?: string | null;
  on_import: (file: File) => void;
  on_export: () => void;
}

export function SavedNotes(props: SavedNotesProps) {
  const import_input = useRef<HTMLInputElement>(null);
  return <section className="saved-notes" aria-label="Saved notes">
    <div className="notes-list-heading">
      <span className="list-eyebrow">SAVED NOTES <span>{props.annotations.length}</span></span>
      <div className="sidecar-controls">
        <button type="button" className="icon-button" onClick={props.on_export} aria-label="Export annotations as JSON" title="Export annotation sidecar JSON" disabled={props.exporting}>
          {props.exporting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
        </button>
        <button type="button" className="icon-button" onClick={() => import_input.current?.click()} aria-label="Import annotation JSON" title="Import annotation sidecar JSON" disabled={props.importing}>
          {props.importing ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
        </button>
        <input ref={import_input} type="file" accept=".json,application/json" className="sr-only" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) props.on_import(file);
        }} />
      </div>
    </div>
    {props.annotations.length ? <div className="annotation-list">{props.annotations.map((annotation) => <NoteCard
      key={annotation.annotation_id} annotation={annotation}
      initially_expanded={props.reopened_id === annotation.annotation_id}
      busy={Boolean(props.busy_annotation_id)} pending={props.busy_annotation_id === annotation.annotation_id}
      edit_draft={props.edit?.annotation_id === annotation.annotation_id ? props.edit.content : null}
      on_edit_draft_change={(content) => props.on_edit(annotation, content)}
      on_update={props.on_update} on_delete={props.on_delete} on_navigate={props.on_navigate}
      on_read_citation={props.on_read_citation} on_open_origin={props.on_open_origin}
    />)}</div> : <p className="no-notes">Select a passage to save your first note. Saved notes will appear here.</p>}
    <p className="annotation-format-hint"><FileText size={12} /> Your notes use a portable JSON sidecar.</p>
  </section>;
}
