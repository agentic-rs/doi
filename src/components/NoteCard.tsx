import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, LoaderCircle, Sparkles, StickyNote, Trash2 } from 'lucide-react';
import type { Annotation } from '../lib/types';
import './note-card.css';

export interface NoteCardProps {
  annotation: Annotation;
  on_navigate: (annotation: Annotation) => void;
  on_update?: (annotation: Annotation, content: string) => Promise<boolean>;
  on_delete?: (annotation: Annotation) => Promise<boolean>;
  busy?: boolean;
  pending?: boolean;
  frozen?: boolean;
  on_before_resize?: () => void;
  edit_draft?: string | null;
  on_edit_draft_change?: (draft: string | null) => void;
}

export function NoteCard({ annotation, on_navigate, on_update, on_delete, busy = false, pending = false, frozen = false, on_before_resize, edit_draft, on_edit_draft_change }: NoteCardProps) {
  const [local_expanded, setExpanded] = useState(false);
  const [local_draft, setDraft] = useState<string | null>(null);
  const [full_answer, setFullAnswer] = useState(false);
  const [operation, setOperation] = useState<'save' | 'delete' | null>(null);
  const mounted = useRef(true);
  const content_id = useId();
  const editor_id = useId();
  const answer_id = useId();
  const draft = edit_draft === undefined ? local_draft : edit_draft;
  const editing = draft !== null;
  const expanded = local_expanded || editing;
  const body = annotation.body;
  const content = body.kind === 'note' ? body.content : body.note_content ?? body.answer;
  const summary = content.trim().split(/\r?\n/, 1)[0] || 'Empty note';
  const quote = annotation.target.page_anchors.map((anchor) => anchor.text_quote.exact_text).filter(Boolean).join('\n');
  const pages = [...new Set(annotation.target.page_anchors.map((anchor) => anchor.page_number))].join(', ');
  const mutation_blocked = busy || pending || operation !== null;
  const blocked = mutation_blocked || frozen;
  const date = new Date(annotation.created_at);
  const date_label = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const resize = (change: () => void) => {
    on_before_resize?.();
    change();
  };
  const edit = (value: string | null) => {
    if (edit_draft === undefined) setDraft(value);
    else on_edit_draft_change?.(value);
  };
  const finishEditing = () => resize(() => {
    setExpanded(true);
    edit(null);
  });
  const save = async () => {
    if (!on_update || blocked || !draft?.trim()) return;
    setOperation('save');
    try {
      if (await on_update(annotation, draft) && mounted.current) finishEditing();
    } finally {
      if (mounted.current) setOperation(null);
    }
  };
  const remove = async () => {
    if (!on_delete || blocked) return;
    setOperation('delete');
    try {
      await on_delete(annotation);
    } finally {
      if (mounted.current) setOperation(null);
    }
  };

  return <article className="note-card" data-annotation_id={annotation.annotation_id} aria-label={`Saved note: ${summary}`} aria-busy={pending || operation !== null}>
    <button type="button" className="note-card-heading" aria-expanded={expanded} aria-controls={content_id}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} note: ${summary}`} disabled={editing || pending} aria-disabled={editing || pending || frozen}
      onClick={() => { if (!frozen) resize(() => setExpanded(!expanded)); }}>
      {body.kind === 'ai_answer' ? <Sparkles size={16} aria-hidden="true" /> : <StickyNote size={16} aria-hidden="true" />}
      <span className="note-card-preview">{summary}</span>
      {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
    </button>
    {expanded && <div className="note-card-content" id={content_id}>
      <div className="note-card-meta"><span>{body.kind === 'ai_answer' ? 'AI note' : 'Your note'}</span>{pages && <span>p. {pages}</span>}</div>
      {quote && <blockquote className="note-card-quote">{quote}</blockquote>}
      {body.kind === 'ai_answer' && body.question && <h3 className="note-card-question">{body.question}</h3>}
      {editing ? <form className="note-card-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label htmlFor={editor_id}>Edit note</label>
        <textarea id={editor_id} value={draft} rows={6} disabled={mutation_blocked} readOnly={frozen} onChange={(event) => { if (!frozen) edit(event.target.value); }} />
        <div className="note-card-actions">
          <button type="button" disabled={mutation_blocked} aria-disabled={blocked} onClick={() => { if (!blocked) finishEditing(); }}>Cancel</button>
          <button type="submit" className="note-card-save" disabled={mutation_blocked || !draft.trim()} aria-disabled={blocked || !draft.trim()}>
            {operation === 'save' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{operation === 'save' ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </form> : <div className="note-card-body">{content}</div>}
      {body.kind === 'ai_answer' && body.note_content !== undefined && body.note_content !== body.answer && <div className="note-card-answer">
        <button type="button" aria-expanded={full_answer} aria-controls={answer_id} disabled={pending} aria-disabled={pending || frozen}
          onClick={() => { if (!frozen) resize(() => setFullAnswer(!full_answer)); }}>
          Full answer {full_answer ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        {full_answer && <div className="note-card-body" id={answer_id}>{body.answer}</div>}
      </div>}
      {body.kind === 'ai_answer' && body.model_id && <div className="note-card-model">{body.model_id}</div>}
      {(date_label || annotation.updated_at !== annotation.created_at) && <div className="note-card-date">{date_label}{annotation.updated_at !== annotation.created_at ? `${date_label ? ' · ' : ''}Edited` : ''}</div>}
      <div className="note-card-actions">
        <button type="button" onClick={() => on_navigate(annotation)}><ArrowUpRight size={16} aria-hidden="true" />Go to passage</button>
        {on_update && !editing && <button type="button" disabled={mutation_blocked} aria-disabled={blocked} onClick={() => { if (!blocked) resize(() => edit(content)); }}>Edit</button>}
        {on_delete && <button type="button" className="note-card-delete" disabled={mutation_blocked} aria-disabled={blocked} aria-label="Delete annotation" title="Delete note" onClick={() => { void remove(); }}>
          {pending || operation === 'delete' ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}Delete
        </button>}
      </div>
    </div>}
  </article>;
}
