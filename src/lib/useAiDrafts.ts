import { useCallback, useEffect, useRef, useState } from 'react';
import { askSelection, cancelAiRequest, onAiStream, saveAnnotation } from './tauri';
import type { AiAnswer, Annotation, Paper, SelectionContext } from './types';

export interface AiDraft {
  request_id: string;
  paper: Pick<Paper, 'paper_id' | 'pdf_hash' | 'title'>;
  selection: SelectionContext;
  question: string;
  created_at: string;
  phase: 'pending' | 'complete' | 'incomplete';
  status: string;
  thinking: string;
  answer: string;
  result: AiAnswer | null;
  note_content: string;
  error: string | null;
  save_state: 'idle' | 'saving' | 'saved';
  save_error: string | null;
}

interface RequestRuntime {
  cancelled: boolean;
  invoked: boolean;
  flush: () => void;
  unlisten?: () => void;
}

// Drafts live with the workspace, independently of the current PDF selection or
// inspector mount. Every request and save uses its captured source passage.
export function useAiDrafts(onSaved: (annotation: Annotation) => void) {
  const [drafts, setDrafts] = useState<AiDraft[]>([]);
  const draftsRef = useRef(drafts);
  const mountedRef = useRef(true);
  const requestsRef = useRef(new Map<string, RequestRuntime>());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const updateDrafts = useCallback((update: (existing: AiDraft[]) => AiDraft[]) => {
    if (!mountedRef.current) return;
    draftsRef.current = update(draftsRef.current);
    setDrafts(draftsRef.current);
  }, []);

  const updateDraft = useCallback((requestId: string, update: (draft: AiDraft) => AiDraft) => {
    updateDrafts((existing) => existing.map((draft) => draft.request_id === requestId ? update(draft) : draft));
  }, [updateDrafts]);

  useEffect(() => {
    mountedRef.current = true;
    const requests = requestsRef.current;
    return () => {
      mountedRef.current = false;
      for (const [requestId, runtime] of requests) {
        runtime.cancelled = true;
        runtime.flush();
        runtime.unlisten?.();
        runtime.unlisten = undefined;
        if (runtime.invoked) void cancelAiRequest(requestId).catch(() => {});
      }
      requests.clear();
    };
  }, []);

  const ask = useCallback((paper: Paper, selection: SelectionContext, question: string) => {
    if (!question.trim()) return;
    const requestId = crypto.randomUUID();
    const capturedSelection: SelectionContext = {
      ...selection,
      page_anchors: selection.page_anchors.map((anchor) => ({
        ...anchor, text_quote: { ...anchor.text_quote }, quad_points: anchor.quad_points.map((quad) => [...quad]),
      })),
    };
    let thinkingDelta = '';
    let answerDelta = '';
    let streamStatus: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!thinkingDelta && !answerDelta && streamStatus === null) return;
      updateDraft(requestId, (draft) => draft.phase === 'pending' ? {
        ...draft, thinking: draft.thinking + thinkingDelta, answer: draft.answer + answerDelta,
        status: streamStatus ?? draft.status,
      } : draft);
      thinkingDelta = '';
      answerDelta = '';
      streamStatus = null;
    };
    const runtime: RequestRuntime = { cancelled: false, invoked: false, flush };
    requestsRef.current.set(requestId, runtime);
    updateDrafts((existing) => [{
      request_id: requestId,
      paper: { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, title: paper.title },
      selection: capturedSelection,
      question: question.trim(),
      created_at: new Date().toISOString(),
      phase: 'pending', status: 'Connecting…', thinking: '', answer: '', result: null,
      note_content: '', error: null, save_state: 'idle', save_error: null,
    }, ...existing]);

    void (async () => {
      try {
        const unlisten = await onAiStream((event) => {
          if (event.request_id !== requestId || runtime.cancelled || !mountedRef.current) return;
          if (event.kind === 'thinking_delta') {
            thinkingDelta += event.text;
            streamStatus = 'Thinking…';
          } else if (event.kind === 'answer_delta') {
            answerDelta += event.text;
            streamStatus = 'Answering…';
          } else streamStatus = event.text;
          // Coalesce token-sized events without delaying Stop or completion.
          flushTimer ??= setTimeout(flush, 80);
        });
        if (runtime.cancelled || !mountedRef.current) {
          unlisten();
          return;
        }
        runtime.unlisten = unlisten;
        runtime.invoked = true;
        const result = await askSelection({
          request_id: requestId,
          paper_id: paper.paper_id,
          selected_text: capturedSelection.selected_text,
          context_text: capturedSelection.context_text,
          question: question.trim(),
        });
        if (runtime.cancelled || !mountedRef.current) return;
        flush();
        updateDraft(requestId, (draft) => ({
          ...draft, phase: 'complete', status: 'Answer ready', result,
          answer: result.answer, thinking: result.thinking,
          note_content: result.note_proposal?.trim() || result.answer,
        }));
      } catch (cause) {
        flush();
        if (!runtime.cancelled) updateDraft(requestId, (draft) => ({
          ...draft, phase: 'incomplete', status: 'Response incomplete', error: String(cause),
        }));
      } finally {
        flush();
        runtime.unlisten?.();
        runtime.unlisten = undefined;
        requestsRef.current.delete(requestId);
      }
    })();
    return requestId;
  }, [updateDraft, updateDrafts]);

  const stop = useCallback((requestId: string) => {
    const runtime = requestsRef.current.get(requestId);
    if (!runtime || runtime.cancelled) return;
    runtime.flush();
    runtime.cancelled = true;
    runtime.unlisten?.();
    runtime.unlisten = undefined;
    updateDraft(requestId, (draft) => ({ ...draft, phase: 'incomplete', status: 'Stopped · response incomplete' }));
    if (runtime.invoked) void cancelAiRequest(requestId).catch((cause) => {
      updateDraft(requestId, (draft) => ({
        ...draft, error: `Stopped displaying the response, but could not confirm cancellation: ${String(cause)}`,
      }));
    });
  }, [updateDraft]);

  const editNote = useCallback((requestId: string, content: string) => {
    updateDraft(requestId, (draft) => draft.save_state === 'idle' ? { ...draft, note_content: content, save_error: null } : draft);
  }, [updateDraft]);

  const save = useCallback(async (requestId: string) => {
    const draft = draftsRef.current.find((item) => item.request_id === requestId);
    if (!draft || draft.phase !== 'complete' || !draft.result || draft.save_state !== 'idle' || !draft.note_content.trim()) return;
    const annotation: Annotation = {
      schema_version: 1,
      annotation_id: draft.request_id,
      target: {
        paper_id: draft.paper.paper_id,
        pdf_hash: draft.paper.pdf_hash,
        page_anchors: draft.selection.page_anchors,
      },
      body: {
        kind: 'ai_answer', question: draft.question, answer: draft.result.answer,
        note_content: draft.note_content.trim(), provider_id: draft.result.provider_id,
        model_id: draft.result.model_id, context_text: draft.result.context_text,
      },
      created_at: draft.created_at,
      updated_at: draft.created_at,
    };
    updateDraft(requestId, (current) => ({ ...current, save_state: 'saving', save_error: null }));
    try {
      const saved = await saveAnnotation(annotation);
      if (!mountedRef.current) return;
      updateDraft(requestId, (current) => ({ ...current, save_state: 'saved' }));
      onSavedRef.current(saved);
    } catch (cause) {
      updateDraft(requestId, (current) => ({ ...current, save_state: 'idle', save_error: `Could not save your note: ${String(cause)}` }));
    }
  }, [updateDraft]);

  const dismiss = useCallback((requestId: string) => {
    const draft = draftsRef.current.find((item) => item.request_id === requestId);
    if (!draft || draft.phase === 'pending' || draft.save_state === 'saving') return;
    updateDrafts((existing) => existing.filter((item) => item.request_id !== requestId));
  }, [updateDrafts]);

  return { drafts, ask, stop, editNote, save, dismiss };
}
