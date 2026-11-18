// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import init from '../generated/doi_ai';
import { ApellAi, type AiInput, type AiRunEvent, type LlmHost } from './ai';
import { HostError, type LlmEvent, type LlmResult, type LlmRequest } from '../vendor/apell-sdk';
import type { PageAnchor } from '../../src/lib/types';
import type { PdfToolReader } from './ai';

beforeAll(async () => { await init({ module_or_path: readFileSync('applet/generated/doi_ai_bg.wasm') }); });

const input: AiInput = { source: 'Paper passage', history: [], question: 'Explain', mode: 'initial_answer' };
function result(request_id: string, overrides: Partial<LlmResult> = {}): LlmResult {
  return { request_id, content: 'Authoritative answer', status: 'completed', tool_calls: [], message: null,
    finish_reason: 'stop', error: null, provenance: { connection_id: 'connection', requested_model_id: 'alias', model_id: null }, ...overrides };
}
function fixture(generate: (request: LlmRequest, emit: (event: LlmEvent) => void) => Promise<LlmResult>) {
  const subscribers = new Set<(event: LlmEvent) => void>();
  let sequence = 0;
  const host: LlmHost = {
    createId: () => `request-${++sequence}`, cancel: vi.fn(async () => {}),
    subscribe(handler) { subscribers.add(handler); return () => { subscribers.delete(handler); }; },
    generate: vi.fn((request) => generate(request, (event) => subscribers.forEach((handler) => handler(event)))),
  };
  return { host, engine: new ApellAi(host), subscribers };
}

describe('compiled Rust WASM through the Apell LLM adapter', () => {
  it('continues tools with opaque metadata and retains unknown actual model attribution', async () => {
    const requests: LlmRequest[] = [];
    const { engine, subscribers } = fixture(async (request) => {
      requests.push(request);
      return requests.length === 1 ? result(request.request_id!, { status: 'tool_calls', message: { role: 'assistant', content: 'Authoritative answer', tool_calls: [{ id: 'call', name: 'propose_annotation', arguments: '{"content":"Draft"}' }], provider_state: { token: 'opaque' } },
        tool_calls: [{ id: 'call', name: 'propose_annotation', arguments: '{"content":"Draft"}' }] }) : result(request.request_id!);
    });
    const value = await engine.run('operation', input, () => {});
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-2)).toMatchObject({ role: 'assistant', provider_state: { token: 'opaque' } });
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call' });
    expect(value).toMatchObject({ answer: 'Authoritative answer', note_proposal: 'Draft', status: 'completed', provenance: { model_id: null } });
    expect(subscribers.size).toBe(0);
  });

  it('never puts reasoning into partial answers after a bridge failure', async () => {
    const { engine } = fixture(async (request, emit) => {
      emit({ request_id: request.request_id!, kind: 'reasoning_delta', text: 'private reasoning' });
      emit({ request_id: request.request_id!, kind: 'text_delta', text: 'partial' });
      throw new HostError('Disconnected', 'partial');
    });
    const value = await engine.run('operation', input, () => {});
    expect(value).toMatchObject({ answer: 'partial', status: 'failed', note_proposal: null });
  });

  it('cancels the active provider round and rejects a late completed draft', async () => {
    let release!: (value: LlmResult) => void;
    const { engine, host } = fixture(() => new Promise((resolve) => { release = resolve; }));
    const running = engine.run('operation', input, () => {});
    await engine.cancel('operation');
    release(result('request-1'));
    expect(await running).toMatchObject({ status: 'cancelled', note_proposal: null });
    expect(host.cancel).toHaveBeenCalledWith('request-1');
  });

  it('does not execute incomplete tool calls or replace an existing draft with plain text', async () => {
    const { engine } = fixture(async (request) => result(request.request_id!, { status: 'truncated', tool_calls: [{ id: 'call', name: 'propose_annotation', arguments: '{"content":"partial' }] }));
    expect(await engine.run('operation', input, () => {})).toMatchObject({ status: 'truncated', note_proposal: null });
    const second = fixture(async (request) => result(request.request_id!));
    expect(await second.engine.run('note', { ...input, mode: 'generate_note' }, () => {})).toMatchObject({ status: 'failed', note_proposal: null });
  });

  it('isolates concurrent event streams and rejects duplicate operation IDs', async () => {
    const pending = new Map<string, (value: LlmResult) => void>();
    const { engine, subscribers } = fixture((request) => new Promise((resolve) => pending.set(request.request_id!, resolve)));
    const first_events: AiRunEvent[] = []; const second_events: AiRunEvent[] = [];
    const first = engine.run('one', input, (event) => first_events.push(event));
    const second = engine.run('two', input, (event) => second_events.push(event));
    await expect(engine.run('one', input, () => {})).rejects.toThrow('already running');
    for (const handler of subscribers) handler({ request_id: 'request-2', kind: 'text_delta', text: 'two' });
    pending.get('request-1')!(result('request-1')); pending.get('request-2')!(result('request-2'));
    await Promise.all([first, second]);
    expect(first_events).toEqual([]);
    expect(second_events).toEqual([{ request_id: 'two', kind: 'text_delta', text: 'two' }]);
    expect(subscribers.size).toBe(0);
  });
});

function anchor(page_number: number, exact_text: string): PageAnchor {
  return { page_number, quad_points: [[0, 5, 10, 5, 10, 0, 0, 0]],
    text_quote: { exact_text, prefix: '', suffix: '', normalization_version: 1 } };
}

function toolCall(request: LlmRequest, name: string, args: unknown): LlmResult {
  const id = request.request_id!;
  const call = { id: 'call-' + id, name, arguments: JSON.stringify(args) };
  return result(id, { content: '', status: 'tool_calls', tool_calls: [call], message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: call.arguments } }],
    provider_state: { opaque_item: id },
  } });
}

describe('PDF reading with Apell tools', () => {
  const seed = anchor(2, 'A claim about the variance.');
  const evidence = anchor(8, 'The variance scales as 1/n.');

  it('searches and then reads from a follow-up, replaying both native messages and attaching only cited evidence', async () => {
    const { engine } = fixture(async request => {
      if (request.request_id === 'request-1') {
        expect(request.tools?.map(t => t.name)).toEqual(['search_document', 'read_page']);
        expect(request.messages[1].content).toContain('"source_id":"[S1]"');
        return toolCall(request, 'search_document', { query: 'variance' });
      }
      if (request.request_id === 'request-2') {
        expect(request.target).toEqual({ connection_id: 'connection', model_id: 'alias' });
        expect(request.messages.at(-2)?.provider_state).toEqual({ opaque_item: 'request-1' });
        expect(request.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-request-1' });
        expect(JSON.parse(String(request.messages.at(-1)?.content)).passages).toEqual([{source_id: '[S2]', page_number: 8, quote: evidence.text_quote.exact_text}]);
        return toolCall(request, 'read_page', { page_number: 8, offset: 0 });
      }
      expect(request.messages.at(-2)?.provider_state).toEqual({ opaque_item: 'request-2' });
      expect(request.target).toEqual({ connection_id: 'connection', model_id: 'alias' });
      return result(request.request_id!, {content: 'It scales inversely [S2]. Repeated [S2]. Invalid [S3].'});
    });
    const reader = vi.fn<PdfToolReader>(async () => ({passages: [evidence], message: 'Page 8.'}));
    const answer = await engine.run('operation', { ...input, mode: 'follow_up', initial_citations: [seed] }, () => {}, reader);
    expect(reader.mock.calls.map(([request]) => request)).toEqual([{name:'search_document',query:'variance'}, {name:'read_page',page_number:8,offset:0}]);
    expect(answer.citations).toEqual([{citation_id:'S2',anchor:evidence}]);
    expect(answer.answer).toBe('It scales inversely [S2]. Repeated [S2]. Invalid (unverified source).');
  });

  it('rejects invalid arguments before local execution and closes tools after a bounded number of rounds', async () => {
    let count = 0;
    const { engine } = fixture(async request => {
      count++;
      if (count === 1) return toolCall(request, 'read_page', {page_number: 1, path: 'another-file'});
      if (count === 2) expect(request.messages.at(-1)?.content).toContain('Invalid PDF tool');
      if (count <= 3) return toolCall(request, 'read_page', {page_number: 2});
      expect(request.tool_choice).toBe('none');
      expect(request.tools?.map(tool => tool.name)).toEqual(['search_document', 'read_page']);
      return toolCall(request, 'read_page', {page_number: 2});
    });
    const reader = vi.fn<PdfToolReader>(async () => ({passages: [seed], message: ''}));
    const answer = await engine.run('operation', input, () => {}, reader);
    expect(answer.status).toBe('failed');
    expect(count).toBe(4);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('cancels extraction and never starts the next generation', async () => {
    const { engine, host } = fixture(async (request, emit) => {
      emit({ request_id: request.request_id!, kind: 'text_delta', text: 'Let me check the paper.' });
      const response = toolCall(request, 'read_page', { page_number: 2 });
      response.content = 'Let me check the paper.';
      response.message!.content = response.content;
      return response;
    });
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const reader: PdfToolReader = async (_request, signal) => {
      began();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Stopped');
    };
    const events: AiRunEvent[] = [];
    const running = engine.run('op', input, event => events.push(event), reader);
    await started;
    expect(events).toEqual([
      { request_id: 'op', kind: 'text_delta', text: 'Let me check the paper.' },
      { request_id: 'op', kind: 'round_reset', text: '' },
    ]);
    await engine.cancel('op');
    expect(await running).toMatchObject({ status: 'cancelled', answer: '' });
    expect(host.generate).toHaveBeenCalledTimes(1);
  });

  it('can cite only the attached passage when the host reports unsupported tools', async () => {
    const { engine } = fixture(async request => {
      if (request.tools) return result(request.request_id!, {status:'unsupported', error:{code:'unsupported', message:'Tools unavailable', capability:'tools', retryable:false}});
      expect(request.messages[0].content).toContain('PDF search and page reading are unavailable');
      return result(request.request_id!, {content:'From the passage [S1].'});
    });
    const reader = vi.fn<PdfToolReader>();
    const answer = await engine.run('operation',{...input, mode:'follow_up', initial_citations:[seed]},() => {},reader);
    expect(answer.citations).toEqual([{citation_id:'S1',anchor:seed}]);
    expect(reader).not.toHaveBeenCalled();
  });
});
