import { createId } from '../../applet/vendor/apell-sdk';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft, BookOpen, Check,
  ChevronRight, CircleHelp, Link2, LoaderCircle,
  MessageSquare, Plus, Settings2,
  Sparkles, StickyNote, X,
} from 'lucide-react';
import { PdfReader } from '../components/PdfReader';
import { PaperInfoSheet } from '../components/PaperInfoSheet';
import { ReaderOverlay } from '../components/ReaderOverlay';
import { FloatingSelectionAction } from '../components/FloatingSelectionAction';
import { SettingsDialog } from '../components/SettingsDialog';
import { AiConversationCard } from '../components/AiConversationCard';
import { SavedNotes } from '../components/SavedNotes';
import { PaperQuestionComposer } from '../components/PaperQuestionComposer';
import { useAiConversations } from '../lib/useAiConversations';
import { usePhoneAiReader } from '../lib/usePhoneAiReader';
import { LibraryHome } from '../components/LibraryHome';
import { PaperTabs } from '../components/PaperTabs';
import { PaperPreviewDialog } from '../components/PaperPreviewDialog';
import { PaperLookupDialog } from '../components/PaperLookupDialog';
import { RemovePaperDialog } from '../components/RemovePaperDialog';
import { ReferenceCard } from '../components/ReferenceCard';
import type { ReferenceResolution } from '../components/ReferenceCard';
import { ReferenceDetailsDialog } from '../components/ReferenceDetailsDialog';
import { ExternalLinkDialog } from '../components/ExternalLinkDialog';
import { referenceLinkTarget } from '../lib/paper-links';
import { useExternalLink } from '../lib/useExternalLink';
import { findLibraryPaper, locationInReaderMode, removePaperFromHistory, sortRecentPapers } from '../lib/reader-sessions';
import type { PaperLinkSource, ReaderSession } from '../lib/reader-sessions';
import '../components/reading-workspace.css';
import {
  deleteAnnotation, nativeAvailable, getPdfBytes, getSettings,
  listAnnotations, listPapers, onProgress,
  previewArxivPaper, downloadArxivPaper, cancelPaperOperation, markPaperOpened, removePaper,
  resolveReference, saveAnnotation, saveAnnotationFile, saveReadingPosition,
  getReaderCapabilities, setReaderOrientation,
} from '../lib/backend';
import {
  canGoBack, canGoForward, createHistory, currentLocation, goBack, goForward,
  pushLocation, updateCurrent,
} from '../lib/history';
import type { NavigationHistory } from '../lib/history';
import { parseAnnotationSidecar, serializeAnnotations } from '../lib/annotations';
import { DEFAULT_AI_SETTINGS } from '../lib/ai-providers';
import type {
  AiCitation, AiPassage, AiSettings, Annotation, OperationProgress, PageAnchor, Paper, ReaderTarget, ReadingLocation,
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

interface SourcePreview {
  citation: AiCitation;
  from: 'answer' | 'note draft' | 'saved note';
  location: ReadingLocation;
  conversation_id?: string;
  annotation_id?: string;
  trigger: HTMLElement | null;
}

interface PassageCapture {
  location: ReadingLocation;
  draft_key: string;
  trigger: HTMLElement | null;
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

function selectionKey(selection: SelectionContext): string {
  return `${JSON.stringify(selection.page_anchors)}:${selection.selected_text}`;
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
  const [referenceStatus, setReferenceStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedReference, setSelectedReference] = useState<ReferenceItem | null>(null);
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
  const [attachments, setAttachments] = useState<Record<string, AiPassage[]>>({});
  const [aiScreen, setAiScreen] = useState<'question' | 'conversation' | 'list'>('question');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationVisit, setConversationVisit] = useState(0);
  const [selectedTurn, setSelectedTurn] = useState<string>();
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const previewRef = useRef<SourcePreview | null>(null);
  const [reopenedNote, setReopenedNote] = useState<string | null>(null);
  const [passageCapture, setPassageCapture] = useState<PassageCapture | null>(null);
  const captureRef = useRef<PassageCapture | null>(null);
  const [candidate, setCandidate] = useState<SelectionContext | null>(null);
  const paperInFront = Boolean(sourcePreview || passageCapture);
  const [aiEntryPending, setAiEntryPending] = useState(false);
  const [annotationBusy, setAnnotationBusy] = useState<string | null>(null);
  const annotationMutationRef = useRef<string | null>(null);
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
  const referenceEpochRef = useRef(0);
  const referenceLookupsRef = useRef(new Map<string, Promise<ReferenceCandidate[]>>());
  const currentPositionRef = useRef<ReadingLocation | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const lookupSourceRef = useRef<PaperLinkSource | null>(null);
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const supportsTabs = !isNative || readerCapabilities.device_kind === 'tablet' || readerCapabilities.device_kind === 'desktop';
  const isDesktop = !isNative || readerCapabilities.device_kind === 'desktop';
  const inspectorBlocksReader = inspectorOpen && !isDesktop && !paperInFront;
  const externalLink = useExternalLink((message) => setNotice({ tone: 'error', message }));
  const modalOpen = Boolean(externalLink.request || selectedReference || preview || removing || paperInfoOpen || settingsOpen || (active && opening?.kind === 'lookup'));
  const readerActionsRef = useRef({ handleNavigate, handleEdgeNavigation, toggleReadingControls, updateAnnotation, removeAnnotation, jumpToAnnotation, editAnnotation, readNoteCitation, openNoteOrigin });
  readerActionsRef.current = { handleNavigate, handleEdgeNavigation, toggleReadingControls, updateAnnotation, removeAnnotation, jumpToAnnotation, editAnnotation, readNoteCitation, openNoteOrigin };
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
  const edgeNavigation = isNative && (isPhone || readerCapabilities.device_kind === 'tablet')
    && active && !opening && !modalOpen && !inspectorOpen && !phoneAi.open && !aiTransition
    && !paperInFront && !orientationPending && !editId && !annotationBusy && !importing && !exporting
    ? canGoBack(history) ? 'back' : 'close' : null;

  const hideReadingControls = useCallback((keep_sidebar = false) => {
    aiEntrySequenceRef.current += 1;
    setAiEntryPending(false);
    phoneAi.close();
    setControlsVisible(false);
    if (!keep_sidebar) setInspectorOpen(false);
  }, [phoneAi.close]);

  useLayoutEffect(() => {
    if (!phoneAi.open || !inspectorOpen || settingsOpen || paperInFront) return;
    const dialog = aiDialogRef.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]',
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
  }, [phoneAi.open, inspectorOpen, settingsOpen, paperInFront]);

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
    if (modalOpen || phoneAi.open || aiTransition || paperInFront) return;
    flushSync(() => showHome());
    arxivInputRef.current?.focus();
  }

  useLayoutEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !active || modalOpen) return;
      if (previewRef.current) { returnFromSource(); return; }
      if (captureRef.current) { finishCapture(null); return; }
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
    if (previewRef.current || captureRef.current) return;
    if ((location.reader_mode ?? 'pdf') !== (currentPositionRef.current?.reader_mode ?? 'pdf')) return;
    currentPositionRef.current = location;
    commitHistory(updateCurrent(historyRef.current, location));
    papersRef.current = papersRef.current.map((paper) => paper.paper_id === location.paper_id ? { ...paper, last_location: location } : paper);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPosition, 600);
  }, [commitHistory, flushPosition]);

  const handleSelection = useCallback((next: SelectionContext | null) => {
    // A sidebar focus change collapses native selection; retain the captured PDF anchor.
    if (previewRef.current || !next || !next.selected_text.trim() || !next.page_anchors.length) return;
    if (captureRef.current) { setCandidate(next); return; }
    if (selectionRef.current && selectionKey(next) === selectionKey(selectionRef.current)) return;
    selectionRef.current = next;
    setSelection(next);
    setQuestion('');
    setNoteDraft('');
    setAiScreen('question');
    setInspectorTab('notes');
  }, []);

  function clearSelection(keepQuestion = false) {
    selectionRef.current = null;
    setSelection(null);
    if (!keepQuestion) setQuestion('');
    setNoteDraft('');
  }

  function toggleReadingControls() {
    if (previewRef.current || captureRef.current || modalOpen || phoneAi.open || aiTransition) return;
    if (controlsVisible) hideReadingControls(isDesktop);
    else setControlsVisible(true);
  }

  function toggleInspector() {
    if (!inspectorOpen && annotations.length) setInspectorTab('notes');
    setInspectorOpen((value) => !value);
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
    previewRef.current = null; setSourcePreview(null);
    captureRef.current = null; setPassageCapture(null); setCandidate(null);
    referenceEpochRef.current += 1;
    setSelectedReference(null);
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
    previewRef.current = null; setSourcePreview(null); setAiScreen('question'); setConversationId(null); setSelectedTurn(undefined); setReopenedNote(null);
    captureRef.current = null; setPassageCapture(null); setCandidate(null);
    referenceEpochRef.current += 1;
    setSelectedReference(null);
    setReferenceStatus('loading');
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

  async function lookupPaper(input: string, source: PaperLinkSource | null = null) {
    if (!isNative || !input.trim()) return;
    stopOpening();
    lookupSourceRef.current = source;
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: createId(), label: input.trim(), kind: 'lookup' };
    openingRef.current = operation;
    setOpening(operation);
    setLookupError(null);
    setDownloadError(null);
    setNotice(null);
    try {
      const result = await previewArxivPaper(input.trim(), operation.request_id);
      if (sequence !== openSequenceRef.current || !mountedRef.current) return;
      if (result.library_paper) {
        await openPaper(result.library_paper.arxiv_id, result.library_paper, source);
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
    const source = lookupSourceRef.current;
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: createId(), label: captured.metadata.title, kind: 'download' };
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
      await openPaper(paper.arxiv_id, paper, source);
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

  async function openPaper(input: string, cachedPaper?: Paper, source: PaperLinkSource | null = null) {
    if (!cachedPaper) { await lookupPaper(input, source); return; }
    if (!isNative || removedPapersRef.current.has(cachedPaper.paper_id)) return;
    if (activeRef.current?.paper.paper_id === cachedPaper.paper_id) return;
    stopOpening();
    rememberSession();
    flushPosition();
    const sequence = ++openSequenceRef.current;
    const operation: OpenOperation = { request_id: createId(), label: cachedPaper.title, kind: 'open' };
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
      const saved_location = initialLocation(paper);
      const location = locationInReaderMode(saved_location, source?.reader_mode);
      let nextHistory = supportsTabs ? session?.history ?? createHistory(location) : pushLocation(historyRef.current, location);
      if (supportsTabs && session && location !== saved_location) nextHistory = pushLocation(nextHistory, location);
      applyDocument({ paper, pdf_data: pdfData, initial_fit_width: !last_location }, notes, nextHistory, location, session);
      sessionsRef.current.set(paper.paper_id, {
        paper, location, history: nextHistory, selection: session?.selection ?? null,
        question: session?.question ?? '', note_draft: session?.note_draft ?? '', composer_kind: session?.composer_kind ?? 'ai',
        inspector_tab: session?.inspector_tab ?? 'references', edit_id: session?.edit_id ?? null, edit_draft: session?.edit_draft ?? '',
        source_paper_id: source?.paper_id ?? session?.source_paper_id ?? null,
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
      hideReadingControls(isDesktop);
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
    const operation: OpenOperation = { request_id: createId(), label: paper.title, kind: 'open' };
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

  function handleEdgeNavigation(paper_id: string, action: 'back' | 'close' | null) {
    // A released gesture belongs to the paper and action shown when it started.
    // Recheck live state because a tab, dialog, or asynchronous load may have
    // changed while the user's finger was still down.
    if (!mountedRef.current || !action || edgeNavigation !== action
      || activeRef.current?.paper.paper_id !== paper_id
      || openingRef.current || annotationMutationRef.current) return;
    if (document.activeElement?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const currentAction = canGoBack(historyRef.current) ? 'back' : 'close';
    if (action !== currentAction) return;
    if (action === 'back') void navigateHistory('back');
    else closePaper(paper_id);
  }

  function jumpTo(location: ReadingLocation, anchor: PageAnchor | null = null) {
    if (activeRef.current?.paper.paper_id !== location.paper_id) return;
    stopOpening();
    hideReadingControls(isDesktop);
    flushPosition();
    commitHistory(pushLocation(historyRef.current, location));
    currentPositionRef.current = location;
    setTargetLocation(location);
    setTargetAnchor(anchor);
    setNavigationKey((value) => value + 1);
  }

  function currentLinkSource(): PaperLinkSource | null {
    const location = currentPositionRef.current;
    return location ? { paper_id: location.paper_id, reader_mode: location.reader_mode ?? 'pdf' } : null;
  }

  async function followPaper(arxiv_id: string) {
    const source = currentLinkSource();
    setSelectedReference(null);
    const cached = findLibraryPaper(papersRef.current, arxiv_id);
    await openPaper(arxiv_id, cached, source);
  }

  function requestExternalLink(url: string) {
    // A later link action supersedes a cached-paper load still in flight.
    // Its completion must not replace the paper behind this confirmation.
    stopOpening();
    externalLink.requestOpen(url);
  }

  function handleNavigate(target: ReaderTarget) {
    if (previewRef.current) return;
    if (captureRef.current) {
      if (target.kind === 'pdf' && target.location.paper_id === captureRef.current.location.paper_id) {
        setTargetLocation(target.location); setTargetAnchor(null); setNavigationKey(value => value + 1);
      }
      return;
    }
    if (target.kind === 'pdf') jumpTo(target.location);
    else if (target.kind === 'reference') {
      stopOpening();
      setSelectedReference(target.reference);
    }
    else if (target.kind === 'app') void followPaper(target.arxiv_id);
    else requestExternalLink(target.url);
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

  async function openAi(id?: string, turnId?: string) {
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
        if (id) {
          setAiScreen('conversation'); setConversationId(id); setSelectedTurn(turnId); setConversationVisit(v => v + 1);
          if (aiConversations.conversations.find((view) => view.conversation.conversation_id === id)?.collapsed) aiConversations.toggleCollapsed(id);
        }
      });
      if (id) revealConversation(id, paperId);
    } catch (cause) {
      if (mountedRef.current && sequence === aiEntrySequenceRef.current) {
        setNotice({ tone: 'error', message: `Could not open AI: ${String(cause)}` });
      }
    } finally {
      if (mountedRef.current && sequence === aiEntrySequenceRef.current) setAiEntryPending(false);
    }
  }

  async function submitSelection() {
    const paper = activeRef.current?.paper;
    const capturedSelection = selectionRef.current;
    if (!paper || annotationMutationRef.current) return;
    if (composingAi || (!requiresPhoneAi && !capturedSelection)) {
      if (!question.trim()) return;
      const draftKey = `new:${paper.paper_id}:${paper.pdf_hash}`;
      const conversationId = aiConversations.ask(paper, capturedSelection, question, attachments[draftKey]);
      if (!conversationId) return;
      setAttachments(previous => ({ ...previous, [draftKey]: [] }));
      setConversationId(conversationId); setAiScreen('conversation'); setSelectedTurn(undefined);
      setQuestion('');
      askInputRef.current?.blur();
      revealConversation(conversationId, paper.paper_id);
      return;
    }
    if (!capturedSelection || !noteDraft.trim()) return;
    const capturedKey = selectionKey(capturedSelection);
    const now = new Date().toISOString();
    const annotation: Annotation = {
      schema_version: 1,
      annotation_id: createId(),
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
    annotationMutationRef.current = annotation.annotation_id;
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
      annotationMutationRef.current = null;
      if (mountedRef.current) setAnnotationBusy(null);
    }
  }

  function annotationBelongsToReader(annotation: Annotation): boolean {
    const paper = activeRef.current?.paper;
    return paper?.paper_id === annotation.target.paper_id && paper.pdf_hash === annotation.target.pdf_hash;
  }

  function editAnnotation(annotation: Annotation, content: string | null) {
    if (!mountedRef.current || !annotationBelongsToReader(annotation)) return;
    if (content === null) setEditId((id) => id === annotation.annotation_id ? null : id);
    else {
      setEditId(annotation.annotation_id);
      setEditDraft(content);
    }
  }

  function clearAnnotationDraft(annotation: Annotation) {
    const session = sessionsRef.current.get(annotation.target.paper_id);
    if (session?.edit_id === annotation.annotation_id) {
      session.edit_id = null;
      session.edit_draft = '';
    }
    editAnnotation(annotation, null);
  }

  async function removeAnnotation(annotation: Annotation): Promise<boolean> {
    if (annotationMutationRef.current || !annotationBelongsToReader(annotation)) return false;
    annotationMutationRef.current = annotation.annotation_id;
    setAnnotationBusy(annotation.annotation_id);
    try {
      await deleteAnnotation(annotation.annotation_id);
      if (annotation.body.kind === 'note' && annotation.body.origin) void aiConversations.reload();
      annotationChangesRef.current.set(annotation.annotation_id, { paper_id: annotation.target.paper_id, pdf_hash: annotation.target.pdf_hash, annotation: null });
      if (mountedRef.current && annotationBelongsToReader(annotation)) setAnnotations((existing) => existing.filter((item) => item.annotation_id !== annotation.annotation_id));
      clearAnnotationDraft(annotation);
      return true;
    } catch (cause) {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not delete this annotation: ${String(cause)}` });
      return false;
    } finally {
      annotationMutationRef.current = null;
      if (mountedRef.current) setAnnotationBusy(null);
    }
  }

  async function updateAnnotation(annotation: Annotation, content: string): Promise<boolean> {
    if (!content.trim() || annotationMutationRef.current || !annotationBelongsToReader(annotation)) return false;
    annotationMutationRef.current = annotation.annotation_id;
    setAnnotationBusy(annotation.annotation_id);
    try {
      const updated = await saveAnnotation({
        ...annotation,
        body: annotation.body.kind === 'note' ? { ...annotation.body, content: content.trim() } : { ...annotation.body, note_content: content.trim() },
        updated_at: new Date().toISOString(),
      });
      storeAnnotation(updated);
      if (updated.body.kind === 'note' && updated.body.origin) void aiConversations.reload();
      clearAnnotationDraft(annotation);
      return true;
    } catch (cause) {
      if (mountedRef.current) setNotice({ tone: 'error', message: `Could not update this annotation: ${String(cause)}` });
      return false;
    } finally {
      annotationMutationRef.current = null;
      if (mountedRef.current) setAnnotationBusy(null);
    }
  }

  function jumpToAnnotation(annotation: Annotation, source_anchor?: PageAnchor) {
    const location = currentLocation(historyRef.current);
    const anchor = source_anchor ?? annotation.target.page_anchors[0];
    if (!location || !anchor || !annotationBelongsToReader(annotation)) return;
    jumpTo({ ...location, page_number: anchor.page_number, page_position: [0, 0], reading_block_id: null }, anchor);
  }

  function readCitation(citation: AiCitation, from: SourcePreview['from'], conversation_id?: string, annotation_id?: string) {
    const location = currentPositionRef.current;
    if (!location || !activeRef.current || previewRef.current) return;
    const preview = { citation, from, conversation_id, annotation_id, location,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    previewRef.current = preview;
    setSourcePreview(preview);
    setTargetLocation({ ...location, page_number: citation.anchor.page_number, page_position: [0, 0], reader_mode: 'pdf', reading_block_id: null });
    setTargetAnchor(citation.anchor);
    setNavigationKey(value => value + 1);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.citation-preview-bar button')?.focus({ preventScroll: true }));
  }

  function readNoteCitation(annotation: Annotation, citation: AiCitation) {
    if (annotationBelongsToReader(annotation)) readCitation(citation, 'saved note', undefined, annotation.annotation_id);
  }

  function beginCapture(draft_key: string) {
    const location = currentPositionRef.current;
    if (!location || previewRef.current || captureRef.current) return;
    const capture = { draft_key, location, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    captureRef.current = capture;
    setCandidate(null); setPassageCapture(capture);
    if (location.reader_mode === 'reading') {
      setTargetLocation({ ...location, reader_mode: 'pdf', reading_block_id: null });
      setTargetAnchor(null); setNavigationKey(value => value + 1);
    }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.passage-capture-bar button')?.focus({ preventScroll: true }));
  }

  function finishCapture(selected: SelectionContext | null) {
    const capture = captureRef.current, paper = activeRef.current?.paper;
    if (!capture || !paper || paper.paper_id !== capture.location.paper_id) return;
    if (selected) {
      const passage: AiPassage = { ...selected, paper_id: paper.paper_id, pdf_hash: paper.pdf_hash };
      const alreadySource = capture.draft_key.startsWith('new:') && selectionRef.current && selectionKey(selectionRef.current) === selectionKey(selected);
      if (!alreadySource) setAttachments(previous => {
        const attached = previous[capture.draft_key] ?? [];
        return attached.some(p => selectionKey(p) === selectionKey(selected)) ? previous : { ...previous, [capture.draft_key]: [...attached, passage] };
      });
    }
    captureRef.current = null; setPassageCapture(null); setCandidate(null);
    setTargetLocation(capture.location); setTargetAnchor(null); setNavigationKey(value => value + 1);
    requestAnimationFrame(() => { if (capture.trigger?.isConnected) capture.trigger.focus({ preventScroll: true }); });
  }

  function openNoteOrigin(annotation: Annotation) {
    const origin = annotation.body.kind === 'note' && annotation.body.origin;
    if (!origin || !annotationBelongsToReader(annotation)) return;
    if (!aiConversations.conversations.some(v => v.conversation.conversation_id === origin.conversation_id &&
        v.conversation.turns.some(t => t.turn_id === origin.turn_id))) {
      setNotice({ tone: 'info', message: 'The originating conversation is unavailable on this device.' }); return;
    }
    void openAi(origin.conversation_id, origin.turn_id);
  }

  function returnFromSource(attach = false) {
    const preview = previewRef.current;
    const paper = activeRef.current?.paper;
    if (!preview || !paper || paper.paper_id !== preview.location.paper_id) return;
    if (attach && preview.conversation_id) {
      const id = preview.conversation_id, anchor = preview.citation.anchor;
      const passage: AiPassage = { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, page_anchors: [anchor],
        selected_text: anchor.text_quote.exact_text, context_text: '' };
      setAttachments(previous => ({ ...previous, [id]: [...(previous[id] ?? []).filter(p => selectionKey(p) !== selectionKey(passage)), passage] }));
    }
    if (preview.from === 'saved note' && !inspectorOpen && preview.annotation_id) {
      setInspectorTab('notes'); setInspectorOpen(true); setReopenedNote(preview.annotation_id);
    }
    previewRef.current = null;
    setSourcePreview(null);
    setTargetLocation(preview.location);
    setTargetAnchor(null);
    setNavigationKey(value => value + 1);
    requestAnimationFrame(() => {
      if (attach && preview.conversation_id) document.getElementById(`conversation-question-${preview.conversation_id}`)?.focus();
      else if (preview.trigger?.isConnected) preview.trigger.focus({ preventScroll: true });
    });
  }

  async function exportAnnotations() {
    if (!active || exporting) return;
    setExporting(true);
    try {
      const fileName = `${active.paper.arxiv_id.replace('/', '-')}-v${active.paper.arxiv_version}.doi.json`;
      const path = await saveAnnotationFile(fileName, serializeAnnotations(active.paper, annotations));
      if (path) setNotice({ tone: 'success', message: `Annotations exported to ${path}. The original PDF is unchanged.` });
    } catch (cause) {
      setNotice({ tone: 'error', message: `Could not export annotations: ${String(cause)}` });
    } finally {
      setExporting(false);
    }
  }

  async function importAnnotations(file: File) {
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
    const epoch = referenceEpochRef.current;
    setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: true, candidates: [], error: null } }));
    try {
      const key = reference.citation_text;
      let lookup = referenceLookupsRef.current.get(key);
      if (!lookup) {
        lookup = resolveReference(key).catch((cause: unknown) => {
          referenceLookupsRef.current.delete(key);
          throw cause;
        });
        // Bound successful/pending lookups for this workspace session.
        if (referenceLookupsRef.current.size >= 100) referenceLookupsRef.current.delete(referenceLookupsRef.current.keys().next().value!);
        referenceLookupsRef.current.set(key, lookup);
      }
      const candidates = await lookup;
      if (!mountedRef.current || referenceEpochRef.current !== epoch) return;
      setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: false, candidates, error: null } }));
    } catch (cause) {
      if (!mountedRef.current || referenceEpochRef.current !== epoch) return;
      setResolutions((existing) => ({ ...existing, [reference.reference_id]: { busy: false, candidates: [], error: String(cause) } }));
    }
  }

  function openReference(reference: ReferenceItem | ReferenceCandidate) {
    const target = referenceLinkTarget(reference);
    if (target) handleNavigate(target);
  }

  function showReferenceSource(reference: ReferenceItem) {
    const location = currentPositionRef.current;
    if (!location) return;
    setSelectedReference(null);
    const rect = reference.source_rect;
    const anchor: PageAnchor | null = rect ? {
      page_number: reference.page_number,
      quad_points: [[rect[0], rect[3], rect[2], rect[3], rect[2], rect[1], rect[0], rect[1]]],
      text_quote: { exact_text: reference.citation_text, prefix: '', suffix: '', normalization_version: 1 },
    } : null;
    jumpTo({ ...location, page_number: reference.page_number, page_position: [0, 0], reading_block_id: null }, anchor);
  }

  async function retryLibrary() {
    setLibraryLoading(true);
    setLibraryError(null);
    try { storePapers(await listPapers()); }
    catch (cause) { setLibraryError(String(cause)); }
    finally { setLibraryLoading(false); }
  }

  const current = currentLocation(history);
  const newDraftKey = active ? `new:${active.paper.paper_id}:${active.paper.pdf_hash}` : '';
  const pendingAnnotation = Boolean(annotationBusy);
  const sourcePaperId = active ? sessionsRef.current.get(active.paper.paper_id)?.source_paper_id : null;
  const sourcePaper = sourcePaperId ? papers.find((paper) => paper.paper_id === sourcePaperId) : undefined;
  const operationMessage = cooldownMessage(progress, Boolean(opening))
    ?? progress?.message ?? (opening?.kind === 'lookup' ? 'Looking up the paper on arXiv…' : opening?.kind === 'download' ? 'Downloading the original PDF…' : `Opening ${opening?.label ?? 'paper'}…`);

  const annotationEdit = useMemo(() => editId ? { annotation_id: editId, content: editDraft } : null, [editId, editDraft]);
  const reader = useMemo(() => active ? <PdfReader paper={active.paper} pdf_data={active.pdf_data}
    annotations={annotations} inline_notes={!isDesktop} annotation_busy={annotationBusy} annotation_edit={annotationEdit}
    on_edit_annotation={(annotation, content) => readerActionsRef.current.editAnnotation(annotation, content)}
    on_update_annotation={(annotation, content) => readerActionsRef.current.updateAnnotation(annotation, content)}
    on_delete_annotation={(annotation) => readerActionsRef.current.removeAnnotation(annotation)}
    on_navigate_annotation={(annotation, anchor) => readerActionsRef.current.jumpToAnnotation(annotation, anchor)}
    on_navigate_ai_citation={(annotation, citation) => readerActionsRef.current.readNoteCitation(annotation, citation)}
    on_open_ai_origin={annotation => readerActionsRef.current.openNoteOrigin(annotation)} cited_anchor={sourcePreview?.citation.anchor}
    target_location={targetLocation} target_anchor={targetAnchor} navigation_key={navigationKey}
    edge_navigation={edgeNavigation}
    on_edge_navigation={() => readerActionsRef.current.handleEdgeNavigation(active.paper.paper_id, edgeNavigation)}
    controls_visible={Boolean(passageCapture) || (controlsVisible && !inspectorBlocksReader && !sourcePreview)} on_toggle_controls={() => readerActionsRef.current.toggleReadingControls()}
    viewport_key={viewportKey} initial_fit_width={active.initial_fit_width} reading_active={!modalOpen && !inspectorBlocksReader && !aiTransition}
    on_location_change={handleLocationChange} on_navigate={(target) => readerActionsRef.current.handleNavigate(target)} on_selection={handleSelection}
    on_references={(items, status = 'ready') => { if (activeRef.current?.paper.paper_id === active.paper.paper_id) { setReferences(items); setReferenceStatus(status); } }}
    on_error={(message) => setNotice({ tone: 'error', message })} /> : null,
  [active, annotations, annotationBusy, annotationEdit, isDesktop, targetLocation, targetAnchor, navigationKey, controlsVisible,
    inspectorBlocksReader, sourcePreview, passageCapture, viewportKey, modalOpen, aiTransition, edgeNavigation, handleLocationChange, handleSelection]);

  return (
    <div className={`app-shell library-workspace ${active ? 'reading-mode' : 'library-home-mode'} ${supportsTabs && tabIds.length ? 'has-paper-tabs' : ''} ${phoneAi.open ? 'phone-ai-open' : ''} ${isDesktop ? 'desktop-reader' : ''} ${isDesktop && inspectorOpen ? 'desktop-inspector-open' : ''}`}>
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
        {active && controlsVisible && !paperInFront && !phoneAi.open && <ReaderOverlay paper={active.paper} can_go_back={canGoBack(history)} can_go_forward={canGoForward(history)} busy={Boolean(opening) || aiTransition} inspector_open={inspectorOpen} supports_orientation={readerCapabilities.supports_orientation} orientation={readerOrientation} orientation_pending={orientationPending || aiTransition} library_button_ref={libraryButtonRef} on_back={() => { void navigateHistory('back'); }} on_forward={() => { void navigateHistory('forward'); }} on_library={showHome} on_info={showPaperInfo} on_inspector={toggleInspector} on_settings={showSettings} on_ask={!isPhone ? () => { setAiScreen('question'); void openAi(); } : undefined} on_direction={() => { void changeReaderDirection(); }} on_close={() => closePaper(active.paper.paper_id)} source_title={supportsTabs ? sourcePaper?.title : undefined} on_source={supportsTabs && sourcePaper ? () => { void openPaper(sourcePaper.arxiv_id, sourcePaper); } : undefined} reader_mode={current?.reader_mode ?? 'pdf'} on_mode={() => {
          const source = currentPositionRef.current ?? current;
          if (source) jumpTo({ ...source, reader_mode: source.reader_mode === 'reading' ? 'pdf' : 'reading', reading_block_id: null, zoom: 1, zoom_mode: 'fit_width' });
        }} />}

        {active && opening?.kind === 'open' && <div className="operation-banner" role="status"><LoaderCircle size={15} className="spin" /><span>{operationMessage}</span></div>}
        {notice && <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <Check size={15} /> : notice.tone === 'error' ? <CircleHelp size={15} /> : <CircleHelp size={15} />}<span>{notice.message}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={14} /></button></div>}

        {aiTransition && !phoneAi.open && <div className="phone-ai-transition" role="status"><LoaderCircle size={20} className="spin" /><span>Changing viewing direction…</span><button type="button" className="text-button" onClick={() => hideReadingControls()}>Back to paper</button></div>}
        {!isPhone && <FloatingSelectionAction controls_visible={controlsVisible} visible={Boolean(active && selection && !paperInFront && !inspectorBlocksReader && !modalOpen && !aiTransition && !orientationPending)} on_activate={() => { void openAi(); }} />}
        {active && isPhone && !paperInFront && !inspectorOpen && !modalOpen && !aiTransition && !orientationPending &&
          <div className="reader-ask-dock"><button type="button" className="button button-primary" aria-label={selection ? 'Ask AI or add a note to this passage' : 'Ask about paper'}
            onClick={() => { void openAi(); }}><Sparkles size={17} />{selection ? 'Ask about passage' : 'Ask AI'}</button></div>}
        {passageCapture && <section className="citation-preview-bar passage-capture-bar" aria-label="Attach a passage">
          {candidate ? <details><summary>Selected passage · p. {candidate.page_anchors[0].page_number}</summary><blockquote>{candidate.selected_text}</blockquote></details> :
            <p role="status">Select text in the PDF to attach it to your question.</p>}
          <div className="citation-preview-actions"><button type="button" className="button button-subtle" onClick={() => finishCapture(null)}>Cancel</button>
            <button type="button" className="button button-primary" disabled={!candidate} onClick={() => finishCapture(candidate)}>Attach passage</button></div>
        </section>}
        {sourcePreview && <section className="citation-preview-bar" aria-label="Cited passage">
          <details><summary><BookOpen size={16} /> {sourcePreview.citation.citation_id} · p. {sourcePreview.citation.anchor.page_number}</summary>
            <blockquote>{sourcePreview.citation.anchor.text_quote.exact_text}</blockquote></details>
          <div className="citation-preview-actions"><button type="button" className="button button-primary" onClick={() => returnFromSource()}><ArrowLeft size={16} /> Back to {sourcePreview.from}</button>
            {sourcePreview.from === 'answer' && <button type="button" className="button button-subtle" onClick={() => returnFromSource(true)}>Ask about this</button>}</div>
        </section>}

        {active && <div className={`reading-grid ${inspectorOpen && !paperInFront ? 'with-inspector' : ''}`}>
          <section className={`reading-surface ${active ? 'has-paper' : ''}`} aria-label="Paper reader">
            <div className="pdf-reader-mount" inert={inspectorBlocksReader || aiTransition}>{reader}</div>
          </section>

          {inspectorOpen && <aside hidden={paperInFront} ref={aiDialogRef} id="paper-inspector" className={`inspector ${phoneAi.open ? 'phone-ai-screen' : ''}`} role={phoneAi.open ? 'dialog' : undefined} aria-modal={phoneAi.open ? true : undefined} aria-label={phoneAi.open ? 'Ask AI' : 'References and annotations'}>
            {phoneAi.open ? <header className="phone-ai-header"><button type="button" className="text-button" onClick={() => hideReadingControls()}><ArrowLeft size={18} /> Back to paper</button><div><strong>Ask AI</strong><span>{active?.paper.title}</span></div><button type="button" className="icon-button" aria-label="Conversations" onClick={() => setAiScreen('list')}><MessageSquare size={18} /></button><button type="button" className="icon-button" aria-label="AI provider settings" onClick={showSettings}><Settings2 size={18} /></button></header> : <div className="inspector-heading"><div className="inspector-tabs" role="tablist" aria-label="Paper details">
              <button type="button" role="tab" id="references-tab" aria-controls="references-panel" aria-selected={inspectorTab === 'references'} className={inspectorTab === 'references' ? 'is-active' : ''} onClick={() => setInspectorTab('references')}><Link2 size={15} /> References {references.length > 0 && <span>{references.length}</span>}</button>
              <button type="button" role="tab" id="notes-tab" aria-controls="notes-panel" aria-selected={inspectorTab === 'notes'} className={inspectorTab === 'notes' ? 'is-active' : ''} onClick={() => setInspectorTab('notes')}><StickyNote size={15} /> Notes {annotations.length > 0 && <span>{annotations.length}</span>}</button>
            </div>{isDesktop && <button type="button" className="icon-button inspector-close" aria-label="Close notes sidebar" onClick={() => {
              setInspectorOpen(false);
              requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Scrollable PDF pages"], [aria-label="Scrollable reading view"]')?.focus({ preventScroll: true }));
            }}><X size={18} /></button>}</div>}
            {inspectorTab === 'references' ? <div id="references-panel" role="tabpanel" aria-labelledby="references-tab" className="inspector-content">
              <div className="inspector-intro"><h2>Follow the thread.</h2><p>Every paper is part of a bigger conversation.</p></div>
              {references.length ? <><div className="list-eyebrow">CITATIONS & LINKS <span>{references.length}</span></div>
                <div className="reference-list">{references.map((reference) => <ReferenceCard key={reference.reference_id}
                  reference={reference} resolution={resolutions[reference.reference_id]} busy={Boolean(opening)}
                  on_open={openReference} on_find={(item) => { void findReference(item); }} on_source={showReferenceSource} />)}</div>
              </> : <div className="inspector-empty"><span className="empty-symbol"><Link2 size={24} strokeWidth={1.4} /></span>
                <h3>{referenceStatus === 'loading' ? 'Finding references…' : referenceStatus === 'error' ? 'References unavailable' : 'No bibliography detected'}</h3>
                <p>{referenceStatus === 'loading' ? 'Reading the bibliography on this device.' : 'You can still follow embedded links directly in the PDF.'}</p>
              </div>}
            </div> : <div id="notes-panel" ref={notesPanelRef} role={phoneAi.open ? undefined : 'tabpanel'} aria-labelledby={phoneAi.open ? undefined : 'notes-tab'} className="inspector-content notes-content">
              {(!phoneAi.open || aiScreen === 'question') && <PaperQuestionComposer selection={selection} phone={phoneAi.open}
                attachments={attachments[newDraftKey] ?? []} on_attach={p => setAttachments(previous => ({ ...previous, [newDraftKey]: p }))}
                on_pick={() => beginCapture(newDraftKey)}
                composing_ai={composingAi || (!requiresPhoneAi && !selection)} busy={pendingAnnotation} settings={settings} input_ref={askInputRef}
                question={question} note={noteDraft} on_question={setQuestion} on_note={setNoteDraft} on_submit={submitSelection}
                on_clear={() => clearSelection(composingAi)} on_manual={() => setComposerKind('note')} on_settings={showSettings}
                on_ai={() => { if (requiresPhoneAi && !phoneAi.open) void openAi(); else { setComposerKind('ai'); askInputRef.current?.focus(); } }} />}
              {phoneAi.open && aiScreen === 'list' && <div className="ai-thread-list-heading"><h2>Conversations</h2>
                <button type="button" className="button button-subtle" onClick={() => { setAiScreen('question'); setQuestion(''); }}><Plus size={15} /> New conversation</button>
              </div>}
              {!phoneAi.open && <SavedNotes key={active.paper.paper_id} annotations={annotations}
                busy_annotation_id={annotationBusy} edit={annotationEdit} importing={importing} exporting={exporting}
                on_edit={editAnnotation} on_update={updateAnnotation} on_delete={removeAnnotation} on_navigate={jumpToAnnotation}
                on_read_citation={readNoteCitation} on_open_origin={openNoteOrigin} reopened_id={reopenedNote}
                on_import={(file) => { void importAnnotations(file); }} on_export={() => { void exportAnnotations(); }} />}
              {aiConversations.loading && <p className="field-hint" role="status">Loading conversations…</p>}
              {aiConversations.load_error && <div className="inline-error" role="alert"><p>{aiConversations.load_error}</p><button type="button" className="text-button" onClick={() => { void aiConversations.reload(); }}>Retry conversations</button></div>}
              {aiConversations.conversations.length > 0 && <div className="ai-conversation-list">{aiConversations.conversations.map((view) => {
                const id = view.conversation.conversation_id;
                if (phoneAi.open && (aiScreen === 'question' || (aiScreen === 'conversation' && id !== conversationId))) return null;
                if ((requiresPhoneAi && !phoneAi.open) || (phoneAi.open && aiScreen === 'list')) return <button type="button" className="phone-conversation-preview" key={id} onClick={() => { void openAi(id); }}>
                  <MessageSquare size={17} /><span><strong>{view.conversation.turns[0]?.question || 'AI conversation'}</strong><small>{view.conversation.turns.length} {view.conversation.turns.length === 1 ? 'question' : 'questions'} · Open conversation</small></span><ChevronRight size={16} />
                </button>;
                const revision = { paper_id: active.paper.paper_id, pdf_hash: active.paper.pdf_hash };
                const options: AiPassage[] = selection ? [{ ...revision, ...selection }] : [];
                const recent = view.conversation.turns.find(t => t.turn_id === selectedTurn) ?? view.conversation.turns.at(-1);
                if (recent) {
                  options.push(...recent.attachments ?? []);
                  for (const citation of recent.citations ?? []) options.push({ ...revision, page_anchors: [citation.anchor], selected_text: citation.anchor.text_quote.exact_text, context_text: '' });
                }
                return <AiConversationCard key={conversationId === id ? `${id}:${conversationVisit}` : id} view={view} focused={phoneAi.open || (conversationId === id && !!selectedTurn)}
                  selected_turn_id={conversationId === id ? selectedTurn : undefined} on_select_turn={turn => { setConversationId(id); setSelectedTurn(turn); }}
                  passage_options={options} attachments={attachments[id] ?? []} on_attach={passages => setAttachments(previous => ({ ...previous, [id]: passages }))}
                  on_pick={() => beginCapture(id)}
                  turn_actions={{
                    on_read: (citation, from) => readCitation(citation, from, id),
                    on_edit: (turn, note) => aiConversations.editTurnNote(id, turn, note),
                    on_pin: async (turn, content, target) => {
                      const saved = await aiConversations.pinTurn(id, turn, content, target);
                      if (saved && annotationBelongsToReader(saved)) {
                        setNotice({ tone: 'success', message: saved.target.scope === 'paper' ? 'Note pinned to this paper.' : 'Note pinned to the passage.' });
                        if (phoneAi.open && aiDialogRef.current?.isConnected) {
                          if (saved.target.scope === 'paper') {
                            hideReadingControls(); setReopenedNote(saved.annotation_id); setInspectorTab('notes'); setInspectorOpen(true);
                          } else jumpToAnnotation(saved);
                        }
                      }
                      return saved;
                    },
                  }}
                  follow_up_question={followUpDrafts[id] ?? ''}
                  on_follow_up_question_change={(value) => setFollowUpDrafts((drafts) => ({ ...drafts, [id]: value }))}
                  on_follow_up={question => {
                    if (!aiConversations.followUp(id, question, attachments[id])) return false;
                    setAttachments(previous => ({ ...previous, [id]: [] })); return true;
                  }}
                  on_generate_note={() => { void aiConversations.generateNote(id); }}
                  on_stop={() => aiConversations.stop(id)}
                  on_edit_note={(content) => aiConversations.editNote(id, content)}
                  on_retry_note_persistence={() => { void aiConversations.retryNotePersistence(id); }}
                  on_save_note={() => { void aiConversations.saveNote(id); }}
                  on_toggle_collapsed={() => aiConversations.toggleCollapsed(id)} />;
              })}</div>}

            </div>}
            {!phoneAi.open && <div className="inspector-footer"><span className="inspector-footer-mark">✳</span> A trail worth following.</div>}
          </aside>}
        </div>}
      </main>
      {selectedReference && !externalLink.request && <ReferenceDetailsDialog reference={selectedReference} resolution={resolutions[selectedReference.reference_id]}
        busy={Boolean(opening)} on_open={openReference} on_find={(item) => { void findReference(item); }}
        on_source={showReferenceSource} on_close={() => setSelectedReference(null)} />}
      {preview && <PaperPreviewDialog preview={preview} busy={opening?.kind === 'download'} message={opening?.kind === 'download' || progress?.phase === 'waiting' ? operationMessage : null} error={downloadError} on_confirm={() => { void confirmDownload(); }} on_cancel={cancelPreview} />}
      {active && opening?.kind === 'lookup' && !preview && <PaperLookupDialog label={opening.label} message={operationMessage} on_cancel={stopOpening} />}
      {removing && <RemovePaperDialog paper={removing} busy={removeBusy} error={removeError} on_confirm={() => { void confirmRemoval(); }} on_cancel={() => { if (!removeBusy) setRemoving(null); }} />}
      {paperInfoOpen && active && !externalLink.request && <PaperInfoSheet paper={active.paper} resume={Boolean(active.paper.last_location)} on_close={closePaperInfo} on_open_source={() => requestExternalLink(`https://arxiv.org/abs/${active.paper.arxiv_id}v${active.paper.arxiv_version}`)} />}
      {externalLink.request && <ExternalLinkDialog {...externalLink.request} on_confirm={() => { void externalLink.confirmOpen(); }} on_cancel={externalLink.cancel} />}
      {settingsOpen && <SettingsDialog settings={settings} on_close={closeSettings} on_saved={(saved) => { setSettings(saved); setSettingsOpen(false); setNotice({ tone: 'success', message: 'AI provider settings saved.' }); }} />}
    </div>
  );
}
