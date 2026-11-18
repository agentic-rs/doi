import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmResult } from '../vendor/apell-sdk/types';
import type { AiConversation, AiConversationRequest, Paper } from '../../src/lib/types';
import init, { hashBytes } from '../generated/doi_ai';
import { makePdf } from './test-pdf';
import { sqliteCall } from './test-sqlite';
import { parseAnnotationSidecar, serializeAnnotations } from '../../src/lib/annotations';

const fixture = vi.hoisted(() => ({ call: vi.fn(), generate: vi.fn(), read: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock('../vendor/apell-sdk', () => ({
  hostCall: fixture.call,
  createId: () => randomUUID(),
  fs: { read: fixture.read },
  llm: { generate: fixture.generate, cancel: fixture.cancel },
  onLlmEvent: () => () => {},
  HostError: class extends Error { partial_content = ''; },
}));

import { Store, store } from './store';
import { askAiConversation, cancelAiRequest, generateAiConversationNote, listAiConversations, saveAiConversationNote, saveAiTurnNote, updateAiTurnNoteDraft } from './conversations';
import { deleteAnnotation, listAnnotations, saveAnnotation } from './library';

const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
const paper: Paper = { paper_id: '2401.12345v1', arxiv_id: '2401.12345', arxiv_version: 1, title: 'Paper', authors: [], abstract: 'Abstract', pdf_url: 'https://arxiv.org/pdf/2401.12345v1', pdf_hash: 'a'.repeat(64), downloaded_at: '2026-10-31T00:00:00Z', last_location: null };
const request = (): AiConversationRequest => ({ request_id: randomUUID(), conversation_id: randomUUID(), question: 'Explain', source: { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, selected_text: 'Passage', context_text: '', page_anchors: [{ page_number: 1, quad_points: [[0, 10, 10, 10, 10, 0, 0, 0]], text_quote: { exact_text: 'Passage', prefix: '', suffix: '', normalization_version: 1 } }] } });
const response = (request: LlmRequest, overrides: Partial<LlmResult> = {}): LlmResult => ({ request_id: request.request_id!, content: 'Answer', tool_calls: [], message: null, status: 'completed', finish_reason: 'stop', provenance: { connection_id: 'connection', requested_model_id: 'alias', model_id: 'actual' }, error: null, ...overrides });

beforeAll(async () => {
  await init({ module_or_path: readFileSync('applet/generated/doi_ai_bg.wasm') });
  fixture.call.mockImplementation(async (method, params) => sqliteCall(database, method, params));
});
beforeEach(async () => {
  fixture.generate.mockReset();
  fixture.generate.mockImplementation(async (request: LlmRequest) => response(request));
  await store.transaction(async (db) => { await db.execute('DELETE FROM documents'); await db.put('paper', paper.paper_id, paper.paper_id, paper); });
});
afterAll(() => database.close());

it('round-trips multi-chunk Unicode documents and rolls back failed replacements', async () => {
  const value = { text: '😀字'.repeat(100_000) };
  await store.transaction((db) => db.put('test', 'id', paper.paper_id, value));
  expect(await store.transaction((db) => db.get('test', 'id'))).toEqual(value);
  await expect(store.transaction(async (db) => { await db.put('test', 'id', paper.paper_id, { text: 'replacement' }); throw new Error('Failure'); })).rejects.toThrow('Failure');
  expect(await store.transaction((db) => db.get('test', 'id'))).toEqual(value);
  const reopened = new Store();
  expect(await reopened.transaction((db) => db.get('test', 'id'))).toEqual(value);
});

it('still saves a legacy suggested note together with its original answer and provenance', async () => {
  const first = request();
  const { conversation } = await askAiConversation(first);
  expect(conversation.turns[0].phase).toBe('complete');
  // Simulate a draft carried forward from the previous applet version.
  const note = { note_id: 'old-draft', content: 'Suggestion', answer: 'Full answer', question: 'Explain', provider_id: 'connection',
    model_id: 'actual', context_text: 'Passage', created_at: conversation.created_at, saved_annotation_id: null, source_turn_count: 1,
    llm_provenance: conversation.turns[0].llm_provenance };
  await store.transaction(db => db.put('conversation', first.conversation_id, paper.paper_id, { ...conversation, note_draft: note }));
  const saved = await saveAiConversationNote(first.conversation_id, note.note_id, 'Reviewed note');
  const repeated = await saveAiConversationNote(first.conversation_id, note.note_id, 'Reviewed note');
  expect(repeated.annotation.annotation_id).toBe(saved.annotation.annotation_id);
  expect(saved.annotation.body).toMatchObject({ note_content: 'Reviewed note', llm_provenance: { connection_id: 'connection', model_id: 'actual' } });
  expect((await listAiConversations(paper.paper_id))[0].note_draft?.saved_annotation_id).toBe(saved.annotation.annotation_id);
});

it('reads another PDF page via Apell, pins the edited takeaway and reopens its independent source', async () => {
  const bytes = makePdf([['Opening claim.'], ['Evidence on the second page.']]);
  const revision = { ...paper, pdf_hash: hashBytes(bytes) };
  await store.transaction(async db => {
    await db.put('paper', revision.paper_id, revision.paper_id, revision);
    await db.put('pdf', revision.paper_id, revision.paper_id, { paths: ['fixture/0'], size_bytes: bytes.length });
  });
  fixture.read.mockResolvedValue({ bytes: Array.from(bytes), eof: true });
  const first = request();
  first.source = { ...first.source!, selected_text: 'Opening claim.', pdf_hash: revision.pdf_hash };
  first.source.page_anchors[0].text_quote.exact_text = first.source.selected_text;
  fixture.generate.mockImplementationOnce(async (r: LlmRequest) => {
    expect(r.tools?.map(t => t.name)).toContain('search_document');
    const call = { id: 'lookup', name: 'search_document', arguments: JSON.stringify({ query: 'evidence' }) };
    return response(r, { status: 'tool_calls', content: '', tool_calls: [call], message: { role: 'assistant', content: '',
      tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } });
  }).mockImplementationOnce(async (r: LlmRequest) => {
    const passages = JSON.parse(String(r.messages.at(-1)?.content)).passages;
    expect(passages[0]).toMatchObject({ quote: 'Evidence on the second page.', page_number: 2 });
    return response(r, { content: `The authors supply the evidence here ${passages[0].source_id}.` });
  });
  const { conversation } = await askAiConversation(first);
  const [turn] = conversation.turns;
  const [citation] = turn.citations!;
  expect(citation.anchor.page_number).toBe(2);
  expect(citation.anchor.quad_points.length).toBeGreaterThan(0);
  expect(await listAnnotations(paper.paper_id)).toEqual([]);
  const args = [conversation.conversation_id, turn.turn_id] as const;
  const updated = await updateAiTurnNoteDraft(...args, 'Revised takeaway', conversation.target);
  expect(updated.turns[0].note?.saved_annotation_id).toBeNull();
  const pinned = await saveAiTurnNote(...args, 'Revised takeaway', conversation.target);
  const [reopened] = await listAiConversations(paper.paper_id);
  expect(reopened.turns[0].note?.saved_annotation_id).toBe(pinned.annotation.annotation_id);
  expect(pinned.annotation.target.page_anchors[0].page_number).toBe(1);
  expect(pinned.annotation.body).toMatchObject({ kind: 'note', content: 'Revised takeaway', citations: [citation],
    origin: { conversation_id: conversation.conversation_id, turn_id: turn.turn_id } });
  expect(pinned.annotation.body).not.toHaveProperty('answer');
  const exported = serializeAnnotations(revision, await listAnnotations(paper.paper_id));
  expect(parseAnnotationSidecar(exported, revision)).toEqual([pinned.annotation]);
  const whole_paper = { ...conversation.target, page_anchors: [], scope: 'paper' as const };
  const moved = await saveAiTurnNote(...args, 'Paper-wide takeaway', whole_paper);
  expect(moved.annotation.annotation_id).toBe(pinned.annotation.annotation_id);
  expect(await listAnnotations(paper.paper_id)).toHaveLength(1);
  await saveAnnotation({ ...moved.annotation, body: { ...moved.annotation.body, kind: 'note', content: 'Edited from Notes' } });
  expect((await listAiConversations(paper.paper_id))[0].turns[0].note?.content).toBe('Edited from Notes');
  await expect(saveAiTurnNote(...args, 'Invalid', { ...whole_paper, pdf_hash: paper.pdf_hash })).rejects.toThrow(/revision/);
  await deleteAnnotation(moved.annotation.annotation_id);
  expect((await listAiConversations(paper.paper_id))[0].turns[0].note).toBeUndefined();
});

it('starts with a whole paper and scopes a subsequent passage to its question and revision', async () => {
  const start = request();
  const selection = start.source!;
  start.source = { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, selected_text: '', context_text: '', page_anchors: [] };
  const { conversation } = await askAiConversation(start);
  expect(conversation.target).toMatchObject({ scope: 'paper', page_anchors: [] });
  fixture.generate.mockImplementationOnce(async (r: LlmRequest) => {
    expect(r.messages[1].content).toContain(selection.selected_text);
    return response(r, { content: 'Relevant passage [S1].' });
  });
  const follow = { conversation_id: start.conversation_id, request_id: randomUUID(), question: 'What about this?', attachments: [selection] };
  const answer = await askAiConversation(follow);
  expect(answer.conversation.turns[0].attachments).toEqual([]);
  expect(answer.conversation.turns[1]).toMatchObject({ attachments: [selection], citations: [{ citation_id: 'S1', anchor: selection.page_anchors[0] }] });
  await expect(askAiConversation({ ...follow, request_id: randomUUID(), attachments: [{ ...selection, pdf_hash: 'b'.repeat(64) }] })).rejects.toThrow(/revision/);
  expect((await listAiConversations(paper.paper_id))[0].turns).toHaveLength(2);
});

it('retains a previous note when generation fails and excludes interrupted history', async () => {
  const first = request();
  const initial = await askAiConversation(first);
  fixture.generate.mockImplementationOnce(async (request: LlmRequest) => response(request, { status: 'truncated', content: 'Partial' }));
  await expect(askAiConversation({ conversation_id: first.conversation_id, request_id: randomUUID(), question: 'Follow up' })).rejects.toThrow();
  fixture.generate.mockImplementationOnce(async (request: LlmRequest) => {
    expect(request.messages.some((message) => message.content === 'Partial')).toBe(false);
    return response(request, { status: 'unsupported', error: { code: 'unsupported_capability', message: 'No tools', retryable: false } });
  });
  await expect(generateAiConversationNote(randomUUID(), first.conversation_id)).rejects.toThrow('No tools');
  const [stored] = await listAiConversations(paper.paper_id);
  expect(stored.note_draft).toEqual(initial.conversation.note_draft);
  expect(stored.turns[1]).toMatchObject({ phase: 'incomplete', answer: 'Partial' });
  expect(stored.active_request_id).toBeNull();
});

it('recovers pending turns after applet restart', async () => {
  const first = request();
  const initial = await askAiConversation(first);
  await store.transaction(async (db) => {
    const conversation = initial.conversation;
    conversation.turns[0].phase = 'pending';
    conversation.active_request_id = 'interrupted'; conversation.active_operation = 'answer';
    await db.put('conversation', first.conversation_id, paper.paper_id, conversation);
  });
  expect((await listAiConversations(paper.paper_id))[0]).toMatchObject({ active_request_id: null, turns: [{ phase: 'incomplete' }] });
});

it('does not resurrect a deleted paper when an answer arrives late', async () => {
  let complete!: (value: LlmResult) => void;
  let current!: LlmRequest;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  fixture.generate.mockImplementation((request: LlmRequest) => { current = request; started(); return new Promise((resolve) => { complete = resolve; }); });
  const first = request();
  const running = askAiConversation(first);
  const rejected = expect(running).rejects.toThrow('no longer available');
  await ready;
  await store.transaction((db) => db.execute('DELETE FROM documents WHERE paper_id=?', [paper.paper_id]));
  complete(response(current));
  await rejected;
  expect(await store.transaction((db) => db.list<AiConversation>('conversation'))).toEqual([]);
});

it('honors cancellation while waiting for the storage transaction', async () => {
  const first = request();
  const running = askAiConversation(first);
  const rejected = expect(running).rejects.toThrow('stopped');
  await cancelAiRequest(first.request_id);
  await rejected;
  expect(fixture.generate).not.toHaveBeenCalled();
  expect((await listAiConversations(paper.paper_id))[0].turns[0].phase).toBe('incomplete');
});
