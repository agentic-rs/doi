import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check,
  ChevronRight, CircleHelp, FileText, FolderOpen, Link2, LoaderCircle,
  Library, MessageSquare, PanelRightClose, PanelRightOpen, Plus, Search, Settings2,
  Sparkles, StickyNote, Trash2, Upload, WifiOff, X,
} from 'lucide-react';
import { PdfReader } from '../components/PdfReader';
import { SettingsDialog } from '../components/SettingsDialog';
import {
  askSelection, deleteAnnotation, nativeAvailable, getPdfBytes, getSettings,
  listAnnotations, listPapers, onProgress, openArxivPaper, openExternal,
  resolveReference, saveAnnotation, saveAnnotationFile, saveReadingPosition,
} from '../lib/tauri';
import {
  canGoBack, canGoForward, createHistory, currentLocation, goBack, goForward,
  pushLocation, updateCurrent,
} from '../lib/history';
import type { NavigationHistory } from '../lib/history';
import { parseAnnotationSidecar, serializeAnnotations } from '../lib/annotations';
import type {
  AiSettings, Annotation, OperationProgress, PageAnchor, Paper, ReaderTarget, ReadingLocation,
  ReferenceCandidate, ReferenceItem, SelectionContext,
} from '../lib/types';

interface ActiveDocument {
  paper: Paper;
  pdf_data: Uint8Array;
}

interface OpenOperation {
  request_id: string;
  label: string;
}

interface Notice {
  message: string;
  tone: 'error' | 'success' | 'info';
}

interface ReferenceResolution {
  busy: boolean;
  candidates: ReferenceCandidate[];
  error: string | null;
}

const defaultSettings: AiSettings = {
  base_url: 'https://api.openai.com/v1',
  model_id: '',
  has_api_key: false,
};

const compactLayoutQuery = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';

function initialLocation(paper: Paper): ReadingLocation {
  return paper.last_location ?? {
    paper_id: paper.paper_id,
    page_number: 1,
    page_position: [0, 0],
    zoom: 1,
    rotation: 0,
  };
}

function arxivFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/(^|\.)arxiv\.org$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function authorLine(paper: Paper): string {
  if (paper.authors.length <= 2) return paper.authors.join(' · ');
  return `${paper.authors.slice(0, 2).join(' · ')} +${paper.authors.length - 2}`;
}

function selectionKey(selection: SelectionContext): string {
  return `${JSON.stringify(selection.page_anchors)}:${selection.selected_text}`;
}

function annotationQuote(annotation: Annotation): string {
  return annotation.target.page_anchors.map((anchor) => anchor.text_quote.exact_text).join(' ');
}

function sortAnnotations(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function WorkspacePage() {
  const [isNative] = useState(nativeAvailable);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia?.(compactLayoutQuery).matches ?? false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [references, setReferences] = useState<ReferenceItem[]>([]);
  const [history, setHistoryState] = useState(() => createHistory(null));
  const [targetLocation, setTargetLocation] = useState<ReadingLocation | null>(null);
  const [targetAnchor, setTargetAnchor] = useState<PageAnchor | null>(null);
  const [navigationKey, setNavigationKey] = useState(0);
  const [arxivInput, setArxivInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [libraryLoading, setLibraryLoading] = useState(isNative);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [opening, setOpening] = useState<OpenOperation | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => !(window.matchMedia?.(compactLayoutQuery).matches ?? false));
  const [inspectorTab, setInspectorTab] = useState<'references' | 'notes'>('references');
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [composerKind, setComposerKind] = useState<'ai' | 'note'>('ai');
  const [question, setQuestion] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [aiPending, setAiPending] = useState<string | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [settings, setSettings] = useState<AiSettings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, ReferenceResolution>>({});
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const mountedRef = useRef(true);
  const papersRef = useRef(papers);
  const activeRef = useRef(active);
  const historyRef = useRef(history);
  const selectionRef = useRef(selection);
  const openingRef = useRef(opening);
  const openSequenceRef = useRef(0);
  const currentPositionRef = useRef<ReadingLocation | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const arxivInputRef = useRef<HTMLInputElement>(null);
  const askInputRef = useRef<HTMLTextAreaElement>(null);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const libraryRef = useRef<HTMLElement>(null);

  const focusArxivInput = useCallback(() => {
    // Remove the drawer's inert state before focusing during this user gesture,
    // so iOS can open its keyboard for the arXiv field.
    if (libraryOpen) flushSync(() => setLibraryOpen(false));
    arxivInputRef.current?.focus();
  }, [libraryOpen]);

  useEffect(() => {
    const media = window.matchMedia?.(compactLayoutQuery);
    if (!media) return;
    function updateLayout(event: MediaQueryListEvent) {
      setCompactLayout(event.matches);
      setLibraryOpen(false);
      setInspectorOpen(!event.matches);
    }
    media.addEventListener('change', updateLayout);
    return () => media.removeEventListener('change', updateLayout);
  }, []);

  useEffect(() => {
    if (!compactLayout || !libraryOpen) return;
    libraryRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setLibraryOpen(false);
      if (event.key !== 'Tab') return;
      const controls = libraryRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      libraryButtonRef.current?.focus();
    };
  }, [compactLayout, libraryOpen]);

  const commitHistory = useCallback((next: NavigationHistory) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);

  const storePapers = useCallback((next: Paper[]) => {
    papersRef.current = next;
    setPapers(next);
  }, []);

  const flushPosition = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const location = currentPositionRef.current;
    if (!isNative || !location) return;
    void saveReadingPosition(location).catch((cause) => {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not save your reading position: ${String(cause)}` });
    });
  }, [isNative]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isNative) return () => { mountedRef.current = false; };
    let cancelled = false;
    void Promise.allSettled([listPapers(), getSettings()]).then(([paperResult, settingsResult]) => {
      if (cancelled) return;
      if (paperResult.status === 'fulfilled') {
        const loadedIds = new Set(paperResult.value.map((paper) => paper.paper_id));
        storePapers([...paperResult.value, ...papersRef.current.filter((paper) => !loadedIds.has(paper.paper_id))]);
      } else {
        setLibraryError(String(paperResult.reason));
      }
      if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value);
      else setNotice({ tone: 'error', message: `Could not load AI settings: ${String(settingsResult.reason)}` });
      setLibraryLoading(false);
    });
    const unlisten = onProgress((event) => {
      if (event.request_id === openingRef.current?.request_id) setProgress(event);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      flushPosition();
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [flushPosition, isNative, storePapers]);

  const handleLocationChange = useCallback((location: ReadingLocation) => {
    if (activeRef.current?.paper.paper_id !== location.paper_id) return;
    currentPositionRef.current = location;
    commitHistory(updateCurrent(historyRef.current, location));
    papersRef.current = papersRef.current.map((paper) => paper.paper_id === location.paper_id ? { ...paper, last_location: location } : paper);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPosition, 600);
  }, [commitHistory, flushPosition]);

  const handleSelection = useCallback((next: SelectionContext | null) => {
    // A sidebar focus change collapses native selection; retain the captured PDF anchor.
    if (!next || !next.selected_text.trim() || !next.page_anchors.length) return;
    if (selectionRef.current && selectionKey(next) === selectionKey(selectionRef.current)) return;
    selectionRef.current = next;
    setSelection(next);
    setQuestion('');
    setNoteDraft('');
    if (!compactLayout) setInspectorOpen(true);
    setInspectorTab('notes');
  }, [compactLayout]);

  function clearSelection() {
    selectionRef.current = null;
    setSelection(null);
    setQuestion('');
    setNoteDraft('');
  }

  function applyDocument(document: ActiveDocument, notes: Annotation[], nextHistory: NavigationHistory, location: ReadingLocation) {
    setLibraryOpen(false);
    if (compactLayout) setInspectorOpen(false);
    activeRef.current = document;
    setActive(document);
    setAnnotations(sortAnnotations(notes));
    setReferences([]);
    setResolutions({});
    setEditId(null);
    clearSelection();
    currentPositionRef.current = location;
    commitHistory(nextHistory);
    setTargetLocation(location);
    setTargetAnchor(null);
    setNavigationKey((value) => value + 1);
  }

  async function openPaper(input: string, cachedPaper?: Paper) {
    if (!isNative) {
      setNotice({ tone: 'info', message: 'Open the Papertrail app to download papers and use your local library.' });
      return;
    }
    const sequence = ++openSequenceRef.current;
    const operation = { request_id: crypto.randomUUID(), label: cachedPaper?.title ?? input };
    openingRef.current = operation;
    setOpening(operation);
    setProgress(null);
    setNotice(null);
    flushPosition();
    try {
      const paper = cachedPaper ?? await openArxivPaper(input.trim(), operation.request_id);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      const [pdfData, notes] = await Promise.all([getPdfBytes(paper.paper_id), listAnnotations(paper.paper_id)]);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      const location = initialLocation(paper);
      const nextHistory = pushLocation(historyRef.current, location);
      applyDocument({ paper, pdf_data: pdfData }, notes, nextHistory, location);
      storePapers([paper, ...papersRef.current.filter((existing) => existing.paper_id !== paper.paper_id)]);
      setArxivInput('');
      setLibraryError(null);
    } catch (cause) {
      if (sequence === openSequenceRef.current && mountedRef.current) setNotice({ tone: 'error', message: String(cause) });
    } finally {
      if (sequence === openSequenceRef.current && mountedRef.current) {
        openingRef.current = null;
        setOpening(null);
        setProgress(null);
      }
    }
  }

  async function navigateHistory(direction: 'back' | 'forward') {
    const moved = direction === 'back' ? goBack(historyRef.current) : goForward(historyRef.current);
    const location = currentLocation(moved);
    if (!location || moved.current_index === historyRef.current.current_index) return;
    flushPosition();
    if (activeRef.current?.paper.paper_id === location.paper_id) {
      if (compactLayout) setInspectorOpen(false);
      commitHistory(moved);
      currentPositionRef.current = location;
      setTargetLocation(location);
      setTargetAnchor(null);
      setNavigationKey((value) => value + 1);
      clearSelection();
      return;
    }
    const paper = papersRef.current.find((item) => item.paper_id === location.paper_id);
    if (!paper) {
      setNotice({ tone: 'error', message: 'This paper is no longer in your local library.' });
      return;
    }
    const sequence = ++openSequenceRef.current;
    const operation = { request_id: crypto.randomUUID(), label: paper.title };
    openingRef.current = operation;
    setOpening(operation);
    setProgress(null);
    setNotice(null);
    try {
      const [pdfData, notes] = await Promise.all([getPdfBytes(paper.paper_id), listAnnotations(paper.paper_id)]);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      applyDocument({ paper, pdf_data: pdfData }, notes, { ...historyRef.current, current_index: moved.current_index }, location);
    } catch (cause) {
      if (sequence === openSequenceRef.current && mountedRef.current) setNotice({ tone: 'error', message: String(cause) });
    } finally {
      if (sequence === openSequenceRef.current && mountedRef.current) {
        openingRef.current = null;
        setOpening(null);
        setProgress(null);
      }
    }
  }

  function jumpTo(location: ReadingLocation, anchor: PageAnchor | null = null) {
    if (activeRef.current?.paper.paper_id !== location.paper_id) return;
    if (compactLayout) setInspectorOpen(false);
    flushPosition();
    commitHistory(pushLocation(historyRef.current, location));
    currentPositionRef.current = location;
    setTargetLocation(location);
    setTargetAnchor(anchor);
    setNavigationKey((value) => value + 1);
  }

  async function followUrl(url: string) {
    const arxivId = arxivFromUrl(url);
    if (arxivId) {
      const cached = papersRef.current.find((paper) => paper.arxiv_id === arxivId || `${paper.arxiv_id}v${paper.arxiv_version}` === arxivId);
      await openPaper(arxivId, cached);
      return;
    }
    try {
      await openExternal(url);
    } catch (cause) {
      setNotice({ tone: 'error', message: String(cause) });
    }
  }

  function handleNavigate(target: ReaderTarget) {
    if (target.kind === 'internal') jumpTo(target.location);
    else void followUrl(target.url);
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusArxivInput();
      }
    }
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [focusArxivInput]);

  const showSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  async function submitSelection(event: FormEvent) {
    event.preventDefault();
    const paper = activeRef.current?.paper;
    const capturedSelection = selectionRef.current;
    if (!paper || !capturedSelection || aiPending || annotationBusy) return;
    const capturedKey = selectionKey(capturedSelection);
    const now = new Date().toISOString();
    const annotation: Annotation = {
      schema_version: 1,
      annotation_id: crypto.randomUUID(),
      target: {
        paper_id: paper.paper_id,
        pdf_hash: paper.pdf_hash,
        page_anchors: capturedSelection.page_anchors,
      },
      body: { kind: 'note', content: noteDraft.trim() },
      created_at: now,
      updated_at: now,
    };
    const capturedQuestion = question.trim();
    const kind = composerKind;
    if (kind === 'note' && !noteDraft.trim()) return;
    if (kind === 'ai' && !capturedQuestion) return;
    setNotice(null);
    if (kind === 'ai') setAiPending(annotation.annotation_id);
    else setAnnotationBusy(annotation.annotation_id);
    try {
      if (kind === 'ai') {
        const answer = await askSelection({
          request_id: annotation.annotation_id,
          paper_id: paper.paper_id,
          selected_text: capturedSelection.selected_text,
          context_text: capturedSelection.context_text,
          question: capturedQuestion,
        });
        annotation.body = {
          kind: 'ai_answer',
          question: capturedQuestion,
          answer: answer.answer,
          provider_id: answer.provider_id,
          model_id: answer.model_id,
          context_text: answer.context_text,
        };
      }
      const saved = await saveAnnotation(annotation);
      if (!mountedRef.current) return;
      if (activeRef.current?.paper.paper_id === paper.paper_id) {
        setAnnotations((existing) => sortAnnotations([saved, ...existing.filter((item) => item.annotation_id !== saved.annotation_id)]));
        if (selectionRef.current && selectionKey(selectionRef.current) === capturedKey) {
          if (kind === 'ai') setQuestion('');
          else setNoteDraft('');
        }
      }
      setNotice({ tone: 'success', message: activeRef.current?.paper.paper_id === paper.paper_id ? `${kind === 'ai' ? 'Answer' : 'Note'} saved to this passage.` : `${kind === 'ai' ? 'Answer' : 'Note'} saved to “${paper.title}”.` });
    } catch (cause) {
      if (mountedRef.current) setNotice({ tone: 'error', message: `${kind === 'ai' ? 'Could not get and save an answer' : 'Could not save your note'}: ${String(cause)}` });
    } finally {
      if (mountedRef.current) {
        if (kind === 'ai') setAiPending(null);
        else setAnnotationBusy(null);
      }
    }
  }

  async function removeAnnotation(annotation: Annotation) {
    setAnnotationBusy(annotation.annotation_id);
    try {
      await deleteAnnotation(annotation.annotation_id);
      if (activeRef.current?.paper.paper_id === annotation.target.paper_id) setAnnotations((existing) => existing.filter((item) => item.annotation_id !== annotation.annotation_id));
      if (editId === annotation.annotation_id) setEditId(null);
    } catch (cause) {
      setNotice({ tone: 'error', message: `Could not delete this annotation: ${String(cause)}` });
    } finally {
      setAnnotationBusy(null);
    }
  }

  async function updateAnnotation(annotation: Annotation) {
    if (!editDraft.trim()) return;
    setAnnotationBusy(annotation.annotation_id);
    try {
      const updated = await saveAnnotation({
        ...annotation,
        body: annotation.body.kind === 'note' ? { ...annotation.body, content: editDraft.trim() } : { ...annotation.body, answer: editDraft.trim() },
        updated_at: new Date().toISOString(),
      });
      if (activeRef.current?.paper.paper_id === annotation.target.paper_id) {
        setAnnotations((existing) => existing.map((item) => item.annotation_id === updated.annotation_id ? updated : item));
        setEditId(null);
      }
    } catch (cause) {
      setNotice({ tone: 'error', message: `Could not update this annotation: ${String(cause)}` });
    } finally {
      setAnnotationBusy(null);
    }
  }

  function jumpToAnnotation(annotation: Annotation) {
    const location = currentLocation(historyRef.current);
    const anchor = annotation.target.page_anchors[0];
    if (!location || !anchor) return;
    jumpTo({ ...location, page_number: anchor.page_number, page_position: [0, 0] }, anchor);
  }

  async function exportAnnotations() {
    if (!active || exporting) return;
    setExporting(true);
    try {
      const fileName = `${active.paper.arxiv_id.replace('/', '-')}-v${active.paper.arxiv_version}.papertrail.json`;
      const path = await saveAnnotationFile(fileName, serializeAnnotations(active.paper, annotations));
      if (path) setNotice({ tone: 'success', message: `Annotations exported to ${path}. The original PDF is unchanged.` });
    } catch (cause) {
      setNotice({ tone: 'error', message: `Could not export annotations: ${String(cause)}` });
    } finally {
      setExporting(false);
    }
  }

  async function importAnnotations(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const paper = activeRef.current?.paper;
    if (!file || !paper) return;
    setImporting(true);
    let importedCount = 0;
    try {
      const records = parseAnnotationSidecar(await file.text(), paper);
      for (const annotation of records) {
        const saved = await saveAnnotation(annotation);
        importedCount += 1;
        if (activeRef.current?.paper.paper_id === paper.paper_id) setAnnotations((existing) => sortAnnotations([saved, ...existing.filter((item) => item.annotation_id !== saved.annotation_id)]));
      }
      setNotice({ tone: 'success', message: `Imported ${importedCount} annotation${importedCount === 1 ? '' : 's'}.` });
    } catch (cause) {
      setNotice({ tone: 'error', message: `${importedCount ? `${importedCount} annotations imported before the error. ` : ''}${String(cause)}` });
    } finally {
      setImporting(false);
    }
  }

  async function findReference(reference: ReferenceItem) {
    const paperId = activeRef.current?.paper.paper_id;
    setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: true, candidates: [], error: null } }));
    try {
      const candidates = await resolveReference(reference.citation_text);
      if (activeRef.current?.paper.paper_id !== paperId) return;
      setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: false, candidates, error: null } }));
    } catch (cause) {
      if (activeRef.current?.paper.paper_id !== paperId) return;
      setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: false, candidates: [], error: String(cause) } }));
    }
  }

  function openReference(reference: ReferenceItem | ReferenceCandidate) {
    if (reference.arxiv_id) {
      const cached = papersRef.current.find((paper) => paper.arxiv_id === reference.arxiv_id || `${paper.arxiv_id}v${paper.arxiv_version}` === reference.arxiv_id);
      void openPaper(reference.arxiv_id, cached);
    } else if (reference.doi) {
      void followUrl(`https://doi.org/${reference.doi}`);
    } else if (reference.url) {
      void followUrl(reference.url);
    }
  }

  async function retryLibrary() {
    setLibraryLoading(true);
    setLibraryError(null);
    try { storePapers(await listPapers()); }
    catch (cause) { setLibraryError(String(cause)); }
    finally { setLibraryLoading(false); }
  }

  function submitImport(event: FormEvent) {
    event.preventDefault();
    if (arxivInput.trim()) void openPaper(arxivInput);
  }

  const visiblePapers = papers.filter((paper) => `${paper.title} ${paper.arxiv_id} ${paper.authors.join(' ')}`.toLowerCase().includes(searchInput.toLowerCase()));
  const selectedPages = selection?.page_anchors.map((anchor) => anchor.page_number).join(', ');
  const progressPercent = progress?.total_bytes ? Math.round(progress.received_bytes / progress.total_bytes * 100) : null;
  const current = currentLocation(history);
  const pendingAnnotation = Boolean(annotationBusy || aiPending);

  return (
    <div className={`app-shell ${libraryOpen ? 'library-is-open' : ''}`}>
      <aside ref={libraryRef} id="paper-library" className="library-sidebar" aria-label="Paper library" role={compactLayout && libraryOpen ? 'dialog' : undefined} aria-modal={compactLayout && libraryOpen ? true : undefined}>
        <button type="button" className="icon-button mobile-library-close" aria-label="Close paper library" onClick={() => setLibraryOpen(false)}><X size={20} /></button>
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); focusArxivInput(); }} aria-label="Papertrail, open a paper">
          <span className="brand-mark"><BookOpen size={21} strokeWidth={1.6} /></span>
          <span>Papertrail<span className="brand-caption">A place for curious minds</span></span>
        </a>
        <button type="button" className="button add-paper-button" onClick={focusArxivInput}><Plus size={16} /> Add a paper <kbd>⌘ K</kbd></button>
        <div className="library-section-heading"><span>Your library</span><span className="count-pill">{papers.length}</span></div>
        <label className="library-search"><Search size={15} /><input type="search" placeholder="Find in your library" aria-label="Search your library" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /></label>
        <div className="library-list">
          {libraryLoading ? <div className="sidebar-message"><LoaderCircle size={17} className="spin" /> Opening your library…</div> : libraryError ? <div className="library-error"><p>{libraryError}</p><button type="button" className="text-button" onClick={() => { void retryLibrary(); }}>Try again</button></div> : papers.length === 0 ? <div className="library-empty"><FolderOpen size={27} strokeWidth={1.4} /><p>A little room for<br />your next big idea.</p><span>Papers you open will live here.</span></div> : visiblePapers.length === 0 ? <p className="sidebar-message">No papers match “{searchInput}”.</p> : visiblePapers.map((paper) => (
            <button type="button" key={paper.paper_id} className={`library-paper ${active?.paper.paper_id === paper.paper_id ? 'is-active' : ''}`} onClick={() => { void openPaper(paper.arxiv_id, { ...paper, last_location: currentPositionRef.current?.paper_id === paper.paper_id ? currentPositionRef.current : paper.last_location }); }} aria-current={active?.paper.paper_id === paper.paper_id ? 'page' : undefined}>
              <span className="paper-library-title">{paper.title}</span>
              <span className="paper-library-authors">{authorLine(paper)}</span>
              <span className="paper-library-meta"><FileText size={11} /> {paper.arxiv_id} <span>v{paper.arxiv_version}</span></span>
            </button>
          ))}
        </div>
        <div className="library-footer"><span className="local-dot" />{isNative ? 'Your library stays on this device' : 'App preview'}<span className="footer-detail"><WifiOff size={12} /> Cached papers are available offline</span></div>
      </aside>

      <main className="workbench" inert={compactLayout && libraryOpen}>
        <header className="workspace-toolbar">
          <button ref={libraryButtonRef} type="button" className="icon-button mobile-library-toggle" aria-label="Open paper library" aria-controls="paper-library" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(true)}><Library size={20} /></button>
          <div className="history-controls">
            <button type="button" className="icon-button" aria-label="Go back to previous reading location" title="Back" disabled={!canGoBack(history) || Boolean(opening)} onClick={() => { void navigateHistory('back'); }}><ArrowLeft size={18} /></button>
            <button type="button" className="icon-button" aria-label="Go forward to next reading location" title="Forward" disabled={!canGoForward(history) || Boolean(opening)} onClick={() => { void navigateHistory('forward'); }}><ArrowRight size={18} /></button>
          </div>
          <div className="toolbar-divider" />
          <form className="arxiv-form" onSubmit={submitImport}>
            <span className="arxiv-label">arXiv</span>
            <input ref={arxivInputRef} value={arxivInput} onChange={(event) => setArxivInput(event.target.value)} aria-label="arXiv ID or URL" placeholder="Paper ID or arxiv.org link" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button type="submit" className="import-button" disabled={!arxivInput.trim() || Boolean(opening)} aria-label="Open arXiv paper">{opening ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}<span>Open</span></button>
          </form>
          <div className="toolbar-actions">
            <button type="button" className={`icon-button ${inspectorOpen ? 'is-selected' : ''}`} onClick={() => setInspectorOpen((value) => !value)} aria-controls="paper-inspector" aria-expanded={inspectorOpen} aria-label={inspectorOpen ? 'Close references and notes panel' : 'Open references and notes panel'} title={inspectorOpen ? 'Close side panel' : 'Open side panel'}>{inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
            <button type="button" className="icon-button" aria-label="AI provider settings" title="AI provider settings" onClick={showSettings} disabled={!isNative}><Settings2 size={18} /></button>
          </div>
        </header>

        {!isNative && <div className="runtime-banner"><span className="status-dot" /><span>This is the web preview. Paper downloads, local storage, and AI need the Papertrail app.</span></div>}
        {opening && <div className="operation-banner" role="status"><LoaderCircle size={15} className="spin" /><span>{progress?.message ?? `Opening ${opening.label}…`}</span>{progressPercent !== null && <span className="download-percent">{progressPercent}%</span>}<div className="operation-meter" style={{ width: `${progressPercent ?? 35}%` }} /></div>}
        {notice && <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <Check size={15} /> : notice.tone === 'error' ? <CircleHelp size={15} /> : <CircleHelp size={15} />}<span>{notice.message}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={14} /></button></div>}

        {compactLayout && selection && !inspectorOpen && <button type="button" className="mobile-selection-action" onClick={() => { setInspectorTab('notes'); setInspectorOpen(true); }}><Sparkles size={17} /><span>Ask AI or add a note to this passage</span><ChevronRight size={18} /></button>}

        <div className={`reading-grid ${inspectorOpen ? 'with-inspector' : ''}`}>
          <section className={`reading-surface ${active ? 'has-paper' : ''}`} aria-label="Paper reader">
            {active ? <>
              <div className="paper-heading">
                <div className="paper-eyebrow"><span className="local-dot" /> In your library <span>arXiv:{active.paper.arxiv_id}v{active.paper.arxiv_version}</span></div>
                <h1 title={active.paper.title}>{active.paper.title}</h1>
                <div className="paper-author-line" title={active.paper.authors.join(', ')}>{authorLine(active.paper)}</div>
              </div>
              <div className="pdf-reader-mount"><PdfReader paper={active.paper} pdf_data={active.pdf_data} annotations={annotations} target_location={targetLocation} target_anchor={targetAnchor} navigation_key={navigationKey} on_location_change={handleLocationChange} on_navigate={handleNavigate} on_selection={handleSelection} on_references={(items) => { if (activeRef.current?.paper.paper_id === active.paper.paper_id) setReferences(items); }} on_error={(message) => setNotice({ tone: 'error', message })} /></div>
            </> : <div className="reader-welcome">
              <div className="welcome-eyebrow"><span /> FOLLOW A THOUGHT</div>
              <h1>One paper.<br />A world of ideas.</h1>
              <p>Read a paper, follow its references,<br className="wide-break" /> and make the important passages your own.</p>
              <div className="welcome-paper-art" aria-hidden="true">
                <div className="art-paper art-paper-back"><span /><span /><span /></div>
                <div className="art-paper art-paper-front"><div className="art-paper-category">PAPER / 001</div><div className="art-paper-title">Ideas begin<br />with a question.</div><div className="art-rule" /><div className="art-text"><span /><span /><span /><span /></div><div className="art-highlight" /><div className="art-text second"><span /><span /><span /></div><div className="art-note"><Sparkles size={14} /><span>A thought worth keeping</span></div><span className="art-page-number">01</span></div>
                <span className="art-reference-line" /><span className="art-reference-dot" />
              </div>
              <div className="welcome-steps"><span><BookOpen size={15} /> Read closely</span><span><Link2 size={15} /> Follow connections</span><span><Sparkles size={15} /> Ask better questions</span></div>
              <button type="button" className="example-button" onClick={() => { void openPaper('1706.03762'); }} disabled={Boolean(opening)}>Try a first paper <span>Attention Is All You Need</span><ArrowUpRight size={15} /></button>
              <span className="welcome-input-hint">Paste an arXiv ID above to begin.</span>
            </div>}
          </section>

          {inspectorOpen && <aside id="paper-inspector" className="inspector" aria-label="References and annotations">
            <div className="inspector-tabs" role="tablist" aria-label="Paper details">
              <button type="button" role="tab" id="references-tab" aria-controls="references-panel" aria-selected={inspectorTab === 'references'} className={inspectorTab === 'references' ? 'is-active' : ''} onClick={() => setInspectorTab('references')}><Link2 size={15} /> References {references.length > 0 && <span>{references.length}</span>}</button>
              <button type="button" role="tab" id="notes-tab" aria-controls="notes-panel" aria-selected={inspectorTab === 'notes'} className={inspectorTab === 'notes' ? 'is-active' : ''} onClick={() => setInspectorTab('notes')}><StickyNote size={15} /> Notes {annotations.length > 0 && <span>{annotations.length}</span>}</button>
            </div>
            {inspectorTab === 'references' ? <div id="references-panel" role="tabpanel" aria-labelledby="references-tab" className="inspector-content">
              <div className="inspector-intro"><h2>Follow the thread.</h2><p>Every paper is part of a bigger conversation.</p></div>
              {references.length ? <><div className="list-eyebrow">CITATIONS & LINKS <span>{references.length}</span></div><div className="reference-list">{references.map((reference, index) => {
                const resolution = resolutions[reference.reference_id];
                const canOpen = Boolean(reference.arxiv_id || reference.doi || reference.url);
                return <article className="reference-card" key={reference.reference_id}>
                  <div className="reference-number">{String(index + 1).padStart(2, '0')} <span>p. {reference.page_number}</span></div>
                  <p className="reference-citation">{reference.citation_text}</p>
                  <div className="reference-actions">{canOpen ? <button type="button" className="text-button" onClick={() => openReference(reference)} disabled={Boolean(opening)}>{reference.arxiv_id ? 'Read paper' : reference.doi ? 'Open DOI' : 'Open link'}<ArrowUpRight size={13} /></button> : <button type="button" className="text-button" onClick={() => { void findReference(reference); }} disabled={resolution?.busy}>{resolution?.busy ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />} {resolution?.busy ? 'Finding matches…' : 'Find a match'}</button>}<button type="button" className="reference-page" onClick={() => { if (current) jumpTo({ ...current, page_number: reference.page_number, page_position: [0, 0] }); }} aria-label={`Go to reference on page ${reference.page_number}`} title="Show in paper"><ChevronRight size={15} /></button></div>
                  {resolution && !resolution.busy && <div className="reference-results">{resolution.error ? <p className="inline-error">{resolution.error}</p> : resolution.candidates.length ? <><span className="candidate-label">Choose a possible match</span>{resolution.candidates.map((candidate, candidateIndex) => <button type="button" className="reference-candidate" key={`${candidate.url}-${candidateIndex}`} onClick={() => openReference(candidate)} disabled={Boolean(opening)}><span>{candidate.title}</span><ArrowUpRight size={13} /></button>)}</> : <p className="field-hint">No match found. You can open an arXiv ID directly above.</p>}</div>}
                </article>;
              })}</div></> : <div className="inspector-empty"><span className="empty-symbol"><Link2 size={24} strokeWidth={1.4} /></span><h3>{active ? 'Looking for connections' : 'The next idea is a citation away.'}</h3><p>{active ? 'Embedded paper links and detected bibliography entries appear here as the PDF loads. You can also follow links directly on a page.' : 'Open a paper to explore its references. Follow a link, then use Back to pick up where you left off.'}</p><div className="navigation-demo" aria-hidden="true"><span>Paper</span><span className="demo-arrow">↔</span><span>Reference</span></div></div>}
              {active && <details className="paper-about"><summary>About this paper <ChevronRight size={14} /></summary><p>{active.paper.abstract || 'No abstract available.'}</p><button type="button" className="text-button" onClick={() => { void openExternal(`https://arxiv.org/abs/${active.paper.arxiv_id}v${active.paper.arxiv_version}`).catch((cause) => setNotice({ tone: 'error', message: String(cause) })); }}>View on arXiv <ArrowUpRight size={13} /></button></details>}
            </div> : <div id="notes-panel" role="tabpanel" aria-labelledby="notes-tab" className="inspector-content notes-content">
              {selection && active ? <form className="selection-composer" onSubmit={(event) => { void submitSelection(event); }}>
                <div className="selection-heading"><span><span className="selection-dot" /> SELECTED PASSAGE</span><button type="button" className="icon-button" onClick={clearSelection} aria-label="Dismiss selected passage"><X size={14} /></button></div>
                <blockquote>{selection.selected_text}</blockquote><span className="selection-page">Page {selectedPages}</span>
                <div className="composer-tabs"><button type="button" className={composerKind === 'ai' ? 'is-active' : ''} onClick={() => { setComposerKind('ai'); askInputRef.current?.focus(); }}><Sparkles size={14} /> Ask AI</button><button type="button" className={composerKind === 'note' ? 'is-active' : ''} onClick={() => setComposerKind('note')}><StickyNote size={14} /> Add a note</button></div>
                {composerKind === 'ai' ? <><label className="sr-only" htmlFor="selection-question">Question about this selection</label><textarea id="selection-question" ref={askInputRef} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What would you like to understand?" rows={3} disabled={Boolean(aiPending)} />{!settings.model_id || !settings.base_url ? <div className="setup-assistant"><span>Connect your AI provider to ask a question.</span><button type="button" className="text-button" onClick={showSettings}>Set up AI <ArrowUpRight size={12} /></button></div> : <><details className="context-preview"><summary>Context sent to {settings.model_id} <ChevronRight size={12} /></summary><p>The selection, paper title, authors, abstract, and the nearby text below.</p><pre>{selection.context_text || 'No additional nearby text.'}</pre></details><button type="submit" className="button button-primary composer-submit" disabled={!question.trim() || pendingAnnotation}>{aiPending ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{aiPending ? 'Thinking and saving…' : 'Ask & save answer'}</button></>}</> : <><label className="sr-only" htmlFor="selection-note">Note for this selection</label><textarea id="selection-note" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Keep a thought beside this passage…" rows={4} disabled={Boolean(annotationBusy)} /><button type="submit" className="button button-primary composer-submit" disabled={!noteDraft.trim() || pendingAnnotation}>{annotationBusy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{annotationBusy ? 'Saving…' : 'Save note'}</button></>}
              </form> : <div className="notes-intro"><span className="empty-symbol"><MessageSquare size={23} strokeWidth={1.5} /></span><h2>Make room for a thought.</h2><p>Select a passage to ask a question or leave a note beside it.</p></div>}
              <div className="notes-list-heading"><span className="list-eyebrow">SAVED NOTES <span>{annotations.length}</span></span>{active && <div className="sidecar-controls"><button type="button" className="icon-button" onClick={() => { void exportAnnotations(); }} aria-label="Export annotations as JSON" title="Export annotation sidecar JSON" disabled={exporting}>{exporting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}</button><button type="button" className="icon-button" onClick={() => importInputRef.current?.click()} aria-label="Import annotation JSON" title="Import annotation sidecar JSON" disabled={importing}>{importing ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}</button><input ref={importInputRef} type="file" accept=".json,application/json" className="sr-only" onChange={(event) => { void importAnnotations(event); }} /></div>}</div>
              {annotations.length ? <div className="annotation-list">{annotations.map((annotation) => <article className="annotation-card" key={annotation.annotation_id}>
                <div className="annotation-meta"><span>{annotation.body.kind === 'ai_answer' ? <Sparkles size={13} /> : <StickyNote size={13} />}{annotation.body.kind === 'ai_answer' ? 'AI answer' : 'Your note'}</span><button type="button" className="annotation-page" onClick={() => jumpToAnnotation(annotation)}>p. {annotation.target.page_anchors[0]?.page_number} <ArrowUpRight size={11} /></button></div>
                <button type="button" className="annotation-quote" onClick={() => jumpToAnnotation(annotation)} title="Go to annotated passage">“{annotationQuote(annotation)}”</button>
                {annotation.body.kind === 'ai_answer' && <h3 className="annotation-question">{annotation.body.question}</h3>}
                {editId === annotation.annotation_id ? <div className="annotation-editor"><label className="sr-only" htmlFor={`edit-${annotation.annotation_id}`}>Edit {annotation.body.kind === 'ai_answer' ? 'answer' : 'note'}</label><textarea id={`edit-${annotation.annotation_id}`} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} rows={6} /><div><button type="button" className="text-button" onClick={() => setEditId(null)}>Cancel</button><button type="button" className="button button-primary button-small" onClick={() => { void updateAnnotation(annotation); }} disabled={Boolean(annotationBusy) || !editDraft.trim()}>Save</button></div></div> : <div className="annotation-body">{annotation.body.kind === 'note' ? annotation.body.content : annotation.body.answer}</div>}
                {annotation.body.kind === 'ai_answer' && <div className="annotation-model">{annotation.body.model_id}</div>}
                <div className="annotation-footer"><span>{new Date(annotation.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{annotation.updated_at !== annotation.created_at ? ' · edited' : ''}</span><div><button type="button" className="text-button annotation-edit" onClick={() => { setEditId(annotation.annotation_id); setEditDraft(annotation.body.kind === 'note' ? annotation.body.content : annotation.body.answer); }} disabled={Boolean(annotationBusy)}>Edit</button><button type="button" className="icon-button delete-button" onClick={() => { void removeAnnotation(annotation); }} aria-label="Delete annotation" title="Delete annotation" disabled={Boolean(annotationBusy)}>{annotationBusy === annotation.annotation_id ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}</button></div></div>
              </article>)}</div> : <p className="no-notes">Your questions and observations will collect here, anchored to the original passage.</p>}
              {active && <p className="annotation-format-hint"><FileText size={12} /> Your notes use a portable JSON sidecar.</p>}
            </div>}
            <div className="inspector-footer"><span className="inspector-footer-mark">✳</span> A trail worth following.</div>
          </aside>}
        </div>
      </main>
      {settingsOpen && <SettingsDialog settings={settings} on_close={closeSettings} on_saved={(saved) => { setSettings(saved); setSettingsOpen(false); setNotice({ tone: 'success', message: 'AI provider settings saved.' }); }} />}
    </div>
  );
}
