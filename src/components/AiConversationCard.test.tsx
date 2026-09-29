// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationView } from '../lib/useAiConversations';
import { AiConversationCard } from './AiConversationCard';

const view: AiConversationView = {
  conversation: {
    conversation_id: 'conversation-1',
    target: { paper_id: 'paper-1', pdf_hash: 'hash', page_anchors: [{ page_number: 3, quad_points: [], text_quote: { exact_text: 'Source text', prefix: '', suffix: '', normalization_version: 1 } }] },
    selected_text: 'Source text', context_text: 'Context', paper_title: 'Paper title',
    created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
    active_request_id: null, active_operation: null, note_draft: null,
    turns: [
      { turn_id: 'turn-1', question: 'First question', answer: 'First answer', phase: 'complete', provider_id: 'zai', model_id: 'glm-test', error: null, created_at: '2026-09-29T00:00:00Z' },
      { turn_id: 'turn-2', question: 'Second question', answer: 'Second answer', phase: 'complete', provider_id: 'zai', model_id: 'glm-test', error: null, created_at: '2026-09-29T00:00:00Z' },
    ],
  },
  history_persisted: true, unpersisted_turn_ids: [], thinking_by_turn: {}, note_thinking: '',
  status: '', error: null, pending: false, operation: null, note_content: '',
  persistence_state: 'saved', persistence_error: null, saving_note: false, collapsed: false,
};

function props(override: Partial<AiConversationView> = {}) {
  return {
    view: { ...view, ...override }, on_follow_up: vi.fn(), on_generate_note: vi.fn(), on_stop: vi.fn(),
    on_edit_note: vi.fn(), on_retry_note_persistence: vi.fn(), on_save_note: vi.fn(), on_toggle_collapsed: vi.fn(),
  };
}

function withNote(saved = false): AiConversationView {
  return { ...view, note_content: 'Editable takeaway', conversation: {
    ...view.conversation,
    note_draft: {
      note_id: 'note-1', content: 'Editable takeaway', answer: 'First answer', question: 'First question',
      provider_id: 'zai', model_id: 'glm-test', context_text: 'Context', created_at: '2026-09-29T00:00:00Z',
      saved_annotation_id: saved ? 'annotation-1' : null, source_turn_count: 1,
    },
  } };
}

afterEach(cleanup);

describe('AI conversation card', () => {
  it('shows durable questions, answers, and the original passage without fabricating thinking', () => {
    const callbacks = props();
    render(<AiConversationCard {...callbacks} />);
    expect(screen.getByRole('article', { name: 'AI conversation: First question' }).id).toBe('ai-conversation-conversation-1');
    expect(screen.getByRole('heading', { name: 'First question' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Second question' })).toBeTruthy();
    expect(screen.getByText('First answer')).toBeTruthy();
    expect(screen.getByText('Second answer')).toBeTruthy();
    expect(screen.getByText('Source text')).toBeTruthy();
    expect(screen.getByText('Source passage · p. 3')).toBeTruthy();
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
    expect(callbacks.on_generate_note).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate note' }));
    expect(callbacks.on_generate_note).toHaveBeenCalledTimes(1);
    expect(callbacks.on_save_note).not.toHaveBeenCalled();
  });

  it('submits and clears a follow-up only when accepted, then blurs the mobile editor', () => {
    const callbacks = props();
    callbacks.on_follow_up.mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AiConversationCard {...callbacks} />);
    const textarea = screen.getByRole('textbox', { name: 'Follow-up question' }) as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.change(textarea, { target: { value: 'How does it compare?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
    expect(textarea.value).toBe('How does it compare?');
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
    expect(callbacks.on_follow_up).toHaveBeenCalledWith('How does it compare?');
    expect(textarea.value).toBe('');
    expect(document.activeElement).not.toBe(textarea);
  });

  it('offers editable note review, an explicit save, persistence retry, and an older-history notice', () => {
    const callbacks = props({ ...withNote(), persistence_state: 'error', persistence_error: 'Your edit is still here, but could not be stored.' });
    render(<AiConversationCard {...callbacks} />);
    expect(screen.getByText(/Based on 1 of 2 completed answers/)).toBeTruthy();
    const note = screen.getByRole('textbox', { name: 'Suggested note' });
    fireEvent.change(note, { target: { value: 'My own wording' } });
    expect(callbacks.on_edit_note).toHaveBeenCalledWith('My own wording');
    expect(callbacks.on_save_note).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry storing draft' }));
    expect(callbacks.on_retry_note_persistence).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(callbacks.on_save_note).toHaveBeenCalledTimes(1);
  });

  it('makes saved notes read-only and permits generating a new note without duplicating Save', () => {
    const callbacks = props(withNote(true));
    render(<AiConversationCard {...callbacks} />);
    const note = screen.getByRole('textbox', { name: 'Saved note' }) as HTMLTextAreaElement;
    expect(note.readOnly).toBe(true);
    const save = screen.getByRole('button', { name: 'Saved' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(callbacks.on_save_note).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new note' }));
    expect(callbacks.on_generate_note).toHaveBeenCalledTimes(1);
  });

  it('collapses history without deleting it and keeps Stop accessible while collapsed', () => {
    const callbacks = props({ collapsed: true, pending: true, operation: 'answer', status: 'Answering…' });
    const { rerender } = render(<AiConversationCard {...callbacks} />);
    expect(screen.getByRole('button', { name: /Expand conversation/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'Follow-up question' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(callbacks.on_stop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Expand conversation/ }));
    expect(callbacks.on_toggle_collapsed).toHaveBeenCalledTimes(1);
    rerender(<AiConversationCard {...callbacks} view={{ ...callbacks.view, collapsed: false }} />);
    expect(screen.getByText('First answer')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Follow-up question' }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('distinguishes transient received thinking and an unstored incomplete question', () => {
    const callbacks = props({
      thinking_by_turn: { 'turn-1': 'Actual streamed reasoning' }, unpersisted_turn_ids: ['turn-2'],
      conversation: { ...view.conversation, turns: [view.conversation.turns[0], { ...view.conversation.turns[1], phase: 'incomplete', error: 'Listener unavailable' }] },
    });
    render(<AiConversationCard {...callbacks} />);
    expect(screen.getByText('Actual streamed reasoning')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('This question was not stored. Send it again to continue.')).toBeTruthy();
    expect(screen.getByText('Response incomplete: Listener unavailable')).toBeTruthy();
  });
});
