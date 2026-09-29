import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Home, X } from 'lucide-react';
import './paper-tabs.css';

interface PaperTabsProps {
  tabs: Array<{ paper_id: string; title: string }>;
  active_paper_id: string | null;
  on_home: () => void;
  on_activate: (paper_id: string) => void;
  on_close: (paper_id: string) => void;
  disabled?: boolean;
}

export function PaperTabs(props: PaperTabsProps) {
  const navigation = useRef<HTMLElement>(null);
  const closingFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!closingFocus.current || closingFocus.current.isConnected) return;
    closingFocus.current = null;
    if (document.activeElement !== document.body) return;
    const buttons = Array.from(navigation.current?.querySelectorAll<HTMLButtonElement>('[data-paper-tab]') ?? []);
    const selected = buttons.find((button) => (button.dataset.paperId ?? null) === props.active_paper_id);
    selected?.focus({ preventScroll: true });
  }, [props.tabs, props.active_paper_id]);

  return <nav className="paper-tabs" aria-label="Open papers" ref={navigation}>
    <div className={`paper-tab-item paper-tab-home ${props.active_paper_id === null ? 'is-active' : ''}`}>
      <button type="button" data-paper-tab aria-label="Library home" disabled={props.disabled}
        aria-current={props.active_paper_id === null ? 'page' : undefined} onClick={props.on_home}
        onKeyDown={handleKeys}><Home size={18} aria-hidden="true" /><span>Library</span></button>
    </div>
    <div className="paper-tabs-scroll">
      {props.tabs.map((tab) => <div key={tab.paper_id}
        className={`paper-tab-item ${props.active_paper_id === tab.paper_id ? 'is-active' : ''}`}>
        <button type="button" data-paper-tab data-paper-id={tab.paper_id} title={tab.title}
          disabled={props.disabled} aria-current={props.active_paper_id === tab.paper_id ? 'page' : undefined}
          onClick={() => props.on_activate(tab.paper_id)} onKeyDown={handleKeys}>
          <span>{tab.title}</span>
        </button>
        <button type="button" className="paper-tab-close" aria-label={`Close ${tab.title}`}
          disabled={props.disabled} onClick={() => closePaper(tab.paper_id)}><X size={15} aria-hidden="true" /></button>
      </div>)}
    </div>
  </nav>;

  function closePaper(paper_id: string) {
    closingFocus.current = document.activeElement instanceof HTMLElement
      && navigation.current?.contains(document.activeElement) ? document.activeElement : null;
    props.on_close(paper_id);
  }

  function handleKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (props.disabled) return;
    if (event.key === 'Delete' && event.currentTarget.dataset.paperId) {
      event.preventDefault();
      closePaper(event.currentTarget.dataset.paperId);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(navigation.current?.querySelectorAll<HTMLButtonElement>('[data-paper-tab]:not(:disabled)') ?? []);
    const current = buttons.indexOf(event.currentTarget);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    const target = buttons[index];
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const paper_id = target.dataset.paperId;
    if (paper_id) props.on_activate(paper_id);
    else props.on_home();
  }
}
