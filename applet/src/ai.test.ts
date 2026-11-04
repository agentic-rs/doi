// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import init from '../generated/doi_ai';
import { ApellAi, type AiInput, type LlmHost } from './ai';
import { HostError, type LlmEvent, type LlmResult, type LlmRequest } from '../vendor/apell-sdk';

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
    const first_events: LlmEvent[] = []; const second_events: LlmEvent[] = [];
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
