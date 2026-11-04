import type { AiConversation, AiConversationRequest, AiNoteDraft, Annotation, Paper, AiConversationResponse } from '../../src/lib/types';
import { createId } from '../vendor/apell-sdk';
import { validateAnnotation } from '../../src/lib/annotations';
import { ApellAi, type AiCompletion, type AiInput } from './ai';
import { store, type Store } from './store';
import { requirePaper } from './library';
import { ai_events } from './events';

const engine = new ApellAi();
const active = new Map<string, string>();
const cancelled = new Set<string>();
const now = () => new Date().toISOString();
const NOTE_QUESTION = 'Create one concise, self-contained note from this conversation using propose_annotation. Do not save anything.';

function text(value: string, limit = 128 * 1024, empty = false) {
  if ((!empty && !value.trim()) || value.includes('\0') || new TextEncoder().encode(value).byteLength > limit) {
    throw new Error('The text is empty, invalid, or too long.');
  }
}
function idle(conversation: AiConversation) {
  if (conversation.active_request_id) throw new Error('Wait for this conversation to finish its current request.');
}
async function get(db: Store, id: string): Promise<AiConversation> {
  const conversation = await db.get<AiConversation>('conversation', id);
  if (!conversation) throw new Error('This conversation is no longer available.');
  const paper = await requirePaper(db, conversation.target.paper_id);
  if (paper.pdf_hash !== conversation.target.pdf_hash) throw new Error('The conversation belongs to another PDF revision.');
  return conversation;
}
async function persist(db: Store, conversation: AiConversation) {
  conversation.updated_at = now();
  if (new TextEncoder().encode(JSON.stringify(conversation)).byteLength > 4 * 1024 * 1024) throw new Error('The conversation has reached its storage limit.');
  await db.put('conversation', conversation.conversation_id, conversation.target.paper_id, conversation);
}

export const listAiConversations = (paper_id: string) => store.transaction(async (db) => {
  const conversations = await db.list<AiConversation>('conversation', paper_id);
  for (const conversation of conversations) {
    // Recover after host close/reload without interrupting another live operation.
    if (conversation.active_request_id && !active.has(conversation.active_request_id)) {
      for (const turn of conversation.turns) if (turn.phase === 'pending') {
        turn.phase = 'incomplete'; turn.error = 'The applet closed before this answer finished.';
      }
      conversation.active_request_id = null;
      conversation.active_operation = null;
      await persist(db, conversation);
    }
  }
  return conversations.sort((a, b) => a.created_at.localeCompare(b.created_at));
});

function source(paper: Paper, conversation: AiConversation) {
  return `Paper: ${paper.title}\narXiv revision: ${paper.paper_id}\nAuthors: ${paper.authors.join(', ')}\nAbstract: ${paper.abstract}\n\nSelected passage:\n${conversation.selected_text}\n\nNearby context supplied by the reader:\n${conversation.context_text}`;
}

function draft(completion: AiCompletion, content: string, answer: string, question: string, context_text: string, source_turn_count: number): AiNoteDraft {
  text(content); text(answer);
  const provenance = completion.note_provenance ?? completion.provenance;
  return { note_id: createId(), content, answer, question, context_text, source_turn_count,
    provider_id: provenance.connection_id, model_id: provenance.model_id ?? provenance.requested_model_id,
    llm_provenance: provenance, created_at: now(), saved_annotation_id: null };
}

async function run(request_id: string, input: AiInput): Promise<{ completion: AiCompletion; thinking: string }> {
  if (cancelled.has(request_id)) throw new Error('The AI request was stopped.');
  let thinking = '';
  const completion = await engine.run(request_id, input, (event) => {
    if (event.kind === 'reasoning_delta') thinking = (thinking + event.text).slice(0, 128 * 1024);
    ai_events.emit({ request_id, kind: event.kind === 'reasoning_delta' ? 'thinking_delta'
      : event.kind === 'text_delta' ? 'answer_delta' : 'status', text: event.kind === 'started' ? 'Waiting for the model…' : event.text });
  });
  return { completion, thinking };
}

export async function askAiConversation(request: AiConversationRequest): Promise<AiConversationResponse> {
  text(request.question, 8192);
  if (active.has(request.request_id)) throw new Error('That request is already running.');
  active.set(request.request_id, request.source?.paper_id ?? '');
  let began = false;
  try {
    const { conversation, paper } = await store.transaction(async (db) => {
      let conversation = await db.get<AiConversation>('conversation', request.conversation_id);
      if (conversation && request.source) throw new Error('Start a new conversation for another selection.');
      if (!conversation) {
        if (!request.source) throw new Error('Select a passage to start this conversation.');
        const s = request.source;
        text(s.selected_text, 32 * 1024); text(s.context_text, 128 * 1024, true);
        const paper = await requirePaper(db, s.paper_id);
        const target = { paper_id: s.paper_id, pdf_hash: s.pdf_hash, page_anchors: s.page_anchors };
        validateAnnotation({ schema_version: 1, annotation_id: 'validation', target, body: { kind: 'note', content: 'validation' }, created_at: now(), updated_at: now() }, paper);
        conversation = { conversation_id: request.conversation_id, target, selected_text: s.selected_text,
          context_text: s.context_text, paper_title: paper.title, created_at: now(), updated_at: now(),
          turns: [], note_draft: null, active_request_id: null, active_operation: null };
      }
      idle(conversation);
      const paper = await requirePaper(db, conversation.target.paper_id);
      if (paper.pdf_hash !== conversation.target.pdf_hash) throw new Error('The conversation belongs to another PDF revision.');
      if (conversation.turns.length >= 64) throw new Error('Start a new conversation after 64 questions.');
      if (conversation.turns.some((turn) => turn.turn_id === request.request_id)) throw new Error('That question was already submitted.');
      if (new TextEncoder().encode(JSON.stringify(conversation)).byteLength > 3 * 1024 * 1024) throw new Error('Start a new conversation; this one has reached its storage limit.');
      conversation.turns.push({ turn_id: request.request_id, question: request.question, answer: '', phase: 'pending', provider_id: '', model_id: '', error: null, created_at: now() });
      conversation.active_request_id = request.request_id;
      conversation.active_operation = 'answer';
      await persist(db, conversation);
      active.set(request.request_id, paper.paper_id);
      return { conversation, paper };
    });
    began = true;
    const context = source(paper, conversation);
    const { completion, thinking } = await run(request.request_id, { source: context,
      history: conversation.turns.filter((t) => t.phase === 'complete').map((t) => [t.question, t.answer]),
      question: request.question, mode: conversation.turns.length === 1 ? 'initial_answer' : 'follow_up' });
    const saved = await store.transaction(async (db) => {
      const current = await get(db, request.conversation_id);
      if (current.active_request_id !== request.request_id) throw new Error('This answer is no longer active.');
      const turn = current.turns.find((t) => t.turn_id === request.request_id)!;
      turn.answer = completion.answer;
      turn.phase = completion.status === 'completed' ? 'complete' : 'incomplete';
      turn.error = completion.status === 'completed' ? null : completion.error?.message ?? 'The answer was interrupted.';
      turn.provider_id = completion.provenance.connection_id;
      turn.model_id = completion.provenance.model_id ?? completion.provenance.requested_model_id;
      turn.llm_provenance = completion.provenance;
      if (current.turns.length === 1 && completion.status === 'completed') {
        current.note_draft = draft(completion, completion.note_proposal ?? completion.answer, completion.answer, request.question, context, 1);
      }
      current.active_request_id = null; current.active_operation = null;
      await persist(db, current);
      return current;
    });
    began = false;
    if (completion.status !== 'completed') throw new Error(completion.error?.message ?? 'The answer was interrupted.');
    return { conversation: saved, thinking };
  } catch (error) {
    if (began) await clearFailed(request.conversation_id, request.request_id, String(error));
    throw error;
  } finally { active.delete(request.request_id); cancelled.delete(request.request_id); }
}

async function clearFailed(conversation_id: string, request_id: string, message: string) {
  await store.transaction(async (db) => {
    const current = await db.get<AiConversation>('conversation', conversation_id);
    if (!current || current.active_request_id !== request_id) return;
    const turn = current.turns.find((t) => t.turn_id === request_id);
    if (turn?.phase === 'pending') { turn.phase = 'incomplete'; turn.error = message; }
    current.active_request_id = null; current.active_operation = null;
    await persist(db, current);
  });
}

export async function generateAiConversationNote(request_id: string, conversation_id: string): Promise<AiConversationResponse> {
  if (active.has(request_id)) throw new Error('That request is already running.');
  active.set(request_id, '');
  try {
    const { conversation, paper } = await store.transaction(async (db) => {
      const conversation = await get(db, conversation_id);
      idle(conversation);
      if (!conversation.turns.some((t) => t.phase === 'complete')) throw new Error('Wait for a complete answer before generating a note.');
      const paper = await requirePaper(db, conversation.target.paper_id);
      conversation.active_request_id = request_id; conversation.active_operation = 'note';
      await persist(db, conversation);
      active.set(request_id, paper.paper_id);
      return { conversation, paper };
    });
    const history: [string, string][] = conversation.turns.filter((t) => t.phase === 'complete').map((t) => [t.question, t.answer]);
    const context = source(paper, conversation);
    const { completion, thinking } = await run(request_id, { source: context, history, question: NOTE_QUESTION, mode: 'generate_note' });
    if (completion.status !== 'completed' || !completion.note_proposal) throw new Error(completion.error?.message ?? 'No valid note was returned. Your existing draft is unchanged.');
    const saved = await store.transaction(async (db) => {
      const current = await get(db, conversation_id);
      if (current.active_request_id !== request_id) throw new Error('This note request is no longer active.');
      current.note_draft = draft(completion, completion.note_proposal!, history.map(([q, a]) => `Question: ${q}\nAnswer: ${a}`).join('\n\n'), history[0][0], context, history.length);
      current.active_request_id = null; current.active_operation = null;
      await persist(db, current);
      return current;
    });
    return { conversation: saved, thinking };
  } catch (error) {
    await clearFailed(conversation_id, request_id, String(error));
    throw error;
  } finally { active.delete(request_id); cancelled.delete(request_id); }
}

function matchingDraft(conversation: AiConversation, note_id: string) {
  idle(conversation);
  if (!conversation.note_draft || conversation.note_draft.note_id !== note_id) throw new Error('This note draft has changed. Reopen the conversation.');
  return conversation.note_draft;
}
export const updateAiConversationNote = (conversation_id: string, note_id: string, content: string) => store.transaction(async (db) => {
  text(content, 128 * 1024, true);
  const conversation = await get(db, conversation_id);
  const note = matchingDraft(conversation, note_id);
  if (note.saved_annotation_id) throw new Error('This note is already saved.');
  note.content = content;
  await persist(db, conversation);
  return conversation;
});

export const saveAiConversationNote = (conversation_id: string, note_id: string, content: string) => store.transaction(async (db) => {
  text(content);
  const conversation = await get(db, conversation_id);
  const note = matchingDraft(conversation, note_id);
  if (note.saved_annotation_id) {
    const annotation = await db.get<Annotation>('annotation', note.saved_annotation_id);
    if (!annotation) throw new Error('The saved annotation was removed. Generate a new draft.');
    return { conversation, annotation };
  }
  const annotation: Annotation = { schema_version: 1, annotation_id: createId(), target: conversation.target,
    body: { kind: 'ai_answer', question: note.question, answer: note.answer, note_content: content,
      provider_id: note.provider_id, model_id: note.model_id, context_text: note.context_text, llm_provenance: note.llm_provenance },
    created_at: now(), updated_at: now() };
  validateAnnotation(annotation, await requirePaper(db, conversation.target.paper_id));
  await db.put('annotation', annotation.annotation_id, conversation.target.paper_id, annotation);
  note.content = content; note.saved_annotation_id = annotation.annotation_id;
  await persist(db, conversation);
  return { conversation, annotation };
});

export async function cancelAiRequest(request_id: string) {
  if (active.has(request_id)) cancelled.add(request_id);
  await engine.cancel(request_id);
}
export async function cancelPaperAi(paper_id: string) {
  await Promise.all([...active].filter(([, id]) => id === paper_id).map(([request_id]) => cancelAiRequest(request_id)));
}
