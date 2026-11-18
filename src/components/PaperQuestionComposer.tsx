import { ArrowUpRight, Plus, Sparkles, StickyNote, X } from 'lucide-react';
import type { RefObject } from 'react';
import { ComposerForm } from './ComposerForm';
import type { AiPassage, AiSettings, SelectionContext } from '../lib/types';
import { PassagePicker, passageLabel } from './AiPassages';

export function PaperQuestionComposer(props: {
  selection: SelectionContext | null; phone: boolean; composing_ai: boolean; question: string; note: string;
  settings: AiSettings; input_ref: RefObject<HTMLTextAreaElement | null>; busy: boolean;
  on_clear: () => void; on_ai: () => void; on_manual: () => void; on_settings: () => void;
  on_question: (text: string) => void; on_note: (text: string) => void; on_submit: () => void;
  attachments: AiPassage[]; on_attach: (passages: AiPassage[]) => void; on_pick: () => void;
}) {
  const p = props, selection = p.selection;
  const submit = () => {
    if (p.busy || (p.composing_ai && (!p.settings.model_id || !p.settings.base_url))) return;
    p.on_submit();
  };
  return <ComposerForm className="selection-composer paper-question-composer" on_action={submit}>
    {selection ? <>
      <div className="selection-heading"><span>Selected passage · {passageLabel(selection.page_anchors)}</span>
        <button type="button" className="icon-button" aria-label="Dismiss selected passage" onClick={p.on_clear}><X size={14} /></button></div>
      <blockquote>{selection.selected_text}</blockquote>
    </> : <h2>Ask this paper</h2>}
    {selection && !p.phone && <div className="composer-tabs">
      <button type="button" className={p.composing_ai ? 'is-active' : ''} onClick={p.on_ai}><Sparkles size={14} /> Ask AI</button>
      <button type="button" className={!p.composing_ai ? 'is-active' : ''} onClick={p.on_manual}><StickyNote size={14} /> Add a note</button>
    </div>}
    {p.composing_ai ? <>
      <PassagePicker options={[]} attached={p.attachments} on_change={p.on_attach} on_pick={p.on_pick} />
      <label htmlFor="selection-question" className="sr-only">{selection ? 'Question about this selection' : 'Question about this paper'}</label>
      <textarea id="selection-question" ref={p.input_ref} rows={3} value={p.question} placeholder="Ask about this paper…" onChange={e => p.on_question(e.target.value)} />
      {!p.settings.model_id || !p.settings.base_url ?
        <div className="setup-assistant"><span>Choose a model in Apell to ask a question.</span><button type="button" className="text-button" onClick={p.on_settings}>Set up AI <ArrowUpRight size={12} /></button></div> :
        <>
          <details className="context-preview"><summary>Context sent to {p.settings.model_id}</summary>
            <p>The model receives paper metadata, attached text, and passages it finds by searching and reading this PDF.</p>
            {selection?.context_text && <pre>{selection.context_text}</pre>}
          </details>
          <div className="phone-action-bar"><button type="button" onClick={submit} className="button button-primary composer-submit" disabled={!p.question.trim() || p.busy}><Sparkles size={15} /> Ask</button></div>
        </>}
    </> : selection ? <>
      <label className="sr-only" htmlFor="selection-note">Note for this selection</label>
      <textarea id="selection-note" rows={4} value={p.note} disabled={p.busy} placeholder="Keep a thought beside this passage…" onChange={e => p.on_note(e.target.value)} />
      <button type="button" onClick={submit} className="button button-primary composer-submit" disabled={p.busy || !p.note.trim()}><Plus size={15} />{p.busy ? 'Saving…' : 'Save note'}</button>
    </> : <button type="button" className="button button-primary" onClick={p.on_ai}><Sparkles size={15} /> Ask about paper</button>}
  </ComposerForm>;
}
