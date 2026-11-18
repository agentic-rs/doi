import { useState } from 'react';
import { Bookmark, Check, ChevronDown, ChevronRight, LoaderCircle, Save, Sparkles, Square } from 'lucide-react';
import type { AiConversationView } from '../lib/useAiConversations';
import type { AiPassage } from '../lib/types';
import { AiTurnNoteEditor, type TurnNoteActions } from './AiTurnNoteEditor';
import { CitedText, CitationLinks, PassagePicker, passageLabel } from './AiPassages';
import { ComposerForm } from './ComposerForm';
import './ai-conversation-card.css';

interface AiConversationCardProps {
  view: AiConversationView;
  follow_up_question: string;
  on_follow_up_question_change: (value: string) => void;
  on_follow_up: (question: string) => boolean | void;
  on_generate_note: () => void;
  on_stop: () => void;
  on_edit_note: (content: string) => void;
  on_retry_note_persistence: () => void;
  on_save_note: () => void;
  on_toggle_collapsed: () => void;
  turn_actions?: TurnNoteActions;
  focused?: boolean;
  selected_turn_id?: string;
  on_select_turn?: (turn_id?: string) => void;
  passage_options?: AiPassage[];
  attachments?: AiPassage[];
  on_attach?: (passages: AiPassage[]) => void;
  on_pick?: () => void;
}

export function AiConversationCard({
  view, follow_up_question: question, on_follow_up_question_change, on_follow_up, on_generate_note, on_stop, on_edit_note,
  on_retry_note_persistence, on_save_note, on_toggle_collapsed, turn_actions, focused, selected_turn_id, on_select_turn,
  passage_options = [], attachments = [], on_attach, on_pick,
}: AiConversationCardProps) {
  const { conversation } = view;
  const note = conversation.note_draft;
  const completed = conversation.turns.filter((turn) => turn.phase === 'complete').length;
  const saved = Boolean(note?.saved_annotation_id);
  const blocked = view.pending || view.saving_note;
  const noteId = `conversation-note-${conversation.conversation_id}`;
  const bodyId = `conversation-body-${conversation.conversation_id}`;
  const questionId = `conversation-question-${conversation.conversation_id}`;
  const title = conversation.turns[0]?.question ?? 'Paper discussion';
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const editing = conversation.turns.find(t => t.turn_id === editingTurnId);
  const selected = conversation.turns.find(t => t.turn_id === selected_turn_id) ?? conversation.turns.at(-1);
  const turns = focused && selected ? [selected] : conversation.turns;
  const submitFollowUp = () => {
    if (blocked || !question.trim() || on_follow_up(question) === false) return;
    on_select_turn?.();
    document.getElementById(questionId)?.blur();
    on_follow_up_question_change('');
  };

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
      {editing && turn_actions ? <AiTurnNoteEditor home={conversation.target} turn={editing} busy={blocked} actions={turn_actions} on_back={() => setEditingTurnId(null)} /> : <>
      {conversation.selected_text && <details className="ai-conversation-source">
        <summary>Source passage · p. {conversation.target.page_anchors.map((anchor) => anchor.page_number).join(', ')} <ChevronRight size={12} /></summary>
        <p>{conversation.paper_title}</p><blockquote>{conversation.selected_text}</blockquote>
      </details>}
      {focused && conversation.turns.length > 1 && <label className="ai-turn-picker">Question in this conversation
        <select value={selected?.turn_id} onChange={e => on_select_turn?.(e.target.value)}>
          {conversation.turns.map((t,i) => <option key={t.turn_id} value={t.turn_id}>{i + 1} · {t.question}</option>)}
        </select>
      </label>}
      <div className="ai-conversation-turns">
        {turns.map((turn) => <section className="ai-conversation-turn" key={turn.turn_id} aria-label={`Question: ${turn.question}`}>
          <h3>{turn.question}</h3>
          {(turn.attachments ?? []).map((p,i) => <details className="ai-conversation-source" key={i}><summary>Attached passage · {passageLabel(p.page_anchors)}</summary><blockquote>{p.selected_text}</blockquote></details>)}
          {view.thinking_by_turn[turn.turn_id] && <details className="ai-thinking">
            <summary>Thinking <ChevronRight size={12} /></summary><div>{view.thinking_by_turn[turn.turn_id]}</div>
          </details>}
          {turn.answer && <div className="annotation-body ai-conversation-answer">{turn_actions ?
            <CitedText text={turn.answer} citations={turn.citations} on_read={c => turn_actions.on_read(c, 'answer', turn.turn_id)} /> : turn.answer}</div>}
          {turn_actions && <CitationLinks citations={turn.citations} on_read={c => turn_actions.on_read(c, 'answer', turn.turn_id)} />}
          {view.unpersisted_turn_ids.includes(turn.turn_id) && turn.phase !== 'pending' && <p className="ai-conversation-incomplete">This question was not stored. Send it again to continue.</p>}
          {turn.phase === 'incomplete' && <p className="ai-conversation-incomplete">Response incomplete{turn.error ? `: ${turn.error}` : '. Ask a follow-up to continue.'}</p>}
          {turn.model_id && <div className="annotation-model">{turn.model_id}</div>}
          {turn_actions && turn.phase === 'complete' && !view.unpersisted_turn_ids.includes(turn.turn_id) && <button type="button" className="button button-subtle ai-pin-action"
            onClick={() => setEditingTurnId(turn.turn_id)} disabled={blocked}><Bookmark size={15} /> {turn.note?.saved_annotation_id ? 'Edit pinned note' : 'Save as note'}</button>}
        </section>)}
      </div>
      {view.note_thinking && <details className="ai-thinking">
        <summary>Thinking about the note <ChevronRight size={12} /></summary><div>{view.note_thinking}</div>
      </details>}
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <ComposerForm className="ai-conversation-follow-up" on_action={submitFollowUp}>
        <label className="sr-only" htmlFor={questionId}>Follow-up question</label>
        <textarea id={questionId} value={question} onChange={(event) => on_follow_up_question_change(event.target.value)} placeholder="Ask a follow-up…" rows={2} disabled={blocked} />
        {on_attach && <PassagePicker options={passage_options} attached={attachments} on_change={on_attach} on_pick={on_pick} />}
        <button type="button" onClick={submitFollowUp} className="button button-subtle" disabled={blocked || !question.trim()}><Sparkles size={14} /> Ask follow-up</button>
      </ComposerForm>
      {completed > 0 && (note || !turn_actions) && <button type="button" className="button button-subtle ai-generate-note" onClick={on_generate_note} disabled={blocked}>
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
      </>}
      {editing && view.error && <p className="inline-error" role="alert">{view.error}</p>}
    </div>
  </article>;
}
