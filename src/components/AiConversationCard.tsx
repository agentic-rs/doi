import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Save, Sparkles, Square } from 'lucide-react';
import type { AiConversationView } from '../lib/useAiConversations';
import './ai-conversation-card.css';

interface AiConversationCardProps {
  view: AiConversationView;
  on_follow_up: (question: string) => boolean | void;
  on_generate_note: () => void;
  on_stop: () => void;
  on_edit_note: (content: string) => void;
  on_retry_note_persistence: () => void;
  on_save_note: () => void;
  on_toggle_collapsed: () => void;
}

export function AiConversationCard({
  view, on_follow_up, on_generate_note, on_stop, on_edit_note,
  on_retry_note_persistence, on_save_note, on_toggle_collapsed,
}: AiConversationCardProps) {
  const [question, setQuestion] = useState('');
  const { conversation } = view;
  const note = conversation.note_draft;
  const completed = conversation.turns.filter((turn) => turn.phase === 'complete').length;
  const saved = Boolean(note?.saved_annotation_id);
  const blocked = view.pending || view.saving_note;
  const noteId = `conversation-note-${conversation.conversation_id}`;
  const bodyId = `conversation-body-${conversation.conversation_id}`;
  const questionId = `conversation-question-${conversation.conversation_id}`;
  const title = conversation.turns[0]?.question ?? 'Paper discussion';

  return <article className="ai-conversation" id={`ai-conversation-${conversation.conversation_id}`} aria-label={`AI conversation: ${title}`}>
    <button type="button" className="ai-conversation-heading" onClick={on_toggle_collapsed} aria-expanded={!view.collapsed} aria-controls={bodyId}>
      <span className="list-eyebrow">CONVERSATION <span>{conversation.turns.length}</span></span>
      {view.collapsed && <span className="ai-conversation-title">{title}</span>}
      {view.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      <span className="sr-only">{view.collapsed ? 'Expand conversation' : 'Collapse conversation'}</span>
    </button>
    {view.pending && <div className="ai-conversation-status" role="status">
      <LoaderCircle size={13} className="spin" /><span>{view.status}</span>
      <button type="button" className="text-button" onClick={on_stop}><Square size={12} /> Stop</button>
    </div>}
    <div id={bodyId} hidden={view.collapsed}>
      <details className="ai-conversation-source">
        <summary>Source passage · p. {conversation.target.page_anchors.map((anchor) => anchor.page_number).join(', ')} <ChevronRight size={12} /></summary>
        <p>{conversation.paper_title}</p><blockquote>{conversation.selected_text}</blockquote>
      </details>
      <div className="ai-conversation-turns">
        {conversation.turns.map((turn) => <section className="ai-conversation-turn" key={turn.turn_id} aria-label={`Question: ${turn.question}`}>
          <h3>{turn.question}</h3>
          {view.thinking_by_turn[turn.turn_id] && <details className="ai-thinking">
            <summary>Thinking <ChevronRight size={12} /></summary><div>{view.thinking_by_turn[turn.turn_id]}</div>
          </details>}
          {turn.answer && <div className="annotation-body ai-conversation-answer">{turn.answer}</div>}
          {view.unpersisted_turn_ids.includes(turn.turn_id) && turn.phase !== 'pending' && <p className="ai-conversation-incomplete">This question was not stored. Send it again to continue.</p>}
          {turn.phase === 'incomplete' && <p className="ai-conversation-incomplete">Response incomplete{turn.error ? `: ${turn.error}` : '. Ask a follow-up to continue.'}</p>}
          {turn.model_id && <div className="annotation-model">{turn.model_id}</div>}
        </section>)}
      </div>
      {view.note_thinking && <details className="ai-thinking">
        <summary>Thinking about the note <ChevronRight size={12} /></summary><div>{view.note_thinking}</div>
      </details>}
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <form className="ai-conversation-follow-up" onSubmit={(event) => {
        event.preventDefault();
        if (blocked || !question.trim()) return;
        if (on_follow_up(question) === false) return;
        event.currentTarget.querySelector('textarea')?.blur();
        setQuestion('');
      }}>
        <label className="sr-only" htmlFor={questionId}>Follow-up question</label>
        <textarea id={questionId} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a follow-up about this passage…" rows={2} disabled={blocked} />
        <button type="submit" className="button button-subtle" disabled={blocked || !question.trim()}><Sparkles size={14} /> Ask follow-up</button>
      </form>
      {completed > 0 && <button type="button" className="button button-subtle ai-generate-note" onClick={on_generate_note} disabled={blocked}>
        {view.pending && view.operation === 'note' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
        {view.pending && view.operation === 'note' ? 'Generating note…' : note ? 'Generate new note' : 'Generate note'}
      </button>}
      {note && <div className="ai-conversation-note">
        <label htmlFor={noteId}>{saved ? 'Saved note' : 'Suggested note'}</label>
        <p className="field-hint">{saved ? 'Saved beside the original passage.' : 'Review and edit the note, then save it beside the passage.'}</p>
        {note.source_turn_count < completed && <p className="ai-conversation-note-age">Based on {note.source_turn_count} of {completed} completed answers. Generate a new note to include the latest follow-up.</p>}
        <textarea id={noteId} value={view.note_content} onChange={(event) => on_edit_note(event.target.value)} readOnly={saved} disabled={blocked} rows={5} />
        {!saved && <div className="ai-conversation-persistence" aria-live="polite">
          {view.persistence_state === 'pending' || view.persistence_state === 'saving' ? 'Storing draft…' : view.persistence_state === 'saved' ? 'Draft stored on this device.' : null}
        </div>}
        {view.persistence_error && <div className="ai-conversation-persistence-error">
          <p className="inline-error" role="alert">{view.persistence_error}</p>
          <button type="button" className="text-button" onClick={on_retry_note_persistence} disabled={blocked}>Retry storing draft</button>
        </div>}
        <button type="button" className="button button-primary composer-submit" onClick={on_save_note} disabled={saved || blocked || !view.note_content.trim()}>
          {saved ? <Check size={15} /> : view.saving_note ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
          {saved ? 'Saved' : view.saving_note ? 'Saving…' : 'Save note'}
        </button>
      </div>}
    </div>
  </article>;
}
