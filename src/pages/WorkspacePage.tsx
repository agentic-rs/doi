import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDownToLine, ArrowLeft, ArrowUpRight, Check,
  ChevronRight, CircleHelp, FileText, Link2, LoaderCircle,
  MessageSquare, Plus, Search, Settings2,
  Sparkles, StickyNote, Trash2, Upload, X,
} from 'lucide-react';
import { PdfReader } from '../components/PdfReader';
import { PaperInfoSheet } from '../components/PaperInfoSheet';
import { ReaderOverlay } from '../components/ReaderOverlay';
import { FloatingSelectionAction } from '../components/FloatingSelectionAction';
import { SettingsDialog } from '../components/SettingsDialog';
import { AiConversationCard } from '../components/AiConversationCard';
import { useAiConversations } from '../lib/useAiConversations';
import { usePhoneAiReader } from '../lib/usePhoneAiReader';
import { LibraryHome } from '../components/LibraryHome';
import { PaperTabs } from '../components/PaperTabs';
import { PaperPreviewDialog } from '../components/PaperPreviewDialog';
import { PaperLookupDialog } from '../components/PaperLookupDialog';
import { RemovePaperDialog } from '../components/RemovePaperDialog';
import { findLibraryPaper, removePaperFromHistory, sortRecentPapers } from '../lib/reader-sessions';
import type { ReaderSession } from '../lib/reader-sessions';
import '../components/reading-workspace.css';
import {
  deleteAnnotation, nativeAvailable, getPdfBytes, getSettings,
  listAnnotations, listPapers, onProgress, openExternal,
  previewArxivPaper, downloadArxivPaper, cancelPaperOperation, markPaperOpened, removePaper,
  resolveReference, saveAnnotation, saveAnnotationFile, saveReadingPosition,
  getReaderCapabilities, setReaderOrientation,
} from '../lib/tauri';
import {
  canGoBack, canGoForward, createHistory, currentLocation, goBack, goForward,
  pushLocation, updateCurrent,
} from '../lib/history';
import type { NavigationHistory } from '../lib/history';
import { parseAnnotationSidecar, serializeAnnotations } from '../lib/annotations';
import { DEFAULT_AI_SETTINGS } from '../lib/ai-providers';
import type {
  AiSettings, Annotation, OperationProgress, PageAnchor, Paper, ReaderTarget, ReadingLocation,
  ReferenceCandidate, ReferenceItem, SelectionContext,
  ReaderCapabilities, ReaderOrientation, PaperPreview,
} from '../lib/types';

interface ActiveDocument {
  paper: Paper;
  pdf_data: Uint8Array;
  initial_fit_width: boolean;
}

interface OpenOperation {
  request_id: string;
  label: string;
  kind: 'lookup' | 'download' | 'open';
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

function getReaderDirection(): ReaderOrientation {
  // The keyboard changes the web viewport's shape, not the device direction.
  const type = window.screen.orientation?.type;
  if (type?.startsWith('portrait')) return 'portrait';
  if (type?.startsWith('landscape')) return 'landscape';
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

function initialLocation(paper: Paper): ReadingLocation {
  return paper.last_location ?? {
    paper_id: paper.paper_id,
    page_number: 1,
    page_position: [0, 0],
    zoom: 1,
    zoom_mode: 'fit_width',
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

function selectionKey(selection: SelectionContext): string {
  return `${JSON.stringify(selection.page_anchors)}:${selection.selected_text}`;
}

function annotationQuote(annotation: Annotation): string {
  return annotation.target.page_anchors.map((anchor) => anchor.text_quote.exact_text).join(' ');
}

function sortAnnotations(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function cooldownMessage(progress: OperationProgress | null, pending: boolean): string | null {
  if (progress?.phase !== 'waiting' || !progress.retry_at) return null;
  const time = new Date(progress.retry_at);
  return Number.isFinite(time.getTime())
    ? `Waiting for arXiv. ${pending ? 'Next attempt' : 'Retry available'} after ${time.toLocaleTimeString()}.`
    : null;
}

export function WorkspacePage() {
  const [isNative] = useState(nativeAvailable);
  const [paperInfoOpen, setPaperInfoOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [readerCapabilities, setReaderCapabilities] = useState<ReaderCapabilities>({ supports_orientation: false, device_kind: 'unknown' });
  const [readerOrientation, setReaderOrientationState] = useState<ReaderOrientation>(getReaderDirection);
  const [orientationPending, setOrientationPending] = useState(false);
  const [viewportKey, setViewportKey] = useState(0);
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
  const [preview, setPreview] = useState<PaperPreview | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Paper | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [tabIds, setTabIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'references' | 'notes'>('references');
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [composerKind, setComposerKind] = useState<'ai' | 'note'>('ai');
  const [question, setQuestion] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const [aiEntryPending, setAiEntryPending] = useState(false);
  const [annotationBusy, setAnnotationBusy] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [settings, setSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
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
  const progressRef = useRef<OperationProgress | null>(null);
  const openSequenceRef = useRef(0);
  const currentPositionRef = useRef<ReadingLocation | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const arxivInputRef = useRef<HTMLInputElement>(null);
  const askInputRef = useRef<HTMLTextAreaElement>(null);
  const notesPanelRef = useRef<HTMLDivElement>(null);
  const aiDialogRef = useRef<HTMLElement>(null);
  const aiEntrySequenceRef = useRef(0);
  const annotationChangesRef = useRef(new Map<string, { paper_id: string; pdf_hash: string; annotation: Annotation | null }>());
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const sessionsRef = useRef(new Map<string, ReaderSession>());
  const draftsRef = useRef({ question, note_draft: noteDraft, composer_kind: composerKind, inspector_tab: inspectorTab, edit_id: editId, edit_draft: editDraft });
  draftsRef.current = { question, note_draft: noteDraft, composer_kind: composerKind, inspector_tab: inspectorTab, edit_id: editId, edit_draft: editDraft };
  const removedPapersRef = useRef(new Set<string>());
  const lookupSourceRef = useRef<string | null>(null);
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const supportsTabs = !isNative || readerCapabilities.device_kind === 'tablet' || readerCapabilities.device_kind === 'desktop';
  const modalOpen = Boolean(preview || removing || paperInfoOpen || settingsOpen || (active && opening?.kind === 'lookup'));
  const readerActionsRef = useRef({ handleNavigate, toggleReadingControls });
  readerActionsRef.current = { handleNavigate, toggleReadingControls };
  const aiConversations = useAiConversations(isNative ? active?.paper ?? null : null, storeAnnotation);
  const isPhone = readerCapabilities.device_kind === 'phone';
  const requiresPhoneAi = isNative && (isPhone || readerCapabilities.device_kind === 'unknown');
  const phoneAi = usePhoneAiReader({
    enabled: isNative && isPhone,
    on_error: (message) => setNotice({ tone: 'error', message }),
    on_orientation: (orientation) => {
      setReaderOrientationState(orientation);
      setViewportKey((value) => value + 1);
    },
  });
  const aiTransition = phoneAi.pending || aiEntryPending;
  const composingAi = composerKind === 'ai' && (!requiresPhoneAi || phoneAi.open);

  const hideReadingControls = useCallback(() => {
    aiEntrySequenceRef.current += 1;
    setAiEntryPending(false);
    phoneAi.close();
    setControlsVisible(false);
    setInspectorOpen(false);
  }, [phoneAi.close]);

  useLayoutEffect(() => {
    if (!phoneAi.open || !inspectorOpen || settingsOpen) return;
    const dialog = aiDialogRef.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, a[href]',
      ) ?? []).filter((element) => !element.closest('[hidden], [inert]')
        && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
      if (!controls.length) return;
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
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [phoneAi.open, inspectorOpen, settingsOpen]);

  function storeAnnotation(saved: Annotation) {
    if (removedPapersRef.current.has(saved.target.paper_id)) return;
    annotationChangesRef.current.set(saved.annotation_id, { paper_id: saved.target.paper_id, pdf_hash: saved.target.pdf_hash, annotation: saved });
    const paper = activeRef.current?.paper;
    if (mountedRef.current && paper?.paper_id === saved.target.paper_id && paper.pdf_hash === saved.target.pdf_hash) {
      setAnnotations((existing) => sortAnnotations([saved, ...existing.filter((item) => item.annotation_id !== saved.annotation_id)]));
    }
  }

  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    void getReaderCapabilities().then((capabilities) => {
      if (!cancelled) setReaderCapabilities(capabilities);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isNative]);

  useEffect(() => {
    function handleDirection() {
      setReaderOrientationState(getReaderDirection());
    }
    function handleResize() {
      handleDirection();
      setViewportKey((value) => value + 1);
    }
    const orientation = window.screen.orientation;
    orientation?.addEventListener('change', handleDirection);
    window.addEventListener('resize', handleResize);
    return () => {
      orientation?.removeEventListener('change', handleDirection);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  function focusArxivInput() {
    if (modalOpen || phoneAi.open || aiTransition) return;
    flushSync(() => showHome());
    arxivInputRef.current?.focus();
  }

  useLayoutEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !active || modalOpen) return;
      hideReadingControls();
      document.querySelector<HTMLElement>('[aria-label="Scrollable PDF pages"], [aria-label="Scrollable reading view"]')?.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [active, modalOpen, hideReadingControls]);

  const commitHistory = useCallback((next: NavigationHistory) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);

  const storePapers = useCallback((next: Paper[]) => {
    const sorted = sortRecentPapers(next.filter((paper) => !removedPapersRef.current.has(paper.paper_id)));
    papersRef.current = sorted;
    setPapers(sorted);
  }, []);

  const flushPosition = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const location = currentPositionRef.current;
    if (!isNative || !location || removedPapersRef.current.has(location.paper_id)) return;
    void saveReadingPosition(location).catch((cause) => {
      if (mountedRef.current && !removedPapersRef.current.has(location.paper_id)) setNotice({ tone: 'error', message: `Could not save your reading position: ${String(cause)}` });
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
      if (event.request_id === openingRef.current?.request_id) {
        progressRef.current = event;
        setProgress(event);
      }
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      flushPosition();
      if (openingRef.current?.kind !== 'open' && openingRef.current) void cancelPaperOperation(openingRef.current.request_id).catch(() => {});
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [flushPosition, isNative, storePapers]);

  const handleLocationChange = useCallback((location: ReadingLocation) => {
    if (activeRef.current?.paper.paper_id !== location.paper_id) return;
    if ((location.reader_mode ?? 'pdf') !== (currentPositionRef.current?.reader_mode ?? 'pdf')) return;
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
    setInspectorTab('notes');
  }, []);

  function clearSelection() {
    selectionRef.current = null;
    setSelection(null);
    setQuestion('');
    setNoteDraft('');
  }

  function toggleReadingControls() {
    if (modalOpen || phoneAi.open || aiTransition) return;
    if (controlsVisible) hideReadingControls();
    else setControlsVisible(true);
  }

  function closePaperInfo() {
    setPaperInfoOpen(false);
    hideReadingControls();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Scrollable PDF pages"], [aria-label="Scrollable reading view"]')?.focus({ preventScroll: true }));
  }

  function showPaperInfo() {
    setPaperInfoOpen(true);
    hideReadingControls();
  }

  async function changeReaderDirection() {
    if (orientationPending || phoneAi.open || aiTransition || !readerCapabilities.supports_orientation) return;
    setOrientationPending(true);
    try {
      const next = readerOrientation === 'portrait' ? 'landscape' : 'portrait';
      const actual = await setReaderOrientation(next);
      if (mountedRef.current) {
        setReaderOrientationState(actual);
        setViewportKey((value) => value + 1);
      }
    } catch (cause) {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not change the viewing direction: ${String(cause)}` });
    } finally {
      if (mountedRef.current) setOrientationPending(false);
    }
  }

  function rememberSession() {
    const document = activeRef.current;
    const location = currentPositionRef.current;
    if (!document || !location || removedPapersRef.current.has(document.paper.paper_id)) return;
    const old = sessionsRef.current.get(document.paper.paper_id);
    sessionsRef.current.set(document.paper.paper_id, {
      paper: { ...document.paper, last_location: location }, history: historyRef.current, location,
      selection: selectionRef.current, ...draftsRef.current,
      source_paper_id: old?.source_paper_id ?? null,
    });
  }

  function stopOpening() {
    openSequenceRef.current += 1;
    const operation = openingRef.current;
    openingRef.current = null;
    setOpening(null);
    progressRef.current = null;
    setProgress(null);
    if (operation && operation.kind !== 'open') void cancelPaperOperation(operation.request_id).catch((cause) => {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not cancel the paper request: ${String(cause)}` });
    });
  }

  function showHome() {
    rememberSession();
    flushPosition();
    stopOpening();
    hideReadingControls();
    setPaperInfoOpen(false);
    activeRef.current = null;
    setActive(null);
    currentPositionRef.current = null;
    if (!supportsTabs) setTabIds([]);
    commitHistory(createHistory());
  }

  function closePaper(paperId: string) {
    const wasActive = activeRef.current?.paper.paper_id === paperId;
    if (wasActive) showHome();
    const remaining = tabIdsRef.current.filter((id) => id !== paperId);
    tabIdsRef.current = remaining;
    setTabIds(remaining);
    sessionsRef.current.delete(paperId);
    if (wasActive && supportsTabs && remaining.length) {
      const next = papersRef.current.find((paper) => paper.paper_id === remaining[remaining.length - 1]);
      if (next) void openPaper(next.arxiv_id, next);
    }
  }

  function applyDocument(document: ActiveDocument, notes: Annotation[], nextHistory: NavigationHistory, location: ReadingLocation, session?: ReaderSession) {
    hideReadingControls();
    setPaperInfoOpen(false);
    activeRef.current = document;
    setActive(document);
    const mergedNotes = new Map(notes.map((annotation) => [annotation.annotation_id, annotation]));
    for (const [id, change] of annotationChangesRef.current) {
      if (change.paper_id !== document.paper.paper_id || change.pdf_hash !== document.paper.pdf_hash) continue;
      if (change.annotation) mergedNotes.set(id, change.annotation);
      else mergedNotes.delete(id);
    }
    setAnnotations(sortAnnotations([...mergedNotes.values()]));
    setReferences([]);
    setResolutions({});
    selectionRef.current = session?.selection ?? null;
    setSelection(session?.selection ?? null);
    setQuestion(session?.question ?? '');
    setNoteDraft(session?.note_draft ?? '');
    setComposerKind(session?.composer_kind ?? 'ai');
    setInspectorTab(session?.inspector_tab ?? 'references');
    setEditId(session?.edit_id ?? null);
    setEditDraft(session?.edit_draft ?? '');
    currentPositionRef.current = location;
    commitHistory(nextHistory);
    setTargetLocation(location);
    setTargetAnchor(null);
    setNavigationKey((value) => value + 1);
    setTabIds((ids) => supportsTabs ? ids.includes(document.paper.paper_id) ? ids : [...ids, document.paper.paper_id] : [document.paper.paper_id]);
  }

  async function lookupPaper(input: string, sourcePaperId: string | null = null) {
    if (!isNative || !input.trim()) return;
    stopOpening();
    lookupSourceRef.current = sourcePaperId;
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: crypto.randomUUID(), label: input.trim(), kind: 'lookup' };
    openingRef.current = operation;
    setOpening(operation);
    setLookupError(null);
    setDownloadError(null);
    setNotice(null);
    try {
      const result = await previewArxivPaper(input.trim(), operation.request_id);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      if (result.library_paper) {
        await openPaper(result.library_paper.arxiv_id, result.library_paper, sourcePaperId);
      } else setPreview(result);
    } catch (cause) {
      if (sequence === openSequenceRef.current && mountedRef.current) {
        setLookupError(String(cause));
        if (activeRef.current) setNotice({ tone: 'error', message: [String(cause), cooldownMessage(progressRef.current, false)].filter(Boolean).join(' ') });
      }
    } finally {
      if (sequence === openSequenceRef.current && mountedRef.current) {
        openingRef.current = null;
        setOpening(null);
        setProgress((value) => value?.phase === 'waiting' ? value : null);
      }
    }
  }

  function cancelPreview() {
    stopOpening();
    setPreview(null);
    setDownloadError(null);
  }

  async function confirmDownload() {
    if (!preview || openingRef.current) return;
    const captured = preview;
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: crypto.randomUUID(), label: captured.metadata.title, kind: 'download' };
    openingRef.current = operation;
    setOpening(operation);
    setDownloadError(null);
    try {
      const paper = await downloadArxivPaper(captured.preview_id, operation.request_id);
      if (!mountedRef.current) return;
      // A cancellation can arrive after the backend's atomic commit. Keep any
      // saved paper visible, using a fresh list so an intervening removal wins.
      if (sequence !== openSequenceRef.current) {
        const saved = await listPapers();
        if (mountedRef.current) storePapers(saved.filter((item) => !removedPapersRef.current.has(item.paper_id)));
        return;
      }
      removedPapersRef.current.delete(paper.paper_id);
      storePapers([paper, ...papersRef.current.filter((item) => item.paper_id !== paper.paper_id)]);
      setPreview(null);
      await openPaper(paper.arxiv_id, paper, lookupSourceRef.current);
    } catch (cause) {
      if (sequence === openSequenceRef.current && mountedRef.current) setDownloadError(String(cause));
    } finally {
      if (sequence === openSequenceRef.current && mountedRef.current) {
        openingRef.current = null;
        setOpening(null);
        setProgress((value) => value?.phase === 'waiting' ? value : null);
      }
    }
  }

  async function openPaper(input: string, cachedPaper?: Paper, sourcePaperId: string | null = null) {
    if (!cachedPaper) { await lookupPaper(input, sourcePaperId); return; }
    if (!isNative || removedPapersRef.current.has(cachedPaper.paper_id)) return;
    if (activeRef.current?.paper.paper_id === cachedPaper.paper_id) return;
    stopOpening();
    rememberSession();
    flushPosition();
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: crypto.randomUUID(), label: cachedPaper.title, kind: 'open' };
    openingRef.current = operation;
    setOpening(operation);
    setNotice(null);
    try {
      const [pdfData, notes, storedPaper] = await Promise.all([
        getPdfBytes(cachedPaper.paper_id), listAnnotations(cachedPaper.paper_id), markPaperOpened(cachedPaper.paper_id),
      ]);
      if (sequence !== openSequenceRef.current || !mountedRef.current || removedPapersRef.current.has(cachedPaper.paper_id)) return;
      rememberSession();
      const session = sessionsRef.current.get(cachedPaper.paper_id);
      const last_location = session?.location ?? papersRef.current.find((paper) => paper.paper_id === cachedPaper.paper_id)?.last_location ?? storedPaper.last_location;
      const paper = { ...storedPaper, last_location };
      const location = initialLocation(paper);
      const nextHistory = supportsTabs ? session?.history ?? createHistory(location) : pushLocation(historyRef.current, location);
      applyDocument({ paper, pdf_data: pdfData, initial_fit_width: !last_location }, notes, nextHistory, location, session);
      sessionsRef.current.set(paper.paper_id, {
        paper, location, history: nextHistory, selection: session?.selection ?? null,
        question: session?.question ?? '', note_draft: session?.note_draft ?? '', composer_kind: session?.composer_kind ?? 'ai',
        inspector_tab: session?.inspector_tab ?? 'references', edit_id: session?.edit_id ?? null, edit_draft: session?.edit_draft ?? '',
        source_paper_id: sourcePaperId ?? session?.source_paper_id ?? null,
      });
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

  async function confirmRemoval() {
    if (!removing || removeBusy) return;
    const paperId = removing.paper_id;
    setRemoveBusy(true);
    setRemoveError(null);
    stopOpening();
    try {
      await removePaper(paperId);
      if (!mountedRef.current) return;
      removedPapersRef.current.add(paperId);
      aiConversations.forgetPaper(paperId);
      if (activeRef.current?.paper.paper_id === paperId) showHome();
      sessionsRef.current.delete(paperId);
      for (const session of sessionsRef.current.values()) {
        session.history = removePaperFromHistory(session.history, paperId);
        if (session.source_paper_id === paperId) session.source_paper_id = null;
      }
      commitHistory(removePaperFromHistory(historyRef.current, paperId));
      setTabIds((ids) => ids.filter((id) => id !== paperId));
      for (const [id, change] of annotationChangesRef.current) {
        if (change.paper_id === paperId) annotationChangesRef.current.delete(id);
      }
      storePapers(papersRef.current.filter((paper) => paper.paper_id !== paperId));
      setRemoving(null);
    } catch (cause) {
      if (mountedRef.current) setRemoveError(String(cause));
    } finally {
      if (mountedRef.current) setRemoveBusy(false);
    }
  }

  async function navigateHistory(direction: 'back' | 'forward') {
    const moved = direction === 'back' ? goBack(historyRef.current) : goForward(historyRef.current);
    const location = currentLocation(moved);
    if (!location || moved.current_index === historyRef.current.current_index) return;
    stopOpening();
    flushPosition();
    if (activeRef.current?.paper.paper_id === location.paper_id) {
      hideReadingControls();
      setPaperInfoOpen(false);
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
    const operation: OpenOperation = { request_id: crypto.randomUUID(), label: paper.title, kind: 'open' };
    openingRef.current = operation;
    setOpening(operation);
    setProgress(null);
    setNotice(null);
    try {
      const [pdfData, notes] = await Promise.all([getPdfBytes(paper.paper_id), listAnnotations(paper.paper_id)]);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      rememberSession();
      applyDocument({ paper, pdf_data: pdfData, initial_fit_width: false }, notes, moved, location, sessionsRef.current.get(paper.paper_id));
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
    stopOpening();
    hideReadingControls();
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
      const cached = findLibraryPaper(papersRef.current, arxivId);
      await openPaper(arxivId, cached, activeRef.current?.paper.paper_id ?? null);
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

  // Replace state-sensitive document shortcuts during the DOM commit. Waiting
  // for passive effects leaves a newly visible modal using the old handler.
  useLayoutEffect(() => {
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

  function revealConversation(conversationId: string, paperId: string) {
    const notesPanel = notesPanelRef.current;
    requestAnimationFrame(() => {
      if (activeRef.current?.paper.paper_id !== paperId
        || !notesPanel?.isConnected || notesPanelRef.current !== notesPanel) return;
      const draft = document.getElementById(`ai-conversation-${conversationId}`);
      if (!draft || !notesPanel.contains(draft)) return;
      // Only scroll the Notes panel: scrollIntoView can pan the iOS viewport
      // while the software keyboard closes.
      const top = notesPanel.scrollTop + draft.getBoundingClientRect().top
        - notesPanel.getBoundingClientRect().top - notesPanel.clientTop;
      notesPanel.scrollTo?.({ top: Math.max(0, top),
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }

  async function openAi(conversationId?: string) {
    const paperId = activeRef.current?.paper.paper_id;
    if (!paperId || aiTransition || orientationPending) return;
    const sequence = ++aiEntrySequenceRef.current;
    let capabilities = readerCapabilities;
    try {
      if (isNative && capabilities.device_kind === 'unknown') {
        setAiEntryPending(true);
        capabilities = await getReaderCapabilities();
        if (!mountedRef.current || sequence !== aiEntrySequenceRef.current) return;
        if (capabilities.device_kind === 'unknown') throw new Error('The device type is unavailable. Please try again.');
        flushSync(() => setReaderCapabilities(capabilities));
      }
      if (capabilities.device_kind === 'phone' && !await phoneAi.show()) return;
      if (!mountedRef.current || sequence !== aiEntrySequenceRef.current
        || activeRef.current?.paper.paper_id !== paperId) return;
      flushSync(() => {
        setComposerKind('ai');
        setInspectorTab('notes');
        setControlsVisible(true);
        setInspectorOpen(true);
        if (conversationId && aiConversations.conversations.find((view) => view.conversation.conversation_id === conversationId)?.collapsed) {
          aiConversations.toggleCollapsed(conversationId);
        }
      });
      if (conversationId) revealConversation(conversationId, paperId);
    } catch (cause) {
      if (mountedRef.current && sequence === aiEntrySequenceRef.current) {
        setNotice({ tone: 'error', message: `Could not open AI: ${String(cause)}` });
      }
    } finally {
      if (mountedRef.current && sequence === aiEntrySequenceRef.current) setAiEntryPending(false);
    }
  }

  async function submitSelection(event: FormEvent) {
    event.preventDefault();
    const paper = activeRef.current?.paper;
    const capturedSelection = selectionRef.current;
    if (!paper || !capturedSelection || annotationBusy) return;
    if (composingAi) {
      if (!question.trim()) return;
      const conversationId = aiConversations.ask(paper, capturedSelection, question);
      if (!conversationId) return;
      setQuestion('');
      askInputRef.current?.blur();
      revealConversation(conversationId, paper.paper_id);
      return;
    }
    if (!noteDraft.trim()) return;
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
    setNotice(null);
    setAnnotationBusy(annotation.annotation_id);
    try {
      const saved = await saveAnnotation(annotation);
      if (!mountedRef.current) return;
      storeAnnotation(saved);
      if (activeRef.current?.paper.paper_id === paper.paper_id) {
        if (selectionRef.current && selectionKey(selectionRef.current) === capturedKey) setNoteDraft('');
      }
      setNotice({ tone: 'success', message: activeRef.current?.paper.paper_id === paper.paper_id ? 'Note saved to this passage.' : `Note saved to “${paper.title}”.` });
    } catch (cause) {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not save your note: ${String(cause)}` });
    } finally {
      if (mountedRef.current) setAnnotationBusy(null);
    }
  }

  async function removeAnnotation(annotation: Annotation) {
    setAnnotationBusy(annotation.annotation_id);
    try {
      await deleteAnnotation(annotation.annotation_id);
      annotationChangesRef.current.set(annotation.annotation_id, { paper_id: annotation.target.paper_id, pdf_hash: annotation.target.pdf_hash, annotation: null });
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
        body: annotation.body.kind === 'note' ? { ...annotation.body, content: editDraft.trim() } : { ...annotation.body, note_content: editDraft.trim() },
        updated_at: new Date().toISOString(),
      });
      storeAnnotation(updated);
      if (activeRef.current?.paper.paper_id === annotation.target.paper_id) {
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
    jumpTo({ ...location, page_number: anchor.page_number, page_position: [0, 0], reading_block_id: null }, anchor);
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
        storeAnnotation(saved);
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
      const cached = findLibraryPaper(papersRef.current, reference.arxiv_id);
      void openPaper(reference.arxiv_id, cached, activeRef.current?.paper.paper_id ?? null);
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

  const current = currentLocation(history);
  const selectedPages = selection ? [...new Set(selection.page_anchors.map((anchor) => anchor.page_number))].join(', ') : '';
  const pendingAnnotation = Boolean(annotationBusy);
  const sourcePaperId = active ? sessionsRef.current.get(active.paper.paper_id)?.source_paper_id : null;
  const sourcePaper = sourcePaperId ? papers.find((paper) => paper.paper_id === sourcePaperId) : undefined;
  const operationMessage = cooldownMessage(progress, Boolean(opening))
    ?? progress?.message ?? (opening?.kind === 'lookup' ? 'Looking up the paper on arXiv…' : opening?.kind === 'download' ? 'Downloading the original PDF…' : `Opening ${opening?.label ?? 'paper'}…`);

  const reader = useMemo(() => active ? <PdfReader paper={active.paper} pdf_data={active.pdf_data} annotations={annotations} target_location={targetLocation} target_anchor={targetAnchor} navigation_key={navigationKey} controls_visible={controlsVisible && !inspectorOpen} on_toggle_controls={() => readerActionsRef.current.toggleReadingControls()} viewport_key={viewportKey} initial_fit_width={active.initial_fit_width} reading_active={!modalOpen && !inspectorOpen} on_location_change={handleLocationChange} on_navigate={(target) => readerActionsRef.current.handleNavigate(target)} on_selection={handleSelection} on_references={(items) => { if (activeRef.current?.paper.paper_id === active.paper.paper_id) setReferences(items); }} on_error={(message) => setNotice({ tone: 'error', message })} /> : null,
    [active, annotations, targetLocation, targetAnchor, navigationKey, controlsVisible, inspectorOpen, viewportKey, modalOpen, handleLocationChange, handleSelection]);

  return (
    <div className={`app-shell library-workspace ${active ? 'reading-mode' : 'library-home-mode'} ${supportsTabs && tabIds.length ? 'has-paper-tabs' : ''} ${phoneAi.open ? 'phone-ai-open' : ''}`}>
      {supportsTabs && tabIds.length > 0 && <div className="workspace-tabs" inert={modalOpen || phoneAi.open || aiTransition}><PaperTabs
        tabs={tabIds.flatMap((id) => { const paper = papers.find((item) => item.paper_id === id); return paper ? [{ paper_id: id, title: paper.title }] : []; })}
        active_paper_id={active?.paper.paper_id ?? null} disabled={Boolean(opening)} on_home={showHome}
        on_activate={(id) => { const paper = papersRef.current.find((item) => item.paper_id === id); if (paper) void openPaper(paper.arxiv_id, paper); }} on_close={closePaper} /></div>}
      <main className="workbench" inert={modalOpen}>
        {!active && <LibraryHome papers={papers} is_native={isNative} loading={libraryLoading} error={libraryError}
          input={arxivInput} input_ref={arxivInputRef} search={searchInput} lookup_busy={Boolean(opening)} lookup_message={opening || progress?.phase === 'waiting' ? operationMessage : null} lookup_error={lookupError}
          on_input_change={setArxivInput} on_search_change={setSearchInput} on_lookup={() => { void lookupPaper(arxivInput); }} on_cancel_lookup={stopOpening}
          on_open={(paper) => { void openPaper(paper.arxiv_id, paper); }} on_remove={(paper) => { setRemoving(paper); setRemoveError(null); }}
          on_retry_library={() => { void retryLibrary(); }} on_settings={showSettings} />}
        {active && controlsVisible && !phoneAi.open && <ReaderOverlay paper={active.paper} can_go_back={canGoBack(history)} can_go_forward={canGoForward(history)} busy={Boolean(opening) || aiTransition} inspector_open={inspectorOpen} supports_orientation={readerCapabilities.supports_orientation} orientation={readerOrientation} orientation_pending={orientationPending || aiTransition} library_button_ref={libraryButtonRef} on_back={() => { void navigateHistory('back'); }} on_forward={() => { void navigateHistory('forward'); }} on_library={showHome} on_info={showPaperInfo} on_inspector={() => setInspectorOpen((value) => !value)} on_settings={showSettings} on_direction={() => { void changeReaderDirection(); }} on_close={() => closePaper(active.paper.paper_id)} source_title={supportsTabs ? sourcePaper?.title : undefined} on_source={supportsTabs && sourcePaper ? () => { void openPaper(sourcePaper.arxiv_id, sourcePaper); } : undefined} reader_mode={current?.reader_mode ?? 'pdf'} on_mode={() => {
          const source = currentPositionRef.current ?? current;
          if (source) jumpTo({ ...source, reader_mode: source.reader_mode === 'reading' ? 'pdf' : 'reading', reading_block_id: null, zoom: 1, zoom_mode: 'fit_width' });
        }} />}

        {active && opening?.kind === 'open' && <div className="operation-banner" role="status"><LoaderCircle size={15} className="spin" /><span>{operationMessage}</span></div>}
        {notice && <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <Check size={15} /> : notice.tone === 'error' ? <CircleHelp size={15} /> : <CircleHelp size={15} />}<span>{notice.message}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={14} /></button></div>}

        {aiTransition && !phoneAi.open && <div className="phone-ai-transition" role="status"><LoaderCircle size={20} className="spin" /><span>Changing viewing direction…</span><button type="button" className="text-button" onClick={hideReadingControls}>Back to paper</button></div>}
        <FloatingSelectionAction controls_visible={controlsVisible} visible={Boolean(active && selection && !inspectorOpen && !modalOpen && !aiTransition && !orientationPending)} on_activate={() => { void openAi(); }} />

        {active && <div className={`reading-grid ${inspectorOpen ? 'with-inspector' : ''}`}>
          <section className={`reading-surface ${active ? 'has-paper' : ''}`} aria-label="Paper reader">
            <div className="pdf-reader-mount" inert={inspectorOpen || aiTransition}>{reader}</div>
          </section>

          {inspectorOpen && <aside ref={aiDialogRef} id="paper-inspector" className={`inspector ${phoneAi.open ? 'phone-ai-screen' : ''}`} role={phoneAi.open ? 'dialog' : undefined} aria-modal={phoneAi.open ? true : undefined} aria-label={phoneAi.open ? 'Ask AI' : 'References and annotations'}>
            {phoneAi.open ? <header className="phone-ai-header"><button type="button" className="text-button" onClick={hideReadingControls}><ArrowLeft size={18} /> Back to paper</button><div><strong>Ask AI</strong><span>{active?.paper.title}</span></div><button type="button" className="icon-button" aria-label="AI provider settings" onClick={showSettings}><Settings2 size={18} /></button></header> : <div className="inspector-tabs" role="tablist" aria-label="Paper details">
              <button type="button" role="tab" id="references-tab" aria-controls="references-panel" aria-selected={inspectorTab === 'references'} className={inspectorTab === 'references' ? 'is-active' : ''} onClick={() => setInspectorTab('references')}><Link2 size={15} /> References {references.length > 0 && <span>{references.length}</span>}</button>
              <button type="button" role="tab" id="notes-tab" aria-controls="notes-panel" aria-selected={inspectorTab === 'notes'} className={inspectorTab === 'notes' ? 'is-active' : ''} onClick={() => setInspectorTab('notes')}><StickyNote size={15} /> Notes {annotations.length > 0 && <span>{annotations.length}</span>}</button>
            </div>}
            {inspectorTab === 'references' ? <div id="references-panel" role="tabpanel" aria-labelledby="references-tab" className="inspector-content">
              <div className="inspector-intro"><h2>Follow the thread.</h2><p>Every paper is part of a bigger conversation.</p></div>
              {references.length ? <><div className="list-eyebrow">CITATIONS & LINKS <span>{references.length}</span></div><div className="reference-list">{references.map((reference, index) => {
                const resolution = resolutions[reference.reference_id];
                const canOpen = Boolean(reference.arxiv_id || reference.doi || reference.url);
                return <article className="reference-card" key={reference.reference_id}>
                  <div className="reference-number">{String(index + 1).padStart(2, '0')} <span>p. {reference.page_number}</span></div>
                  <p className="reference-citation">{reference.citation_text}</p>
                  <div className="reference-actions">{canOpen ? <button type="button" className="text-button" onClick={() => openReference(reference)} disabled={Boolean(opening)}>{reference.arxiv_id ? 'Read paper' : reference.doi ? 'Open DOI' : 'Open link'}<ArrowUpRight size={13} /></button> : <button type="button" className="text-button" onClick={() => { void findReference(reference); }} disabled={resolution?.busy}>{resolution?.busy ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />} {resolution?.busy ? 'Finding matches…' : 'Find a match'}</button>}<button type="button" className="reference-page" onClick={() => { if (current) jumpTo({ ...current, page_number: reference.page_number, page_position: [0, 0], reading_block_id: null }); }} aria-label={`Go to reference on page ${reference.page_number}`} title="Show in paper"><ChevronRight size={15} /></button></div>
                  {resolution && !resolution.busy && <div className="reference-results">{resolution.error ? <p className="inline-error">{resolution.error}</p> : resolution.candidates.length ? <><span className="candidate-label">Choose a possible match</span>{resolution.candidates.map((candidate, candidateIndex) => <button type="button" className="reference-candidate" key={`${candidate.url}-${candidateIndex}`} onClick={() => openReference(candidate)} disabled={Boolean(opening)}><span>{candidate.title}</span><ArrowUpRight size={13} /></button>)}</> : <p className="field-hint">No match found. Return to the library to look up an arXiv ID.</p>}</div>}
                </article>;
              })}</div></> : <div className="inspector-empty"><span className="empty-symbol"><Link2 size={24} strokeWidth={1.4} /></span><h3>{active ? 'Looking for connections' : 'The next idea is a citation away.'}</h3><p>{active ? 'Embedded paper links and detected bibliography entries appear here as the PDF loads. You can also follow links directly on a page.' : 'Open a paper to explore its references. Follow a link, then use Back to pick up where you left off.'}</p><div className="navigation-demo" aria-hidden="true"><span>Paper</span><span className="demo-arrow">↔</span><span>Reference</span></div></div>}
              {active && <details className="paper-about"><summary>About this paper <ChevronRight size={14} /></summary><p>{active.paper.abstract || 'No abstract available.'}</p><button type="button" className="text-button" onClick={() => { void openExternal(`https://arxiv.org/abs/${active.paper.arxiv_id}v${active.paper.arxiv_version}`).catch((cause) => setNotice({ tone: 'error', message: String(cause) })); }}>View on arXiv <ArrowUpRight size={13} /></button></details>}
            </div> : <div id="notes-panel" ref={notesPanelRef} role={phoneAi.open ? undefined : 'tabpanel'} aria-labelledby={phoneAi.open ? undefined : 'notes-tab'} className="inspector-content notes-content">
              {selection && active ? <form className="selection-composer" onSubmit={(event) => { void submitSelection(event); }}>
                <div className="selection-heading"><span><span className="selection-dot" /> SELECTED PASSAGE</span><button type="button" className="icon-button" onClick={clearSelection} aria-label="Dismiss selected passage"><X size={14} /></button></div>
                <blockquote>{selection.selected_text}</blockquote><span className="selection-page">Page {selectedPages}</span>
                <div className="composer-tabs"><button type="button" className={composingAi ? 'is-active' : ''} onClick={() => { if (requiresPhoneAi && !phoneAi.open) void openAi(); else { setComposerKind('ai'); askInputRef.current?.focus(); } }}><Sparkles size={14} /> Ask AI</button>{!phoneAi.open && <button type="button" className={!composingAi ? 'is-active' : ''} onClick={() => setComposerKind('note')}><StickyNote size={14} /> Add a note</button>}</div>
                {composingAi ? <><label className="sr-only" htmlFor="selection-question">Question about this selection</label><textarea id="selection-question" ref={askInputRef} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What would you like to understand?" rows={3} />{!settings.model_id || !settings.base_url ? <div className="setup-assistant"><span>Connect your AI provider to ask a question.</span><button type="button" className="text-button" onClick={showSettings}>Set up AI <ArrowUpRight size={12} /></button></div> : <><details className="context-preview"><summary>Context sent to {settings.model_id} <ChevronRight size={12} /></summary><p>The selection, paper title, authors, abstract, and the nearby text below.</p><pre>{selection.context_text || 'No additional nearby text.'}</pre></details><button type="submit" className="button button-primary composer-submit" disabled={!question.trim() || pendingAnnotation}><Sparkles size={15} />Ask</button></>}</> : <><label className="sr-only" htmlFor="selection-note">Note for this selection</label><textarea id="selection-note" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Keep a thought beside this passage…" rows={4} disabled={Boolean(annotationBusy)} /><button type="submit" className="button button-primary composer-submit" disabled={!noteDraft.trim() || pendingAnnotation}>{annotationBusy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{annotationBusy ? 'Saving…' : 'Save note'}</button></>}
              </form> : <div className="notes-intro"><span className="empty-symbol"><MessageSquare size={23} strokeWidth={1.5} /></span><h2>Make room for a thought.</h2><p>Select a passage to ask a question or leave a note beside it.</p></div>}
              {aiConversations.loading && <p className="field-hint" role="status">Loading conversations…</p>}
              {aiConversations.load_error && <div className="inline-error" role="alert"><p>{aiConversations.load_error}</p><button type="button" className="text-button" onClick={() => { void aiConversations.reload(); }}>Retry conversations</button></div>}
              {aiConversations.conversations.length > 0 && <div className="ai-conversation-list">{aiConversations.conversations.map((view) => {
                const id = view.conversation.conversation_id;
                if (requiresPhoneAi && !phoneAi.open) return <button type="button" className="phone-conversation-preview" key={id} onClick={() => { void openAi(id); }}>
                  <MessageSquare size={17} /><span><strong>{view.conversation.turns[0]?.question || 'AI conversation'}</strong><small>{view.conversation.turns.length} {view.conversation.turns.length === 1 ? 'question' : 'questions'} · Open conversation</small></span><ChevronRight size={16} />
                </button>;
                return <AiConversationCard key={id} view={view}
                  follow_up_question={followUpDrafts[id] ?? ''}
                  on_follow_up_question_change={(value) => setFollowUpDrafts((drafts) => ({ ...drafts, [id]: value }))}
                  on_follow_up={(question) => aiConversations.followUp(id, question)}
                  on_generate_note={() => { void aiConversations.generateNote(id); }}
                  on_stop={() => aiConversations.stop(id)}
                  on_edit_note={(content) => aiConversations.editNote(id, content)}
                  on_retry_note_persistence={() => { void aiConversations.retryNotePersistence(id); }}
                  on_save_note={() => { void aiConversations.saveNote(id); }}
                  on_toggle_collapsed={() => aiConversations.toggleCollapsed(id)} />;
              })}</div>}
              {!phoneAi.open && <><div className="notes-list-heading"><span className="list-eyebrow">SAVED NOTES <span>{annotations.length}</span></span>{active && <div className="sidecar-controls"><button type="button" className="icon-button" onClick={() => { void exportAnnotations(); }} aria-label="Export annotations as JSON" title="Export annotation sidecar JSON" disabled={exporting}>{exporting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}</button><button type="button" className="icon-button" onClick={() => importInputRef.current?.click()} aria-label="Import annotation JSON" title="Import annotation sidecar JSON" disabled={importing}>{importing ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}</button><input ref={importInputRef} type="file" accept=".json,application/json" className="sr-only" onChange={(event) => { void importAnnotations(event); }} /></div>}</div>
              {annotations.length ? <div className="annotation-list">{annotations.map((annotation) => <article className="annotation-card" key={annotation.annotation_id}>
                <div className="annotation-meta"><span>{annotation.body.kind === 'ai_answer' ? <Sparkles size={13} /> : <StickyNote size={13} />}{annotation.body.kind === 'ai_answer' ? 'AI answer' : 'Your note'}</span><button type="button" className="annotation-page" onClick={() => jumpToAnnotation(annotation)}>p. {annotation.target.page_anchors[0]?.page_number} <ArrowUpRight size={11} /></button></div>
                <button type="button" className="annotation-quote" onClick={() => jumpToAnnotation(annotation)} title="Go to annotated passage">“{annotationQuote(annotation)}”</button>
                {annotation.body.kind === 'ai_answer' && <h3 className="annotation-question">{annotation.body.question}</h3>}
                {editId === annotation.annotation_id ? <div className="annotation-editor"><label className="sr-only" htmlFor={`edit-${annotation.annotation_id}`}>Edit note</label><textarea id={`edit-${annotation.annotation_id}`} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} rows={6} /><div><button type="button" className="text-button" onClick={() => setEditId(null)}>Cancel</button><button type="button" className="button button-primary button-small" onClick={() => { void updateAnnotation(annotation); }} disabled={Boolean(annotationBusy) || !editDraft.trim()}>Save</button></div></div> : <div className="annotation-body">{annotation.body.kind === 'note' ? annotation.body.content : annotation.body.note_content ?? annotation.body.answer}</div>}
                {annotation.body.kind === 'ai_answer' && annotation.body.note_content !== undefined && annotation.body.note_content !== annotation.body.answer && <details className="annotation-full-answer"><summary>Full answer <ChevronRight size={12} /></summary><div className="annotation-body">{annotation.body.answer}</div></details>}
                {annotation.body.kind === 'ai_answer' && <div className="annotation-model">{annotation.body.model_id}</div>}
                <div className="annotation-footer"><span>{new Date(annotation.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{annotation.updated_at !== annotation.created_at ? ' · edited' : ''}</span><div><button type="button" className="text-button annotation-edit" onClick={() => { setEditId(annotation.annotation_id); setEditDraft(annotation.body.kind === 'note' ? annotation.body.content : annotation.body.note_content ?? annotation.body.answer); }} disabled={Boolean(annotationBusy)}>Edit</button><button type="button" className="icon-button delete-button" onClick={() => { void removeAnnotation(annotation); }} aria-label="Delete annotation" title="Delete annotation" disabled={Boolean(annotationBusy)}>{annotationBusy === annotation.annotation_id ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}</button></div></div>
              </article>)}</div> : <p className="no-notes">Your questions and observations will collect here, anchored to the original passage.</p>}
              {active && <p className="annotation-format-hint"><FileText size={12} /> Your notes use a portable JSON sidecar.</p>}</>}
            </div>}
            {!phoneAi.open && <div className="inspector-footer"><span className="inspector-footer-mark">✳</span> A trail worth following.</div>}
          </aside>}
        </div>}
      </main>
      {preview && <PaperPreviewDialog preview={preview} busy={opening?.kind === 'download'} message={opening?.kind === 'download' || progress?.phase === 'waiting' ? operationMessage : null} error={downloadError} on_confirm={() => { void confirmDownload(); }} on_cancel={cancelPreview} />}
      {active && opening?.kind === 'lookup' && !preview && <PaperLookupDialog label={opening.label} message={operationMessage} on_cancel={stopOpening} />}
      {removing && <RemovePaperDialog paper={removing} busy={removeBusy} error={removeError} on_confirm={() => { void confirmRemoval(); }} on_cancel={() => { if (!removeBusy) setRemoving(null); }} />}
      {paperInfoOpen && active && <PaperInfoSheet paper={active.paper} resume={Boolean(active.paper.last_location)} on_close={closePaperInfo} on_open_source={() => { void openExternal(`https://arxiv.org/abs/${active.paper.arxiv_id}v${active.paper.arxiv_version}`).catch((cause) => setNotice({ tone: 'error', message: String(cause) })); }} />}
      {settingsOpen && <SettingsDialog settings={settings} on_close={closeSettings} on_saved={(saved) => { setSettings(saved); setSettingsOpen(false); setNotice({ tone: 'success', message: 'AI provider settings saved.' }); }} />}
    </div>
  );
}
