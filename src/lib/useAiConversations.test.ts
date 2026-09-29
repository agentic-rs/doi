// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as backend from './tauri';
import type { AiConversation, AiConversationRequest, AiConversationResponse, AiNoteDraft, AiStreamEvent, Annotation, Paper, SelectionContext } from './types';
import { useAiConversations } from './useAiConversations';

vi.mock('./tauri', () => ({
  askAiConversation: vi.fn(), generateAiConversationNote: vi.fn(), listAiConversations: vi.fn(),
  updateAiConversationNote: vi.fn(), saveAiConversationNote: vi.fn(), onAiStream: vi.fn(), cancelAiRequest: vi.fn(),
}));

const paper: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7, title: 'First paper',
  authors: ['Author'], abstract: 'Abstract', pdf_url: '', pdf_hash: 'a'.repeat(64),
  downloaded_at: '2026-09-28T00:00:00Z', last_location: null,
};
const second: Paper = { ...paper, paper_id: '1409.0473v3', pdf_hash: 'b'.repeat(64), title: 'Second paper' };
const selection: SelectionContext = {
  selected_text: 'Original passage', context_text: 'Nearby context',
  page_anchors: [{ page_number: 4, quad_points: [[10, 20, 30, 20, 30, 10, 10, 10]],
    text_quote: { exact_text: 'Original passage', prefix: '', suffix: '', normalization_version: 1 } }],
};
const initial: AiConversation = {
  conversation_id: 'conversation-1', target: { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, page_anchors: selection.page_anchors },
  selected_text: selection.selected_text, context_text: selection.context_text, paper_title: paper.title,
  created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
  active_request_id: null, active_operation: null, note_draft: null,
  turns: [{ turn_id: 'turn-1', question: 'Explain', answer: 'First answer', phase: 'complete', provider_id: 'zai', model_id: 'glm-test', error: null, created_at: '2026-09-28T00:00:00Z' }],
};
const note: AiNoteDraft = {
  note_id: 'note-1', content: 'A useful takeaway', answer: 'First answer', question: 'Explain', provider_id: 'zai', model_id: 'glm-test',
  context_text: 'Actual context', created_at: '2026-09-28T00:00:00Z', saved_annotation_id: null, source_turn_count: 1,
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let records: Map<string, AiConversation>;
let listeners: Set<(event: AiStreamEvent) => void>;
let unlisten: ReturnType<typeof vi.fn>;

function finishRequest(request: AiConversationRequest): AiConversationResponse {
  const existing = records.get(request.conversation_id);
  if (!existing && !request.source) throw new Error('Conversation no longer available');
  const conversation: AiConversation = existing ? clone(existing) : {
    ...clone(initial), conversation_id: request.conversation_id, turns: [],
    target: { paper_id: request.source!.paper_id, pdf_hash: request.source!.pdf_hash, page_anchors: request.source!.page_anchors },
    selected_text: request.source!.selected_text, context_text: request.source!.context_text,
  };
  conversation.turns.push({ ...clone(initial.turns[0]), turn_id: request.request_id, question: request.question, answer: `Answer ${conversation.turns.length + 1}` });
  records.set(conversation.conversation_id, clone(conversation));
  return { conversation, thinking: 'Received thinking' };
}
function emit(event: AiStreamEvent) { for (const listener of listeners) listener(event); }
function annotation(conversation: AiConversation, content: string): Annotation {
  return {
    schema_version: 1, annotation_id: 'annotation-1', target: conversation.target,
    body: { kind: 'ai_answer', question: 'Explain', answer: 'Full answer', note_content: content, provider_id: 'zai', model_id: 'glm-test', context_text: 'Actual context' },
    created_at: initial.created_at, updated_at: initial.updated_at,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  records = new Map(); listeners = new Set(); unlisten = vi.fn();
  vi.mocked(backend.listAiConversations).mockImplementation(async (id) => [...records.values()].filter((item) => item.target.paper_id === id).map(clone));
  vi.mocked(backend.onAiStream).mockImplementation(async (handler) => {
    listeners.add(handler);
    return () => { unlisten(); listeners.delete(handler); };
  });
  vi.mocked(backend.cancelAiRequest).mockResolvedValue();
  vi.mocked(backend.askAiConversation).mockImplementation(async (request) => finishRequest(request));
  vi.mocked(backend.generateAiConversationNote).mockImplementation(async (_requestId, id) => {
    const conversation = { ...clone(records.get(id)!), note_draft: { ...note, source_turn_count: records.get(id)!.turns.filter((turn) => turn.phase === 'complete').length } };
    records.set(id, clone(conversation));
    return { conversation, thinking: 'Note thinking' };
  });
  vi.mocked(backend.updateAiConversationNote).mockImplementation(async (id, _noteId, content) => {
    const conversation = clone(records.get(id)!);
    conversation.note_draft!.content = content;
    records.set(id, clone(conversation));
    return conversation;
  });
  vi.mocked(backend.saveAiConversationNote).mockImplementation(async (id, _noteId, content) => {
    const conversation = clone(records.get(id)!);
    conversation.note_draft = { ...conversation.note_draft!, content, saved_annotation_id: 'annotation-1' };
    records.set(id, clone(conversation));
    return { conversation, annotation: annotation(conversation, content) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function loadedWithNote() {
  records.set(initial.conversation_id, { ...clone(initial), note_draft: clone(note) });
  const onSaved = vi.fn();
  const hook = renderHook(() => useAiConversations(paper, onSaved));
  await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1));
  return { ...hook, onSaved };
}

describe('durable AI conversations', () => {
  it('captures the original passage, appends follow-ups, and generates/saves notes only on explicit actions', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() => useAiConversations(paper, onSaved));
    const selected = clone(selection);
    let id: string | undefined;
    act(() => { id = result.current.ask(paper, selected, 'First question'); });
    selected.page_anchors[0].quad_points[0][0] = 999;
    await waitFor(() => expect(result.current.conversations[0].pending).toBe(false));
    expect(result.current.conversations[0].history_persisted).toBe(true);
    expect(vi.mocked(backend.onAiStream).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(backend.askAiConversation).mock.invocationCallOrder[0]);
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    expect(request.source).toMatchObject({ ...selection, paper_id: paper.paper_id, pdf_hash: paper.pdf_hash });
    expect(request.conversation_id).toBe(id);
    act(() => { expect(result.current.followUp(id!, 'Follow-up question')).toBe(true); });
    await waitFor(() => expect(result.current.conversations[0].pending).toBe(false));
    expect(result.current.conversations[0].conversation.turns.map((turn) => turn.question)).toEqual(['First question', 'Follow-up question']);
    expect(vi.mocked(backend.askAiConversation).mock.calls[1][0].source).toBeUndefined();
    expect(backend.generateAiConversationNote).not.toHaveBeenCalled();
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
    await act(async () => result.current.generateNote(id!));
    expect(result.current.conversations[0].note_content).toBe(note.content);
    expect(result.current.conversations[0].conversation.note_draft?.source_turn_count).toBe(2);
    act(() => result.current.editNote(id!, 'My edited takeaway'));
    await act(async () => result.current.saveNote(id!));
    expect(backend.saveAiConversationNote).toHaveBeenCalledWith(id, note.note_id, 'My edited takeaway');
    expect(onSaved).toHaveBeenCalledTimes(1);
    await act(async () => result.current.saveNote(id!));
    expect(backend.saveAiConversationNote).toHaveBeenCalledTimes(1);
  });

  it('loads persisted history after remount without inventing or persisting thinking', async () => {
    records.set(initial.conversation_id, clone(initial));
    const first = renderHook(() => useAiConversations(paper, vi.fn()));
    await waitFor(() => expect(first.result.current.conversations).toHaveLength(1));
    expect(first.result.current.conversations[0].thinking_by_turn).toEqual({});
    first.unmount();
    const reopened = renderHook(() => useAiConversations(paper, vi.fn()));
    await waitFor(() => expect(reopened.result.current.conversations[0].conversation.turns[0].answer).toBe('First answer'));
    expect(backend.askAiConversation).not.toHaveBeenCalled();
  });

  it('refreshes an operation that survived webview reload and stops polling when it completes', async () => {
    vi.useFakeTimers();
    const active = { ...clone(initial), active_request_id: 'restored-request', active_operation: 'answer' as const };
    active.turns.push({ ...clone(initial.turns[0]), turn_id: 'restored-request', question: 'Pending follow-up', answer: '', phase: 'pending' });
    records.set(initial.conversation_id, active);
    const { result } = renderHook(() => useAiConversations(paper, vi.fn()));
    await act(async () => {});
    expect(result.current.conversations[0].pending).toBe(true);
    vi.mocked(backend.listAiConversations).mockRejectedValueOnce(new Error('Temporarily unavailable'));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(result.current.conversations[0].error).toContain('Could not refresh the active request');
    records.set(initial.conversation_id, {
      ...active, active_request_id: null, active_operation: null,
      turns: [active.turns[0], { ...active.turns[1], answer: 'Completed after reload', phase: 'complete' }],
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(result.current.conversations[0]).toMatchObject({ pending: false, error: null, thinking_by_turn: {} });
    expect(result.current.conversations[0].conversation.turns[1].answer).toBe('Completed after reload');
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(backend.listAiConversations).toHaveBeenCalledTimes(3);
    expect(backend.onAiStream).not.toHaveBeenCalled();
  });

  it('can stop an operation restored from disk without a local stream runtime', async () => {
    vi.useFakeTimers();
    records.set(initial.conversation_id, { ...clone(initial), active_request_id: 'restored-note', active_operation: 'note' });
    const cancellation = deferred<void>();
    vi.mocked(backend.cancelAiRequest).mockReturnValueOnce(cancellation.promise);
    const { result } = renderHook(() => useAiConversations(paper, vi.fn()));
    await act(async () => {});
    act(() => { result.current.stop(initial.conversation_id); result.current.stop(initial.conversation_id); });
    expect(backend.cancelAiRequest).toHaveBeenCalledTimes(1);
    expect(backend.cancelAiRequest).toHaveBeenCalledWith('restored-note');
    expect(result.current.conversations[0].status).toBe('Stopping…');
    records.set(initial.conversation_id, clone(initial));
    await act(async () => { cancellation.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.conversations[0].pending).toBe(false);
  });

  it('does not let an older active-operation poll replace a newly generated and edited note', async () => {
    vi.useFakeTimers();
    const active = { ...clone(initial), note_draft: clone(note), active_request_id: 'restored-note', active_operation: 'note' as const };
    records.set(initial.conversation_id, active);
    const { result } = renderHook(() => useAiConversations(paper, vi.fn()));
    await act(async () => {});
    const stale = deferred<AiConversation[]>();
    vi.mocked(backend.listAiConversations).mockReturnValueOnce(stale.promise);
    act(() => vi.advanceTimersByTime(2000));
    expect(backend.listAiConversations).toHaveBeenCalledTimes(2);
    records.set(initial.conversation_id, { ...clone(initial), note_draft: { ...note, note_id: 'new-note', content: 'Freshly generated' } });
    await act(async () => {
      await result.current.reload();
      result.current.editNote(initial.conversation_id, 'My new draft edit');
      stale.resolve([active]);
      await stale.promise;
    });
    expect(result.current.conversations[0]).toMatchObject({ pending: false, note_content: 'My new draft edit', persistence_state: 'pending' });
    expect(result.current.conversations[0].conversation.note_draft?.note_id).toBe('new-note');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(backend.updateAiConversationNote).toHaveBeenCalledWith(initial.conversation_id, 'new-note', 'My new draft edit');
  });

  it('ignores late loads after paper navigation and reports retryable load errors', async () => {
    const pending = deferred<AiConversation[]>();
    vi.mocked(backend.listAiConversations).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Storage unavailable'));
    const { result, rerender } = renderHook(({ active }) => useAiConversations(active, vi.fn()), { initialProps: { active: paper } });
    rerender({ active: second });
    await waitFor(() => expect(result.current.load_error).toContain('Storage unavailable'));
    await act(async () => pending.resolve([clone(initial)]));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.load_error).toContain('Storage unavailable');
    const other = { ...clone(initial), conversation_id: 'other', target: { ...initial.target, paper_id: second.paper_id, pdf_hash: second.pdf_hash } };
    records.set('other', other);
    await act(async () => result.current.reload());
    expect(result.current.load_error).toBeNull();
    expect(result.current.conversations[0].conversation.conversation_id).toBe('other');
  });

  it('preserves active requests across navigation and ignores a stale reload snapshot', async () => {
    records.set(initial.conversation_id, clone(initial));
    const { result, rerender } = renderHook(({ active }) => useAiConversations(active, vi.fn()), { initialProps: { active: paper } });
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    const old = deferred<AiConversation[]>();
    vi.mocked(backend.listAiConversations).mockReturnValueOnce(old.promise);
    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    const response = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(response.promise);
    act(() => result.current.followUp(initial.conversation_id, 'Keep following'));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    rerender({ active: second });
    expect(result.current.conversations).toEqual([]);
    await act(async () => response.resolve(finishRequest(request)));
    await act(async () => { old.resolve([clone(initial)]); await reload; });
    rerender({ active: paper });
    await waitFor(() => expect(result.current.conversations[0].conversation.turns).toHaveLength(2));
    expect(backend.cancelAiRequest).not.toHaveBeenCalled();
  });

  it('coalesces stream text and recovers persisted incomplete turns without losing partial content', async () => {
    const response = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(response.promise);
    const { result } = renderHook(() => useAiConversations(paper, vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    const saved = finishRequest(request).conversation;
    saved.turns[0] = { ...saved.turns[0], phase: 'incomplete', answer: '', error: 'Connection lost' };
    records.set(saved.conversation_id, saved);
    act(() => {
      emit({ request_id: request.request_id, kind: 'thinking_delta', text: 'Received thought' });
      emit({ request_id: request.request_id, kind: 'answer_delta', text: 'Partial answer' });
    });
    expect(result.current.conversations[0].conversation.turns[0].answer).toBe('');
    await act(async () => response.reject(new Error('Connection lost')));
    const view = result.current.conversations[0];
    expect(view).toMatchObject({ pending: false, history_persisted: true, error: expect.stringContaining('Connection lost') });
    expect(view.conversation.turns[0]).toMatchObject({ phase: 'incomplete', answer: 'Partial answer' });
    expect(view.thinking_by_turn[request.request_id]).toBe('Received thought');
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
  });

  it.each(['stop', 'listener failure'])('can retry an initial request after %s before invocation using the original source', async (failure) => {
    const listener = deferred<() => void>();
    vi.mocked(backend.onAiStream).mockReturnValueOnce(listener.promise);
    const { result } = renderHook(() => useAiConversations(paper, vi.fn()));
    let id!: string;
    act(() => { id = result.current.ask(paper, selection, 'Unsent question')!; });
    await waitFor(() => expect(backend.onAiStream).toHaveBeenCalled());
    if (failure === 'stop') {
      act(() => result.current.stop(id));
      await act(async () => listener.resolve(unlisten));
    } else await act(async () => listener.reject(new Error('Listener unavailable')));
    expect(backend.askAiConversation).not.toHaveBeenCalled();
    expect(result.current.conversations[0]).toMatchObject({ pending: false, history_persisted: false });
    expect(result.current.conversations[0].conversation.turns[0].phase).toBe('incomplete');
    act(() => { expect(result.current.followUp(id, 'Try again')).toBe(true); });
    await waitFor(() => expect(result.current.conversations[0].history_persisted).toBe(true));
    expect(vi.mocked(backend.askAiConversation).mock.calls[0][0].source).toMatchObject(selection);
    expect(result.current.conversations[0].conversation.turns.map((turn) => turn.question)).toEqual(['Try again']);
    expect(result.current.conversations[0].unpersisted_turn_ids).toEqual([]);
  });

  it('stops an active stream, ignores late events, and cancels on unmount', async () => {
    const response = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(response.promise);
    const { result, unmount } = renderHook(() => useAiConversations(paper, vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    const id = request.conversation_id;
    act(() => emit({ request_id: request.request_id, kind: 'answer_delta', text: 'Before Stop' }));
    act(() => result.current.stop(id));
    act(() => emit({ request_id: request.request_id, kind: 'answer_delta', text: 'Late text' }));
    await act(async () => response.reject(new Error('Cancelled')));
    expect(result.current.conversations[0].conversation.turns[0]).toMatchObject({ phase: 'incomplete', answer: 'Before Stop' });
    expect(backend.cancelAiRequest).toHaveBeenCalledWith(request.request_id);
    expect(unlisten).toHaveBeenCalledTimes(1);
    const hanging = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(hanging.promise);
    act(() => result.current.followUp(id, 'Another question'));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(2));
    unmount();
    expect(backend.cancelAiRequest).toHaveBeenCalledTimes(2);
    await act(async () => hanging.reject(new Error('Cancelled')));
  });

  it('serializes overlapping note edits and never replaces newer local typing with an older response', async () => {
    const { result } = await loadedWithNote();
    const pending = deferred<AiConversation>();
    vi.mocked(backend.updateAiConversationNote).mockReturnValueOnce(pending.promise);
    act(() => result.current.editNote(initial.conversation_id, 'Older edit'));
    let storing!: Promise<boolean>;
    act(() => { storing = result.current.retryNotePersistence(initial.conversation_id); });
    act(() => result.current.editNote(initial.conversation_id, 'Newer edit'));
    await act(async () => pending.resolve({ ...clone(initial), note_draft: { ...note, content: 'Older edit' } }));
    await act(async () => { await storing; });
    expect(vi.mocked(backend.updateAiConversationNote).mock.calls.map((call) => call[2])).toEqual(['Older edit', 'Newer edit']);
    expect(result.current.conversations[0]).toMatchObject({ note_content: 'Newer edit', persistence_state: 'saved' });
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
  });

  it('retains local edits after persistence/save failures and atomically retries Save once', async () => {
    const { result, onSaved } = await loadedWithNote();
    vi.mocked(backend.updateAiConversationNote).mockRejectedValueOnce(new Error('Disk unavailable'));
    act(() => result.current.editNote(initial.conversation_id, 'Keep my typing'));
    await act(async () => { expect(await result.current.retryNotePersistence(initial.conversation_id)).toBe(false); });
    expect(result.current.conversations[0]).toMatchObject({ note_content: 'Keep my typing', persistence_state: 'error' });
    vi.mocked(backend.saveAiConversationNote).mockRejectedValueOnce(new Error('Still unavailable'));
    await act(async () => result.current.saveNote(initial.conversation_id));
    expect(result.current.conversations[0]).toMatchObject({ note_content: 'Keep my typing', error: expect.stringContaining('Still unavailable'), saving_note: false });
    await act(async () => Promise.all([result.current.saveNote(initial.conversation_id), result.current.saveNote(initial.conversation_id)]));
    expect(backend.saveAiConversationNote).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.conversations[0].conversation.note_draft?.saved_annotation_id).toBe('annotation-1');
    act(() => result.current.editNote(initial.conversation_id, 'Must not edit saved note'));
    expect(result.current.conversations[0].note_content).toBe('Keep my typing');
  });

  it('flushes empty draft edits before follow-up without losing its optimistic turn', async () => {
    const { result } = await loadedWithNote();
    const pending = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(pending.promise);
    act(() => result.current.editNote(initial.conversation_id, ''));
    act(() => result.current.followUp(initial.conversation_id, 'Continue'));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    expect(backend.updateAiConversationNote).toHaveBeenCalledWith(initial.conversation_id, note.note_id, '');
    expect(result.current.conversations[0].conversation.turns.at(-1)).toMatchObject({ question: 'Continue', phase: 'pending' });
    await act(async () => pending.resolve(finishRequest(vi.mocked(backend.askAiConversation).mock.calls[0][0])));
  });

  it('keeps the prior note when explicit generation fails and collapses without deleting history', async () => {
    const { result } = await loadedWithNote();
    vi.mocked(backend.generateAiConversationNote).mockRejectedValueOnce(new Error('This model cannot propose notes'));
    await act(async () => result.current.generateNote(initial.conversation_id));
    expect(result.current.conversations[0]).toMatchObject({ note_content: note.content, error: expect.stringContaining('cannot propose notes') });
    act(() => result.current.toggleCollapsed(initial.conversation_id));
    expect(result.current.conversations[0].collapsed).toBe(true);
    act(() => result.current.toggleCollapsed(initial.conversation_id));
    expect(result.current.conversations[0].conversation.turns).toHaveLength(1);
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
  });
});
