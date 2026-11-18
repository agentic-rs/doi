import { useId } from 'react';
import { Bookmark, ChevronLeft } from 'lucide-react';
import { pageAnchorsKey } from '../lib/annotations';
import type { AiCitation, AiConversationTurn, AiTurnNote, AnnotationTarget } from '../lib/types';
import { CitationLinks, passageLabel } from './AiPassages';
import { ComposerForm } from './ComposerForm';

export interface TurnNoteActions {
  on_edit: (turn_id: string, note: AiTurnNote) => void;
  on_pin: (turn_id: string, content: string, target: AnnotationTarget) => Promise<unknown>;
  on_read: (citation: AiCitation, from: 'answer' | 'note draft', turn_id: string) => void;
}

function placementOptions(home: AnnotationTarget, turn: AiConversationTurn) {
  const { paper_id, pdf_hash } = home;
  const options: { label: string; target: AnnotationTarget }[] = [];
  const add = (target: AnnotationTarget, label: string) => {
    if (!options.some(o => pageAnchorsKey(o.target.page_anchors) === pageAnchorsKey(target.page_anchors))) options.push({ target, label });
  };
  for (const attachment of turn.attachments ?? []) {
    add({ paper_id, pdf_hash, page_anchors: attachment.page_anchors }, `Attached passage · ${passageLabel(attachment.page_anchors)} · ${attachment.selected_text.slice(0, 48)}`);
  }
  if (home.page_anchors.length) add(home, `Original passage · ${passageLabel(home.page_anchors)}`);
  const paper: AnnotationTarget = { paper_id, pdf_hash, scope: 'paper', page_anchors: [] };
  add(paper, 'Whole paper');
  for (const c of turn.citations ?? []) {
    add({ paper_id, pdf_hash, page_anchors: [c.anchor] }, `Source ${c.citation_id} · p. ${c.anchor.page_number} · ${c.anchor.text_quote.exact_text.slice(0, 48)}`);
  }
  if (turn.note) add(turn.note.target, `Saved placement · ${passageLabel(turn.note.target.page_anchors)}`);
  return options;
}

export function AiTurnNoteEditor({ home, turn, busy, actions, on_back }: {
  home: AnnotationTarget; turn: AiConversationTurn; busy: boolean; actions: TurnNoteActions; on_back: () => void;
}) {
  const id = useId();
  const placements = placementOptions(home, turn);
  const note = turn.note ?? { content: turn.answer, target: placements[0].target, saved_annotation_id: null };
  const selected = placements.findIndex(({ target }) => pageAnchorsKey(target.page_anchors) === pageAnchorsKey(note.target.page_anchors));
  const save = async () => {
    if (!busy && note.content.trim() && await actions.on_pin(turn.turn_id, note.content, note.target)) on_back();
  };
  return <ComposerForm className="ai-pin-editor" on_action={save}>
    <button type="button" className="text-button" onClick={on_back}><ChevronLeft size={15} /> Back to answer</button>
    <label htmlFor={id}>Your note</label>
    <textarea id={id} value={note.content} rows={5} disabled={busy} onChange={e => actions.on_edit(turn.turn_id, { ...note, content: e.target.value })} />
    <label htmlFor={id + '-target'}>Pin to</label>
    <select id={id + '-target'} value={selected} disabled={busy} onChange={e => actions.on_edit(turn.turn_id, { ...note, target: placements[Number(e.target.value)].target })}>
      {placements.map((p,i) => <option value={i} key={i}>{p.label}</option>)}
    </select>
    <CitationLinks citations={turn.citations} on_read={c => actions.on_read(c, 'note draft', turn.turn_id)} />
    <div className="phone-action-bar"><button type="button" onClick={save} className="button button-primary" disabled={busy || !note.content.trim()}><Bookmark size={16} /> Pin note</button></div>
  </ComposerForm>;
}
