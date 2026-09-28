import { Check, ChevronRight, LoaderCircle, Save, Square, X } from 'lucide-react';
import type { AiDraft } from '../lib/useAiDrafts';

interface AiAnswerDraftProps {
  draft: AiDraft;
  on_stop: () => void;
  on_edit: (content: string) => void;
  on_save: () => void;
  on_dismiss: () => void;
}

export function AiAnswerDraft({ draft, on_stop, on_edit, on_save, on_dismiss }: AiAnswerDraftProps) {
  const pending = draft.phase === 'pending';
  const saved = draft.save_state === 'saved';
  const saving = draft.save_state === 'saving';
  const noteId = `ai-note-${draft.request_id}`;

  return <article id={`ai-response-${draft.request_id}`} className="ai-draft" aria-label={`AI response: ${draft.question}`}>
    <div className="ai-draft-heading">
      <span className="list-eyebrow">{saved ? 'SAVED' : 'AI RESPONSE'}</span>
      {!pending && <button type="button" className="icon-button" onClick={on_dismiss} disabled={saving} aria-label={saved ? 'Close saved response' : 'Discard unsaved response'} title={saved ? 'Close saved response' : 'Discard unsaved response'}><X size={14} /></button>}
    </div>
    <details className="ai-draft-source">
      <summary>Source passage · p. {draft.selection.page_anchors.map((anchor) => anchor.page_number).join(', ')} <ChevronRight size={12} /></summary>
      <p>{draft.paper.title}</p>
      <blockquote>{draft.selection.selected_text}</blockquote>
    </details>
    <h3 className="annotation-question">{draft.question}</h3>
    <div className={`ai-draft-status ${draft.phase === 'incomplete' ? 'is-incomplete' : ''}`} role="status">
      {pending && <LoaderCircle size={13} className="spin" />}
      <span>{draft.status}</span>
      {pending && <button type="button" className="text-button" onClick={on_stop}><Square size={12} /> Stop</button>}
    </div>
    {draft.thinking && <details className="ai-thinking">
      <summary>Thinking <ChevronRight size={12} /></summary>
      <div>{draft.thinking}</div>
    </details>}
    {draft.answer && <div className="annotation-body ai-draft-answer">{draft.answer}</div>}
    {draft.error && <p className="inline-error" role="alert">{draft.error}</p>}
    {draft.phase === 'incomplete' && <p className="field-hint">This response was not completed or saved. Ask again to get a complete answer.</p>}
    {draft.phase === 'complete' && <div className="ai-note-preview">
      <label htmlFor={noteId}>{draft.result?.note_proposal ? 'Suggested note' : 'Note to save'}</label>
      <p className="field-hint">{draft.result?.note_proposal ? 'Review the model’s takeaway before saving.' : 'No suggested note was returned. Edit the answer below to choose what to keep.'}</p>
      {draft.result?.proposal_warning && <p className="ai-proposal-warning">{draft.result.proposal_warning}</p>}
      <textarea id={noteId} value={draft.note_content} onChange={(event) => on_edit(event.target.value)} readOnly={saved} disabled={saving} rows={5} />
      {draft.save_error && <p className="inline-error" role="alert">{draft.save_error}</p>}
      <button type="button" className="button button-primary composer-submit" onClick={on_save} disabled={saved || saving || !draft.note_content.trim()}>
        {saved ? <Check size={15} /> : saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
        {saved ? 'Saved' : saving ? 'Saving…' : draft.save_error ? 'Retry save' : 'Save note'}
      </button>
      {!saved && <p className="ai-draft-retention">Unsaved responses stay here while Papertrail is open.</p>}
    </div>}
  </article>;
}
