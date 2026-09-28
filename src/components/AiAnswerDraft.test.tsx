// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiDraft } from '../lib/useAiDrafts';
import { AiAnswerDraft } from './AiAnswerDraft';

const draft: AiDraft = {
  request_id: 'request-1', paper: { paper_id: 'paper-1', pdf_hash: 'hash', title: 'Original paper' },
  selection: { selected_text: 'Original passage', context_text: 'Nearby text', page_anchors: [{
    page_number: 3, quad_points: [[1, 2, 3, 2, 3, 1, 1, 1]],
    text_quote: { exact_text: 'Original passage', prefix: '', suffix: '', normalization_version: 1 },
  }] },
  question: 'What does this mean?', created_at: '2026-09-28T00:00:00Z', phase: 'pending',
  status: 'Connecting…', thinking: '', answer: '', result: null,
  note_content: '', error: null, save_state: 'idle', save_error: null,
};
const callbacks = () => ({ on_stop: vi.fn(), on_edit: vi.fn(), on_save: vi.fn(), on_dismiss: vi.fn() });
afterEach(cleanup);

describe('AI answer preview', () => {
  it('shows activity and Stop without inventing thinking, then exposes received thinking in a collapsible section', () => {
    const actions = callbacks();
    const view = render(<AiAnswerDraft draft={draft} {...actions} />);
    expect(screen.getByRole('status').textContent).toContain('Connecting…');
    expect(screen.queryByText('Thinking')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(actions.on_stop).toHaveBeenCalledTimes(1);
    view.rerender(<AiAnswerDraft draft={{ ...draft, thinking: 'Provider reasoning', status: 'Thinking…' }} {...actions} />);
    const disclosure = screen.getByText('Thinking').closest('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Provider reasoning');
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  });

  it('shows a model proposal for review and explicitly saves edited content', () => {
    const actions = callbacks();
    const result = { answer: 'A detailed answer', thinking: '', note_proposal: 'A takeaway', proposal_warning: null, provider_id: 'local', model_id: 'model', context_text: 'Context' };
    const view = render(<AiAnswerDraft draft={{ ...draft, phase: 'complete', status: 'Answer ready', answer: result.answer, note_content: result.note_proposal, result }} {...actions} />);
    expect(screen.getByText('A detailed answer')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Suggested note'), { target: { value: 'Edited takeaway' } });
    expect(actions.on_edit).toHaveBeenCalledWith('Edited takeaway');
    expect(actions.on_save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(actions.on_save).toHaveBeenCalledTimes(1);
    view.rerender(<AiAnswerDraft draft={{ ...draft, phase: 'complete', status: 'Answer ready', answer: result.answer, note_content: 'Edited takeaway', result, save_state: 'saved' }} {...actions} />);
    expect((screen.getByRole('button', { name: 'Saved' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Suggested note') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('makes a missing proposal understandable and keeps a failed-save retry separate from asking', () => {
    const actions = callbacks();
    const result = { answer: 'A detailed answer', thinking: '', note_proposal: null, proposal_warning: 'This model does not support tool calls.', provider_id: 'local', model_id: 'model', context_text: 'Context' };
    render(<AiAnswerDraft draft={{ ...draft, phase: 'complete', status: 'Answer ready', answer: result.answer, note_content: result.answer, result, save_error: 'Disk unavailable' }} {...actions} />);
    expect((screen.getByLabelText('Note to save') as HTMLTextAreaElement).value).toBe(result.answer);
    expect(screen.getByText('This model does not support tool calls.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Disk unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(actions.on_save).toHaveBeenCalledTimes(1);
  });

  it('labels interrupted answers incomplete and preserves them without a save action', () => {
    render(<AiAnswerDraft draft={{ ...draft, phase: 'incomplete', status: 'Stopped · response incomplete', answer: 'Partial answer' }} {...callbacks()} />);
    expect(screen.getByText('Partial answer')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('incomplete');
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  });
});
