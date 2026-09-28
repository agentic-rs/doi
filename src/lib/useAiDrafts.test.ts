// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as backend from './tauri';
import type { AiAnswer, AiStreamEvent, Paper, SelectionContext } from './types';
import { useAiDrafts } from './useAiDrafts';

vi.mock('./tauri', () => ({
  askSelection: vi.fn(), onAiStream: vi.fn(), cancelAiRequest: vi.fn(), saveAnnotation: vi.fn(),
}));

const paper: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'First paper', authors: ['Author'], abstract: 'Abstract', pdf_url: '',
  pdf_hash: 'a'.repeat(64), downloaded_at: '2026-09-27T00:00:00Z', last_location: null,
};
const selection: SelectionContext = {
  selected_text: 'A selected passage', context_text: 'Nearby text',
  page_anchors: [{ page_number: 4, quad_points: [[10, 20, 30, 20, 30, 10, 10, 10]],
    text_quote: { exact_text: 'A selected passage', prefix: '', suffix: '', normalization_version: 1 } }],
};
const answer: AiAnswer = {
  answer: 'The complete answer', thinking: 'Provider reasoning',
  note_proposal: 'A concise takeaway', proposal_warning: null,
  provider_id: 'local', model_id: 'local-model', context_text: 'Actual prompt',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

let handler: (event: AiStreamEvent) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  unlisten = vi.fn();
  vi.mocked(backend.onAiStream).mockImplementation(async (listener) => { handler = listener; return unlisten; });
  vi.mocked(backend.cancelAiRequest).mockResolvedValue();
  vi.mocked(backend.saveAnnotation).mockImplementation(async (annotation) => annotation);
});
afterEach(cleanup);

describe('AI drafts', () => {
  it('subscribes before asking, streams thinking and answers, and waits for an explicit save', async () => {
    const response = deferred<AiAnswer>();
    vi.mocked(backend.askSelection).mockReturnValue(response.promise);
    const onSaved = vi.fn();
    const { result } = renderHook(() => useAiDrafts(onSaved));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askSelection).toHaveBeenCalled());
    expect(vi.mocked(backend.onAiStream).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(backend.askSelection).mock.invocationCallOrder[0]);
    const requestId = result.current.drafts[0].request_id;
    act(() => {
      handler({ request_id: requestId, kind: 'status', text: 'Connected' });
      handler({ request_id: requestId, kind: 'thinking_delta', text: 'Provider ' });
      handler({ request_id: requestId, kind: 'thinking_delta', text: 'reasoning' });
      handler({ request_id: requestId, kind: 'answer_delta', text: 'The complete ' });
      handler({ request_id: 'another-request', kind: 'answer_delta', text: 'Unrelated' });
    });
    await waitFor(() => expect(result.current.drafts[0]).toMatchObject({ thinking: 'Provider reasoning', answer: 'The complete ', phase: 'pending' }));
    await act(async () => response.resolve(answer));
    expect(result.current.drafts[0]).toMatchObject({ answer: answer.answer, note_content: answer.note_proposal, phase: 'complete' });
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    act(() => result.current.editNote(requestId, 'My own takeaway'));
    await act(async () => result.current.save(requestId));
    expect(backend.saveAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      annotation_id: requestId,
      target: { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, page_anchors: selection.page_anchors },
      body: { kind: 'ai_answer', question: 'Explain', answer: answer.answer, note_content: 'My own takeaway', provider_id: answer.provider_id, model_id: answer.model_id, context_text: answer.context_text },
    }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    await act(async () => result.current.save(requestId));
    expect(backend.saveAnnotation).toHaveBeenCalledTimes(1);
    expect(result.current.drafts[0].save_state).toBe('saved');
  });

  it('retains a failed save and retries the same annotation without another model request', async () => {
    vi.mocked(backend.askSelection).mockResolvedValue(answer);
    vi.mocked(backend.saveAnnotation).mockRejectedValueOnce(new Error('Disk unavailable'));
    const { result } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(result.current.drafts[0].phase).toBe('complete'));
    const id = result.current.drafts[0].request_id;
    await act(async () => result.current.save(id));
    expect(result.current.drafts[0]).toMatchObject({ note_content: answer.note_proposal, save_state: 'idle', save_error: expect.stringContaining('Disk unavailable') });
    await act(async () => result.current.save(id));
    expect(backend.askSelection).toHaveBeenCalledTimes(1);
    const saves = vi.mocked(backend.saveAnnotation).mock.calls;
    expect(saves[0][0]).toEqual(saves[1][0]);
    expect(result.current.drafts[0].save_state).toBe('saved');
  });

  it('falls back to an editable full answer when the model has no note proposal', async () => {
    vi.mocked(backend.askSelection).mockResolvedValue({ ...answer, thinking: '', note_proposal: null, proposal_warning: 'Tool calling is unavailable.' });
    const { result } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(result.current.drafts[0].phase).toBe('complete'));
    expect(result.current.drafts[0]).toMatchObject({ thinking: '', note_content: answer.answer });
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
  });

  it('stops the backend, retains partial text, and rejects late events and completion', async () => {
    const response = deferred<AiAnswer>();
    vi.mocked(backend.askSelection).mockReturnValue(response.promise);
    const { result } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askSelection).toHaveBeenCalled());
    const requestId = result.current.drafts[0].request_id;
    act(() => handler({ request_id: requestId, kind: 'answer_delta', text: 'Partial answer' }));
    act(() => result.current.stop(requestId));
    expect(backend.cancelAiRequest).toHaveBeenCalledWith(requestId);
    act(() => handler({ request_id: requestId, kind: 'answer_delta', text: 'Late text' }));
    await act(async () => response.resolve(answer));
    expect(result.current.drafts[0]).toMatchObject({ answer: 'Partial answer', phase: 'incomplete', result: null });
    await act(async () => result.current.save(requestId));
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a request stopped while its event listener is registering', async () => {
    const listener = deferred<() => void>();
    vi.mocked(backend.onAiStream).mockReturnValue(listener.promise);
    const { result } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    act(() => result.current.stop(result.current.drafts[0].request_id));
    await act(async () => listener.resolve(unlisten));
    expect(backend.askSelection).not.toHaveBeenCalled();
    expect(backend.cancelAiRequest).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('cleans up late listener registration when the workspace unmounts', async () => {
    const listener = deferred<() => void>();
    vi.mocked(backend.onAiStream).mockReturnValue(listener.promise);
    const { result, unmount } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    unmount();
    await act(async () => listener.resolve(unlisten));
    expect(backend.askSelection).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('cancels an active request when the workspace unmounts', async () => {
    const response = deferred<AiAnswer>();
    vi.mocked(backend.askSelection).mockReturnValue(response.promise);
    const onSaved = vi.fn();
    const { result, unmount } = renderHook(() => useAiDrafts(onSaved));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askSelection).toHaveBeenCalled());
    const requestId = result.current.drafts[0].request_id;
    unmount();
    await act(async () => response.resolve(answer));
    expect(backend.cancelAiRequest).toHaveBeenCalledWith(requestId);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('preserves a partial response when streaming fails without creating an annotation', async () => {
    const response = deferred<AiAnswer>();
    vi.mocked(backend.askSelection).mockReturnValue(response.promise);
    const { result } = renderHook(() => useAiDrafts(vi.fn()));
    act(() => result.current.ask(paper, selection, 'Explain'));
    await waitFor(() => expect(backend.askSelection).toHaveBeenCalled());
    act(() => handler({ request_id: result.current.drafts[0].request_id, kind: 'answer_delta', text: 'Partial answer' }));
    await act(async () => response.reject(new Error('Connection lost')));
    expect(result.current.drafts[0]).toMatchObject({ answer: 'Partial answer', phase: 'incomplete', error: expect.stringContaining('Connection lost') });
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
  });
});
