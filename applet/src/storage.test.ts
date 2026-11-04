import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmResult, SqlValue } from '../vendor/apell-sdk/types';
import type { AiConversation, AiConversationRequest, Paper } from '../../src/lib/types';
import init from '../generated/doi_ai';

const fixture = vi.hoisted(() => ({ call: vi.fn(), generate: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock('../vendor/apell-sdk', () => ({
  hostCall: fixture.call,
  createId: () => randomUUID(),
  llm: { generate: fixture.generate, cancel: fixture.cancel },
  onLlmEvent: () => () => {},
  HostError: class extends Error { partial_content = ''; },
}));

import { Store, store } from './store';
import { askAiConversation, cancelAiRequest, generateAiConversationNote, listAiConversations, saveAiConversationNote } from './conversations';

const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
const paper: Paper = { paper_id: '2401.12345v1', arxiv_id: '2401.12345', arxiv_version: 1, title: 'Paper', authors: [], abstract: 'Abstract', pdf_url: 'https://arxiv.org/pdf/2401.12345v1', pdf_hash: 'a'.repeat(64), downloaded_at: '2026-10-31T00:00:00Z', last_location: null };
const request = (): AiConversationRequest => ({ request_id: randomUUID(), conversation_id: randomUUID(), question: 'Explain', source: { paper_id: paper.paper_id, pdf_hash: paper.pdf_hash, selected_text: 'Passage', context_text: '', page_anchors: [{ page_number: 1, quad_points: [[0, 10, 10, 10, 0, 0, 10, 0]], text_quote: { exact_text: 'Passage', prefix: '', suffix: '', normalization_version: 1 } }] } });
const response = (request: LlmRequest, overrides: Partial<LlmResult> = {}): LlmResult => ({ request_id: request.request_id!, content: 'Answer', tool_calls: [], message: null, status: 'completed', finish_reason: 'stop', provenance: { connection_id: 'connection', requested_model_id: 'alias', model_id: 'actual' }, error: null, ...overrides });

beforeAll(async () => {
  await init({ module_or_path: readFileSync('applet/generated/doi_ai_bg.wasm') });
  fixture.call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'sqlite.open') return { database_handle: 'database' };
    if (method === 'sqlite.begin') { database.exec('BEGIN IMMEDIATE'); return { transaction_handle: 'transaction' }; }
    if (method === 'sqlite.commit') { database.exec('COMMIT'); return null; }
    if (method === 'sqlite.rollback') { database.exec('ROLLBACK'); return null; }
    const sql = String(params.sql);
    const statement = database.prepare(sql);
    const values = (params.parameters as SqlValue[]).map((value) => value.type === 'null' ? null : value.type === 'integer' ? BigInt(value.value) : value.type === 'blob' ? Uint8Array.from(value.value) : value.value);
    if (method === 'sqlite.execute') { statement.run(...values); return { affected_rows: 1, last_insert_row_id: '0' }; }
    if (method === 'sqlite.query') {
      return { columns: statement.columns().map((column) => column.name), rows: statement.all(...values).map((row) => Object.values(row).map((value) => value === null ? { type: 'null' } : typeof value === 'number' ? { type: 'integer', value: String(value) } : { type: 'text', value })) };
    }
    throw new Error(`Unexpected method ${method}`);
  });
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

it('persists conversations and atomically saves an idempotent annotation with provenance', async () => {
  const first = request();
  const { conversation } = await askAiConversation(first);
  expect(conversation.turns[0].phase).toBe('complete');
  const note = conversation.note_draft!;
  const saved = await saveAiConversationNote(first.conversation_id, note.note_id, 'Reviewed note');
  const repeated = await saveAiConversationNote(first.conversation_id, note.note_id, 'Reviewed note');
  expect(repeated.annotation.annotation_id).toBe(saved.annotation.annotation_id);
  expect(saved.annotation.body).toMatchObject({ note_content: 'Reviewed note', llm_provenance: { connection_id: 'connection', model_id: 'actual' } });
  expect((await listAiConversations(paper.paper_id))[0].note_draft?.saved_annotation_id).toBe(saved.annotation.annotation_id);
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
