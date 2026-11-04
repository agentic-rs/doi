import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowUpRight, BookOpen, FileText, FolderOpen, LoaderCircle, MoreHorizontal, Search, Settings2, Trash2, WifiOff } from 'lucide-react';
import type { Paper } from '../lib/types';
import './library-home.css';

interface LibraryHomeProps {
  papers: Paper[];
  is_native: boolean;
  loading: boolean;
  error: string | null;
  input: string;
  search: string;
  lookup_busy: boolean;
  lookup_message: string | null;
  lookup_error: string | null;
  on_input_change: (value: string) => void;
  on_search_change: (value: string) => void;
  on_lookup: () => void;
  on_cancel_lookup: () => void;
  on_open: (paper: Paper) => void;
  on_remove: (paper: Paper) => void;
  on_retry_library: () => void;
  on_settings: () => void;
  input_ref?: RefObject<HTMLInputElement | null>;
}

function recentTime(paper: Paper) {
  const opened = Date.parse(paper.last_opened_at ?? '');
  const downloaded = Date.parse(paper.downloaded_at);
  return Number.isFinite(opened) ? opened : Number.isFinite(downloaded) ? downloaded : 0;
}

function paperDate(paper: Paper) {
  const opened = Date.parse(paper.last_opened_at ?? '');
  const downloaded = Date.parse(paper.downloaded_at);
  const value = Number.isFinite(opened) ? opened : downloaded;
  if (!Number.isFinite(value)) return 'Saved on this device';
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(value);
  return `${Number.isFinite(opened) ? 'Opened' : 'Added'} ${date}`;
}

function LibraryPaperCard(props: Pick<LibraryHomeProps, 'on_open' | 'on_remove'> & { paper: Paper }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const button = menu.current?.querySelector<HTMLButtonElement>('button');
    button?.focus({ preventScroll: true });
    menu.current?.scrollIntoView?.({ block: 'nearest' });
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !menuButton.current?.contains(event.target)) setMenuOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
        setMenuOpen(false);
        menuButton.current?.focus({ preventScroll: true });
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        button?.focus();
      }
    }
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [menuOpen]);

  const paper = props.paper;
  return <article className="library-home-paper">
    <div className="library-home-paper-top"><span className="library-home-paper-id"><FileText size={14} aria-hidden="true" /> {paper.arxiv_id} <span>v{paper.arxiv_version}</span></span></div>
    <h3>{paper.title}</h3>
    <p className="library-home-authors">{paper.authors.length ? paper.authors.join(', ') : 'Authors not provided'}</p>
    <p className="library-home-paper-date">{paperDate(paper)}{paper.last_location && <span> · Page {paper.last_location.page_number}</span>}</p>
    <div className="library-home-paper-actions">
      <button type="button" className="library-home-open" aria-label={`Open ${paper.title}`} onClick={() => props.on_open(paper)}>Open <ArrowUpRight size={17} aria-hidden="true" /></button>
      <button type="button" className="library-home-more" ref={menuButton}
        aria-label={`More actions for ${paper.title}`} aria-haspopup="menu" aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined} onClick={() => setMenuOpen((value) => !value)}>
        <MoreHorizontal size={21} aria-hidden="true" />
      </button>
    </div>
    {menuOpen && <div ref={menu} id={menuId} role="menu" aria-label={`Actions for ${paper.title}`} className="library-home-paper-menu">
      <button type="button" role="menuitem" onClick={() => {
        setMenuOpen(false);
        menuButton.current?.focus({ preventScroll: true });
        props.on_remove(paper);
      }}><Trash2 size={17} aria-hidden="true" /> Remove</button>
    </div>}
  </article>;
}

export function LibraryHome(props: LibraryHomeProps) {
  const inputId = useId();
  const search = props.search.trim().toLocaleLowerCase();
  const papers = props.papers.filter((paper) => `${paper.title} ${paper.arxiv_id}v${paper.arxiv_version} ${paper.authors.join(' ')}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => recentTime(right) - recentTime(left));

  return <section className="library-home" aria-label="Paper library">
    <div className="library-home-inner">
      <header className="library-home-header">
        <div className="library-home-brand"><span><BookOpen size={26} strokeWidth={1.6} aria-hidden="true" /></span><div><h1>Paper Reader</h1><p>A place for curious minds</p></div></div>
        <button type="button" className="library-home-settings" aria-label="AI settings" onClick={props.on_settings}><Settings2 size={21} aria-hidden="true" /></button>
      </header>
      <section className="library-home-add" aria-labelledby={`${inputId}-heading`}>
        <div><h2 id={`${inputId}-heading`}>Add a paper</h2><p>Find an arXiv paper, read its abstract, and save it to your library.</p></div>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (props.is_native && !props.lookup_busy && props.input.trim()) props.on_lookup();
        }}>
          <label htmlFor={inputId}>arXiv ID or link</label>
          <div className="library-home-lookup">
            <input id={inputId} ref={props.input_ref} value={props.input} onChange={(event) => props.on_input_change(event.target.value)}
              placeholder="1706.03762 or arxiv.org/abs/…" autoComplete="off" autoCapitalize="none"
              autoCorrect="off" spellCheck={false} disabled={props.lookup_busy} />
            <button type="submit" disabled={!props.is_native || props.lookup_busy || !props.input.trim()}><Search size={18} aria-hidden="true" /> Find paper</button>
          </div>
        </form>
        {props.lookup_busy && <div className="library-home-lookup-status"><p role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />{props.lookup_message || 'Finding paper…'}</p><button type="button" onClick={props.on_cancel_lookup}>Cancel</button></div>}
        {!props.lookup_busy && props.lookup_message && <p className="library-home-lookup-note" role="status">{props.lookup_message}</p>}
        {props.lookup_error && <p className="library-home-error" role="alert">{props.lookup_error}</p>}
      </section>
      <section className="library-home-recent" aria-labelledby={`${inputId}-recent`}>
        <div className="library-home-list-heading"><div><h2 id={`${inputId}-recent`}>Recent papers</h2><p>{props.papers.length} {props.papers.length === 1 ? 'paper' : 'papers'} in your library</p></div>
          <label className="library-home-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label="Search your library" placeholder="Title, author, or arXiv ID" value={props.search} onChange={(event) => props.on_search_change(event.target.value)} /></label>
        </div>
        {props.loading && <p className="library-home-state" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" /> Opening your library…</p>}
        {props.error && <div className="library-home-error" role="alert"><p>{props.error}</p><button type="button" disabled={props.loading} onClick={props.on_retry_library}>Try again</button></div>}
        {props.papers.length > 0 && papers.length === 0 && <p className="library-home-state">No papers match “{props.search.trim()}”.</p>}
        {!props.loading && !props.error && props.papers.length === 0 && <div className="library-home-empty"><FolderOpen size={34} strokeWidth={1.4} aria-hidden="true" /><h3>Your next idea starts here.</h3><p>Add an arXiv paper to start your library.</p></div>}
        <div className="library-home-grid">{papers.map((paper) => <LibraryPaperCard key={paper.paper_id} paper={paper} on_open={props.on_open} on_remove={props.on_remove} />)}</div>
      </section>
      <footer className="library-home-footer"><span>{props.is_native ? 'Your library stays on this device' : 'App preview'}</span><span><WifiOff size={14} aria-hidden="true" /> Downloaded papers are available offline</span></footer>
    </div>
  </section>;
}
