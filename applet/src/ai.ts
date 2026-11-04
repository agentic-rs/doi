import { AiWorkflow } from '../generated/doi_ai';
import { createId, HostError, llm } from '../vendor/apell-sdk';
import type { LlmEvent, LlmProvenance, LlmRequest, LlmResult, LlmStatus, LlmFailure } from '../vendor/apell-sdk';

export interface AiInput {
  source: string;
  history: [string, string][];
  question: string;
  mode: 'initial_answer' | 'follow_up' | 'generate_note';
}

export interface AiCompletion {
  answer: string;
  note_proposal: string | null;
  proposal_warning: string | null;
  provenance: LlmProvenance;
  note_provenance: LlmProvenance | null;
  status: LlmStatus;
  error: LlmFailure | null;
}

type WorkflowStep = { kind: 'continue' } | { kind: 'finished'; completion: AiCompletion };

export interface LlmHost {
  generate: (request: LlmRequest, options?: { on_event?: (event: LlmEvent) => void }) => Promise<LlmResult>;
  cancel: (request_id: string) => Promise<unknown>;
  subscribe: (handler: (event: LlmEvent) => void) => () => void;
  createId: () => string;
}

const event_handlers = new Set<(event: LlmEvent) => void>();
const apell_host: LlmHost = {
  generate: (request) => llm.generate({ ...request, stream: true }, { on_event: (event) => {
    for (const handler of event_handlers) handler(event);
  } }),
  cancel: llm.cancel,
  subscribe(handler) { event_handlers.add(handler); return () => { event_handlers.delete(handler); }; },
  createId,
};

/** Initialize the WASM module before creating a runner. No credentials cross this boundary. */
export class ApellAi {
  private readonly operations = new Map<string, { request_id: string | null; cancelled: boolean }>();

  constructor(private readonly host: LlmHost = apell_host) {}

  async cancel(operation_id: string): Promise<void> {
    const operation = this.operations.get(operation_id);
    if (!operation) return;
    operation.cancelled = true;
    if (operation.request_id) await this.host.cancel(operation.request_id);
  }

  async run(operation_id: string, input: AiInput, on_event: (event: LlmEvent) => void): Promise<AiCompletion> {
    if (this.operations.has(operation_id)) throw new Error('That AI operation is already running.');
    const workflow = new AiWorkflow(input);
    const operation = { request_id: null as string | null, cancelled: false };
    this.operations.set(operation_id, operation);
    let provenance: LlmProvenance = { connection_id: '', requested_model_id: '', model_id: null };
    let partial = '';
    const unsubscribe = this.host.subscribe((event) => {
      if (event.request_id !== operation.request_id) return;
      if (event.provenance) provenance = event.provenance;
      if (event.kind === 'text_delta') partial += event.text;
      // Tool fragments and terminal events never authorize side effects here.
      // The Rust policy consumes the authoritative result after generate resolves.
      if (event.kind === 'text_delta' || event.kind === 'reasoning_delta' || event.kind === 'started') {
        on_event({ ...event, request_id: operation_id });
      }
    });
    try {
      // One initial turn plus one tool continuation or text-only fallback.
      for (let round = 0; round < 2; round += 1) {
        if (operation.cancelled) return interrupted('cancelled', partial, provenance);
        partial = '';
        const request_id = this.host.createId();
        operation.request_id = request_id;
        const request = workflow.request(request_id) as LlmRequest;
        let result: LlmResult;
        try {
          result = await this.host.generate(request);
        } catch (cause) {
          const answer = cause instanceof HostError ? cause.partial_content : partial;
          return interrupted(operation.cancelled ? 'cancelled' : 'failed', answer, provenance,
            cause instanceof Error ? cause.message : String(cause));
        } finally {
          operation.request_id = null;
        }
        if (result.request_id !== request_id) throw new Error('The host returned an unrelated AI response.');
        provenance = result.provenance;
        partial = result.content;
        // A stop between the last delta and the final reply still wins locally.
        if (operation.cancelled) return interrupted('cancelled', partial, provenance);
        const step = workflow.accept(result) as WorkflowStep;
        if (step.kind === 'finished') return step.completion;
      }
      throw new Error('The AI operation exceeded its tool continuation limit.');
    } finally {
      unsubscribe();
      workflow.free();
      this.operations.delete(operation_id);
    }
  }
}

function interrupted(status: 'failed' | 'cancelled', answer: string, provenance: LlmProvenance,
  message = 'The AI request was stopped.'): AiCompletion {
  return {
    answer, provenance, status, note_proposal: null, note_provenance: null, proposal_warning: null,
    error: { code: status === 'cancelled' ? 'cancelled' : 'bridge_failure', message, retryable: false },
  };
}
