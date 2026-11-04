import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askAiConversation, cancelAiRequest, generateAiConversationNote, listAiConversations,
  onAiStream, saveAiConversationNote, updateAiConversationNote,
} from './backend';
import type { AiConversation, AiConversationRequest, AiConversationResponse, Annotation, Paper, SelectionContext } from './types';

export interface AiConversationView {
  conversation: AiConversation;
  history_persisted: boolean;
  unpersisted_turn_ids: string[];
  thinking_by_turn: Record<string, string>;
  note_thinking: string;
  status: string;
  error: string | null;
  pending: boolean;
  operation: 'answer' | 'note' | null;
  note_content: string;
  persistence_state: 'saved' | 'pending' | 'saving' | 'error';
  persistence_error: string | null;
  saving_note: boolean;
  collapsed: boolean;
}

interface RequestRuntime {
  request_id: string;
  operation: 'answer' | 'note';
  cancelled: boolean;
  invoked: boolean;
  flush: () => void;
  unlisten?: () => void;
}

interface NoteRuntime {
  note_id: string;
  content: string;
  revision: number;
  persisted_revision: number;
  timer?: ReturnType<typeof setTimeout>;
  in_flight?: Promise<boolean>;
}

function initialView(conversation: AiConversation): AiConversationView {
  return {
    conversation, history_persisted: true, unpersisted_turn_ids: [], thinking_by_turn: {}, note_thinking: '',
    status: conversation.active_request_id ? 'Request in progress…' : '', error: null,
    pending: Boolean(conversation.active_request_id), operation: conversation.active_operation,
    note_content: conversation.note_draft?.content ?? '', persistence_state: 'saved',
    persistence_error: null, saving_note: false, collapsed: false,
  };
}

// Server records survive navigation and restart. Only received thinking and
// unsent note edits stay in memory; neither is reconstructed from answer text.
export function useAiConversations(paper: Paper | null, onSaved: (annotation: Annotation) => void) {
  const [views, setViews] = useState<AiConversationView[]>([]);
  const viewsRef = useRef(views);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const versionsRef = useRef(new Map<string, number>());
  const discardedRef = useRef(new Set<string>());
  const paperGenerationsRef = useRef(new Map<string, number>());
  const requestsRef = useRef(new Map<string, RequestRuntime>());
  const remoteStopsRef = useRef(new Set<string>());
  const notesRef = useRef(new Map<string, NoteRuntime>());
  const loadSequenceRef = useRef(0);
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const flushNoteRef = useRef<(id: string) => Promise<boolean>>(async () => true);

  const change = useCallback((id: string, update: (view: AiConversationView) => AiConversationView) => {
    if (!mountedRef.current) return;
    versionsRef.current.set(id, (versionsRef.current.get(id) ?? 0) + 1);
    viewsRef.current = viewsRef.current.map((view) => view.conversation.conversation_id === id ? update(view) : view);
    setViews(viewsRef.current);
  }, []);

  const receive = useCallback((conversation: AiConversation, persisted = true) => {
    if (!mountedRef.current || discardedRef.current.has(conversation.conversation_id)) return;
    const id = conversation.conversation_id;
    const previous = viewsRef.current.find((view) => view.conversation.conversation_id === id);
    const edit = notesRef.current.get(id);
    const sameNote = edit?.note_id === conversation.note_draft?.note_id;
    const keepEdit = sameNote && edit && edit.revision > edit.persisted_revision && !conversation.note_draft?.saved_annotation_id;
    if (edit && !sameNote) {
      clearTimeout(edit.timer);
      notesRef.current.delete(id);
    }
    // A failed/stopped stream may have reached the client after the last server
    // checkpoint. Keep its partial answer visible without marking it complete.
    const runtime = requestsRef.current.get(id);
    const turns = conversation.turns.map((turn) => {
      const old = previous?.conversation.turns.find((item) => item.turn_id === turn.turn_id);
      return turn.phase === 'incomplete' && old && old.answer.length > turn.answer.length
        ? { ...turn, answer: old.answer } : turn;
    });
    const optimistic = previous?.conversation.turns.find((turn) => turn.turn_id === runtime?.request_id);
    if (runtime?.operation === 'answer' && optimistic && !turns.some((turn) => turn.turn_id === optimistic.turn_id)) turns.push(optimistic);
    const next: AiConversationView = {
      ...initialView(conversation), ...previous, conversation: { ...conversation, turns },
      history_persisted: persisted,
      unpersisted_turn_ids: turns.filter((turn) => !persisted || !conversation.turns.some((saved) => saved.turn_id === turn.turn_id)).map((turn) => turn.turn_id),
      pending: runtime ? previous?.pending ?? true : Boolean(conversation.active_request_id),
      operation: runtime ? runtime.operation : conversation.active_operation,
      note_content: keepEdit ? edit.content : conversation.note_draft?.content ?? '',
    };
    versionsRef.current.set(id, (versionsRef.current.get(id) ?? 0) + 1);
    viewsRef.current = previous
      ? viewsRef.current.map((view) => view.conversation.conversation_id === id ? next : view)
      : [next, ...viewsRef.current];
    setViews(viewsRef.current);
  }, []);

  const reload = useCallback(async () => {
    const activePaper = paperRef.current;
    const sequence = ++loadSequenceRef.current;
    if (!activePaper) {
      setLoading(false);
      setLoadError(null);
      return;
    }
    const versions = new Map(versionsRef.current);
    const generation = paperGenerationsRef.current.get(activePaper.paper_id);
    setLoading(true);
    setLoadError(null);
    try {
      const conversations = await listAiConversations(activePaper.paper_id);
      if (!mountedRef.current || sequence !== loadSequenceRef.current
        || generation !== paperGenerationsRef.current.get(activePaper.paper_id)) return;
      for (const conversation of conversations) {
        const id = conversation.conversation_id;
        // Loading a paper must never roll back a turn or edit made since its
        // snapshot request began. Mutation responses update their own records.
        if ((versionsRef.current.get(id) ?? 0) === (versions.get(id) ?? 0)) receive(conversation);
      }
    } catch (cause) {
      if (mountedRef.current && sequence === loadSequenceRef.current) setLoadError(String(cause));
    } finally {
      if (mountedRef.current && sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [receive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      for (const runtime of requestsRef.current.values()) {
        runtime.cancelled = true;
        runtime.flush();
        runtime.unlisten?.();
        runtime.unlisten = undefined;
        if (runtime.invoked) void cancelAiRequest(runtime.request_id).catch(() => {});
      }
      for (const view of viewsRef.current) {
        if (view.pending && view.conversation.active_request_id && !requestsRef.current.has(view.conversation.conversation_id)) {
          void cancelAiRequest(view.conversation.active_request_id).catch(() => {});
        }
      }
      requestsRef.current.clear();
      for (const [id, edit] of notesRef.current) {
        clearTimeout(edit.timer);
        // Finish queued edits even if the workspace is being remounted. The
        // request contains no model input and does not create an annotation.
        void flushNoteRef.current(id);
      }
    };
  }, []);

  useEffect(() => { void reload(); }, [paper?.paper_id, paper?.pdf_hash, reload]);

  const flushNote = useCallback(async (id: string): Promise<boolean> => {
    const edit = notesRef.current.get(id);
    if (!edit) return true;
    clearTimeout(edit.timer);
    edit.timer = undefined;
    if (edit.in_flight) return edit.in_flight;
    if (edit.persisted_revision === edit.revision) return true;
    const work = async () => {
      while (!discardedRef.current.has(id) && edit.persisted_revision < edit.revision) {
        const revision = edit.revision;
        const content = edit.content;
        change(id, (view) => ({ ...view, persistence_state: 'saving', persistence_error: null }));
        try {
          const conversation = await updateAiConversationNote(id, edit.note_id, content);
          edit.persisted_revision = revision;
          receive(conversation);
        } catch (cause) {
          change(id, (view) => ({
            ...view, persistence_state: 'error',
            persistence_error: `Your edit is still here, but could not be stored: ${String(cause)}`,
          }));
          return false;
        }
      }
      change(id, (view) => ({ ...view, persistence_state: 'saved', persistence_error: null }));
      return true;
    };
    edit.in_flight = work().finally(() => { edit.in_flight = undefined; });
    return edit.in_flight;
  }, [change, receive]);
  flushNoteRef.current = flushNote;

  const recover = useCallback(async (id: string, requestId: string) => {
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id);
    if (!view) return;
    try {
      const saved = await listAiConversations(view.conversation.target.paper_id);
      if (!mountedRef.current || requestsRef.current.get(id)?.request_id !== requestId) return;
      const conversation = saved.find((item) => item.conversation_id === id);
      if (conversation) receive(conversation);
    } catch (cause) {
      change(id, (current) => ({ ...current, error: `${current.error ?? 'Request interrupted.'} Could not refresh saved history: ${String(cause)}` }));
    }
  }, [change, receive]);

  const run = useCallback(async (
    id: string, requestId: string, operation: 'answer' | 'note',
    invoke: () => Promise<AiConversationResponse>,
  ) => {
    let thinking = '';
    let answer = '';
    let status: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!thinking && !answer && status === null) return;
      change(id, (view) => ({
        ...view, status: status ?? view.status,
        thinking_by_turn: operation === 'answer'
          ? { ...view.thinking_by_turn, [requestId]: (view.thinking_by_turn[requestId] ?? '') + thinking }
          : view.thinking_by_turn,
        note_thinking: operation === 'note' ? view.note_thinking + thinking : view.note_thinking,
        conversation: operation === 'answer' ? {
          ...view.conversation,
          turns: view.conversation.turns.map((turn) => turn.turn_id === requestId ? { ...turn, answer: turn.answer + answer } : turn),
        } : view.conversation,
      }));
      thinking = '';
      answer = '';
      status = null;
    };
    const runtime: RequestRuntime = { request_id: requestId, operation, cancelled: false, invoked: false, flush };
    requestsRef.current.set(id, runtime);
    try {
      if (!await flushNote(id)) throw new Error('Store your note edits before continuing. Retry storing the draft or save the note.');
      if (runtime.cancelled || !mountedRef.current) return;
      const unlisten = await onAiStream((event) => {
        if (event.request_id !== requestId || runtime.cancelled || !mountedRef.current) return;
        if (event.kind === 'thinking_delta') {
          thinking += event.text;
          status = operation === 'note' ? 'Thinking about the note…' : 'Thinking…';
        } else if (event.kind === 'answer_delta') {
          answer += event.text;
          status = operation === 'note' ? 'Generating note…' : 'Answering…';
        } else status = event.text;
        timer ??= setTimeout(flush, 80);
      });
      if (runtime.cancelled || !mountedRef.current) { unlisten(); return; }
      runtime.unlisten = unlisten;
      runtime.invoked = true;
      const result = await invoke();
      if (runtime.cancelled || !mountedRef.current) return;
      flush();
      receive(result.conversation);
      change(id, (view) => ({
        ...view, status: operation === 'note' ? 'Note ready to review' : 'Answer ready',
        thinking_by_turn: operation === 'answer' ? { ...view.thinking_by_turn, [requestId]: result.thinking } : view.thinking_by_turn,
        note_thinking: operation === 'note' ? result.thinking : view.note_thinking,
        error: null, persistence_state: 'saved', persistence_error: null,
      }));
    } catch (cause) {
      flush();
      change(id, (view) => ({
        ...view, error: runtime.cancelled ? view.error : String(cause),
        status: runtime.cancelled ? 'Stopped' : operation === 'note' ? 'Could not generate note' : 'Response incomplete',
        conversation: {
          ...view.conversation, active_request_id: null, active_operation: null,
          turns: view.conversation.turns.map((turn) => turn.turn_id === requestId && turn.phase === 'pending'
            ? { ...turn, phase: 'incomplete', error: runtime.cancelled ? 'Stopped' : String(cause) } : turn),
        },
      }));
      if (runtime.invoked && !runtime.cancelled) await recover(id, requestId);
    } finally {
      flush();
      runtime.unlisten?.();
      runtime.unlisten = undefined;
      // Cancel can race with a successful response. Refresh the server's actual
      // outcome, while refusing every late streamed token from that request.
      if (runtime.cancelled && runtime.invoked) await recover(id, requestId);
      if (requestsRef.current.get(id) === runtime) {
        requestsRef.current.delete(id);
        change(id, (view) => ({
          ...view, pending: false, operation: null, status: runtime.cancelled ? 'Stopped' : view.status,
          conversation: runtime.cancelled ? {
            ...view.conversation, active_request_id: null, active_operation: null,
            turns: view.conversation.turns.map((turn) => turn.turn_id === requestId && turn.phase === 'pending'
              ? { ...turn, phase: 'incomplete', error: 'Stopped' } : turn),
          } : view.conversation,
        }));
      }
    }
  }, [change, flushNote, receive, recover]);

  const start = useCallback((id: string, requestId: string, operation: 'answer' | 'note') => {
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id);
    if (!view || view.pending || view.saving_note || requestsRef.current.has(id)) return false;
    change(id, (current) => ({
      ...current, pending: true, operation, status: operation === 'note' ? 'Preparing note…' : 'Connecting…',
      error: null, collapsed: false, note_thinking: operation === 'note' ? '' : current.note_thinking,
      conversation: { ...current.conversation, active_request_id: requestId, active_operation: operation },
    }));
    return true;
  }, [change]);

  const ask = useCallback((sourcePaper: Paper, selection: SelectionContext, question: string) => {
    if (!question.trim()) return undefined;
    const id = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const source: NonNullable<AiConversationRequest['source']> = {
      ...selection, paper_id: sourcePaper.paper_id, pdf_hash: sourcePaper.pdf_hash,
      page_anchors: selection.page_anchors.map((anchor) => ({
        ...anchor, text_quote: { ...anchor.text_quote }, quad_points: anchor.quad_points.map((quad) => [...quad]),
      })),
    };
    receive({
      conversation_id: id, target: { paper_id: source.paper_id, pdf_hash: source.pdf_hash, page_anchors: source.page_anchors },
      paper_title: sourcePaper.title, selected_text: source.selected_text, context_text: source.context_text,
      created_at: now, updated_at: now, turns: [], note_draft: null, active_request_id: null, active_operation: null,
    }, false);
    start(id, requestId, 'answer');
    change(id, (view) => ({ ...view, unpersisted_turn_ids: [requestId], conversation: { ...view.conversation, turns: [{
      turn_id: requestId, question: question.trim(), answer: '', phase: 'pending', provider_id: '', model_id: '', error: null, created_at: now,
    }] } }));
    void run(id, requestId, 'answer', () => askAiConversation({ request_id: requestId, conversation_id: id, question: question.trim(), source }));
    return id;
  }, [change, receive, run, start]);

  const followUp = useCallback((id: string, question: string) => {
    if (!question.trim()) return false;
    const requestId = crypto.randomUUID();
    if (!start(id, requestId, 'answer')) return false;
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id)!;
    const source = view.history_persisted ? undefined : {
      ...view.conversation.target, selected_text: view.conversation.selected_text, context_text: view.conversation.context_text,
    };
    change(id, (view) => ({ ...view, unpersisted_turn_ids: [...view.unpersisted_turn_ids, requestId], conversation: { ...view.conversation, turns: [...view.conversation.turns, {
      turn_id: requestId, question: question.trim(), answer: '', phase: 'pending', provider_id: '', model_id: '', error: null, created_at: new Date().toISOString(),
    }] } }));
    void run(id, requestId, 'answer', () => askAiConversation({ request_id: requestId, conversation_id: id, question: question.trim(), ...(source ? { source } : {}) }));
    return true;
  }, [change, run, start]);

  const generateNote = useCallback(async (id: string) => {
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id);
    if (!view?.conversation.turns.some((turn) => turn.phase === 'complete')) return;
    const requestId = crypto.randomUUID();
    if (!start(id, requestId, 'note')) return;
    await run(id, requestId, 'note', () => generateAiConversationNote(requestId, id));
  }, [run, start]);

  const stop = useCallback((id: string) => {
    const runtime = requestsRef.current.get(id);
    if (!runtime) {
      const requestId = viewsRef.current.find((view) => view.conversation.conversation_id === id)?.conversation.active_request_id;
      if (!requestId || remoteStopsRef.current.has(requestId)) return;
      remoteStopsRef.current.add(requestId);
      change(id, (view) => ({ ...view, status: 'Stopping…' }));
      void cancelAiRequest(requestId).catch((cause) => {
        change(id, (view) => ({ ...view, error: `Could not stop the request: ${String(cause)}` }));
      }).finally(() => { remoteStopsRef.current.delete(requestId); });
      return;
    }
    if (runtime.cancelled) return;
    runtime.flush();
    runtime.cancelled = true;
    runtime.unlisten?.();
    runtime.unlisten = undefined;
    change(id, (view) => ({ ...view, status: 'Stopping…' }));
    if (runtime.invoked) void cancelAiRequest(runtime.request_id).catch((cause) => {
      change(id, (view) => ({ ...view, error: `Stopped displaying the response, but cancellation was not confirmed: ${String(cause)}` }));
    });
  }, [change]);

  const editNote = useCallback((id: string, content: string) => {
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id);
    const note = view?.conversation.note_draft;
    if (!view || !note || note.saved_annotation_id || view.saving_note || view.pending) return;
    let edit = notesRef.current.get(id);
    if (!edit || edit.note_id !== note.note_id) {
      edit = { note_id: note.note_id, content, revision: 0, persisted_revision: 0 };
      notesRef.current.set(id, edit);
    }
    edit.content = content;
    edit.revision += 1;
    clearTimeout(edit.timer);
    change(id, (current) => ({ ...current, note_content: content, persistence_state: 'pending', persistence_error: null }));
    edit.timer = setTimeout(() => { void flushNote(id); }, 500);
  }, [change, flushNote]);

  const saveNote = useCallback(async (id: string) => {
    const view = viewsRef.current.find((item) => item.conversation.conversation_id === id);
    const note = view?.conversation.note_draft;
    if (!view || !note || note.saved_annotation_id || view.pending || view.saving_note || !view.note_content.trim()) return;
    change(id, (current) => ({ ...current, saving_note: true, error: null }));
    const edit = notesRef.current.get(id);
    clearTimeout(edit?.timer);
    // Let any older write finish first; the atomic save below stores the latest
    // local content even when an earlier draft write failed.
    if (edit?.in_flight) await edit.in_flight;
    if (discardedRef.current.has(id)) return;
    try {
      const result = await saveAiConversationNote(id, note.note_id, view.note_content);
      if (!mountedRef.current || discardedRef.current.has(id)) return;
      if (edit) edit.persisted_revision = edit.revision;
      receive(result.conversation);
      change(id, (current) => ({ ...current, persistence_state: 'saved', persistence_error: null, status: 'Note saved' }));
      onSavedRef.current(result.annotation);
    } catch (cause) {
      change(id, (current) => ({ ...current, error: `Could not save your note: ${String(cause)}` }));
    } finally {
      change(id, (current) => ({ ...current, saving_note: false }));
    }
  }, [change, receive]);

  const toggleCollapsed = useCallback((id: string) => {
    change(id, (view) => ({ ...view, collapsed: !view.collapsed }));
  }, [change]);

  const forgetPaper = useCallback((paperId: string) => {
    paperGenerationsRef.current.set(paperId, (paperGenerationsRef.current.get(paperId) ?? 0) + 1);
    for (const view of viewsRef.current.filter((item) => item.conversation.target.paper_id === paperId)) {
      const id = view.conversation.conversation_id;
      discardedRef.current.add(id);
      const runtime = requestsRef.current.get(id);
      if (runtime) {
        runtime.cancelled = true;
        runtime.flush();
        runtime.unlisten?.();
        if (runtime.invoked) void cancelAiRequest(runtime.request_id).catch(() => {});
        requestsRef.current.delete(id);
      } else if (view.conversation.active_request_id) {
        void cancelAiRequest(view.conversation.active_request_id).catch(() => {});
      }
      clearTimeout(notesRef.current.get(id)?.timer);
      notesRef.current.delete(id);
      versionsRef.current.delete(id);
    }
    viewsRef.current = viewsRef.current.filter((view) => view.conversation.target.paper_id !== paperId);
    setViews(viewsRef.current);
  }, []);

  // A webview reload can outlive its Rust request. Observe only these orphaned
  // operations; normal streams already have a completion promise and listener.
  const remotePending = views.filter((view) => view.pending && view.conversation.active_request_id
    && !requestsRef.current.has(view.conversation.conversation_id));
  const remoteKey = remotePending.map((view) => view.conversation.conversation_id).sort().join('|');
  useEffect(() => {
    if (!remoteKey) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const waiting = viewsRef.current.filter((view) => view.pending && view.conversation.active_request_id
        && !requestsRef.current.has(view.conversation.conversation_id));
      const versions = new Map(versionsRef.current);
      const isCurrent = (view: AiConversationView) => {
        const id = view.conversation.conversation_id;
        const current = viewsRef.current.find((item) => item.conversation.conversation_id === id);
        return !disposed && mountedRef.current && !requestsRef.current.has(id) && current?.pending
          && current.conversation.active_request_id === view.conversation.active_request_id
          && versionsRef.current.get(id) === versions.get(id);
      };
      const paperIds = [...new Set(waiting.map((view) => view.conversation.target.paper_id))];
      await Promise.all(paperIds.map(async (paperId) => {
        try {
          const records = await listAiConversations(paperId);
          if (disposed || !mountedRef.current) return;
          for (const view of waiting.filter((item) => item.conversation.target.paper_id === paperId)) {
            const id = view.conversation.conversation_id;
            if (!isCurrent(view)) continue;
            const record = records.find((item) => item.conversation_id === id);
            if (record) {
              receive(record);
              change(id, (current) => ({
                ...current, status: record.active_request_id ? current.status : '',
                error: current.error?.startsWith('Could not refresh the active request:') ? null : current.error,
              }));
            }
            else change(id, (current) => ({ ...current, pending: false, operation: null, error: 'This conversation could not be found in local history.' }));
          }
        } catch (cause) {
          for (const view of waiting.filter((item) => item.conversation.target.paper_id === paperId && isCurrent(item))) {
            change(view.conversation.conversation_id, (current) => ({ ...current, error: `Could not refresh the active request: ${String(cause)}` }));
          }
        }
      }));
      if (!disposed) timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [remoteKey, change, receive]);

  return {
    conversations: views.filter((view) => view.conversation.target.paper_id === paper?.paper_id && view.conversation.target.pdf_hash === paper?.pdf_hash),
    loading, load_error: loadError, reload, ask, followUp, generateNote, stop, editNote,
    retryNotePersistence: flushNote, saveNote, toggleCollapsed, forgetPaper,
  };
}
