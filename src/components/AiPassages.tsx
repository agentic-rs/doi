import { BookOpen, Paperclip, X } from 'lucide-react';
import { pageAnchorsKey } from '../lib/annotations';
import type { AiCitation, AiPassage, PageAnchor } from '../lib/types';

export function passageLabel(anchors: PageAnchor[]) {
  const pages = [...new Set(anchors.map(a => a.page_number))];
  return pages.length ? `p. ${pages.join(', ')}` : 'Whole paper';
}

export function CitationLinks({ citations = [], on_read }: {
  citations?: AiCitation[];
  on_read: (citation: AiCitation) => void;
}) {
  if (!citations.length) return null;
  return <div className="ai-citations" aria-label="Cited passages">
    {citations.map(c => <button type="button" className="button button-subtle" key={c.citation_id}
      aria-label={`Read source ${c.citation_id} on page ${c.anchor.page_number}`} onClick={() => on_read(c)}>
      <BookOpen size={15} /> {c.citation_id} · p. {c.anchor.page_number}
    </button>)}
  </div>;
}

export function CitedText({ text, citations, on_read }: { text: string; citations?: AiCitation[]; on_read: (citation: AiCitation) => void }) {
  if (!citations?.length) return <>{text}</>;
  return <>{text.split(/(\[S[1-9]\d*\])/g).map((part,i) => {
    const cited = citations.find(c => part === `[${c.citation_id}]`);
    return cited ? <button key={i} type="button" className="ai-inline-citation" aria-label={`Read ${cited.citation_id}, page ${cited.anchor.page_number}`}
      onClick={() => on_read(cited)}>{part}</button> : part;
  })}</>;
}

export function PassagePicker({ options, attached, on_change, on_pick }: {
  options: AiPassage[];
  attached: AiPassage[];
  on_change: (next: AiPassage[]) => void;
  on_pick?: () => void;
}) {
  if (!options.length && !attached.length && !on_pick) return null;
  const key = (p: AiPassage) => pageAnchorsKey(p.page_anchors);
  const selected = new Set(attached.map(key));
  const available = [...new Map(options.map(p => [key(p), p])).values()].filter(p => !selected.has(key(p)));
  return <div className="ai-passage-picker">
    {attached.map(p => <button type="button" className="button button-subtle" key={key(p)}
      aria-label={`Remove attachment: ${p.selected_text}`} onClick={() => on_change(attached.filter(item => key(item) !== key(p)))}>
      <Paperclip size={14} /> {passageLabel(p.page_anchors)} <X size={13} />
    </button>)}
    {!available.length && on_pick && <button type="button" className="text-button" onClick={on_pick}><Paperclip size={14} /> Add passage</button>}
    {available.length > 0 && <details><summary><Paperclip size={14} /> Add passage</summary>
      {on_pick && <button type="button" onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); on_pick(); }}>Select in paper</button>}
      {available.map(p => <button key={key(p)} type="button" onClick={event => {
        event.currentTarget.closest('details')?.removeAttribute('open');
        on_change([...attached, p]);
      }}><strong>{passageLabel(p.page_anchors)}</strong> {p.selected_text}</button>)}
    </details>}
  </div>;
}
