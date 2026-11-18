import { AiWorkflow } from '../generated/doi_ai';
import { createId, HostError, llm } from '../vendor/apell-sdk';
import type { LlmEvent, LlmProvenance, LlmRequest, LlmResult, LlmStatus, LlmFailure } from '../vendor/apell-sdk';
import type { AiCitation, PageAnchor } from '../../src/lib/types';
import type { PdfReadRequest, PdfReadResult } from './pdf-reader-tools';

export interface AiInput {
  source: string;
  history: [string, string][];
  question: string;
  mode: 'initial_answer' | 'follow_up' | 'generate_note';
  initial_citations?: PageAnchor[];
}

export interface AiCompletion {
  answer: string;
  note_proposal: string | null;
  proposal_warning: string | null;
  provenance: LlmProvenance;
  note_provenance: LlmProvenance | null;
  status: LlmStatus;
  error: LlmFailure | null;
  citations?: AiCitation[];
}

type WorkflowStep = { kind: 'continue' } | { kind: 'finished'; completion: AiCompletion } |
  { kind: 'read_pdf'; calls: { id: string; request: PdfReadRequest | null }[] };
export type PdfToolReader = (request: PdfReadRequest, signal: AbortSignal) => Promise<PdfReadResult>;
export type AiRunEvent = LlmEvent | { kind: 'round_reset'; request_id: string; text: '' };

const utf8 = new TextEncoder();
const size = (text: string) => utf8.encode(text).byteLength;
type CitableExcerpt = { source_id: string; page_number: number; quote: string };

/** Only the plain quote goes upstream. Geometry remains local, bound to this answer's IDs. */
class PdfEvidence {
  private readonly by_anchor = new Map<string, AiCitation>();
  private readonly by_id = new Map<string, AiCitation>();
  private remaining_bytes = 32 * 1024;

  excerpts(anchors: PageAnchor[], max_count: number, budget: number) {
    const passages: CitableExcerpt[] = [];
    let omitted = false;
    for (const anchor of anchors) {
      const quote = anchor.text_quote.exact_text;
      if (!quote.trim() || size(quote) > 4096 || passages.length >= max_count) { omitted = true; continue; }
      const key = JSON.stringify(anchor);
      const citation = this.by_anchor.get(key) ?? { citation_id: 'S' + (this.by_id.size + 1), anchor };
      if (passages.some(p => p.source_id === '[' + citation.citation_id + ']')) continue;
      const excerpt = { source_id: '[' + citation.citation_id + ']', page_number: anchor.page_number, quote };
      const bytes = size(JSON.stringify(excerpt)) + 1;
      if (bytes > budget) { omitted = true; continue; }
      this.by_anchor.set(key, citation);
      this.by_id.set(citation.citation_id, citation);
      passages.push(excerpt);
      budget -= bytes;
    }
    return { passages, omitted };
  }

  initialSource(source: string, anchors: PageAnchor[]) {
    if (!anchors.length) return source;
    const excerpts = this.excerpts(anchors, 16, 16 * 1024 - 512);
    return source + '\n\nCitable excerpts supplied for this answer:\n' + JSON.stringify(excerpts);
  }

  async read(request: PdfReadRequest | null, reader: PdfToolReader, signal: AbortSignal): Promise<string> {
    if (!request) return 'Invalid PDF tool or arguments. Use a valid search_document or read_page request.';
    if (this.remaining_bytes < 1024) return 'The PDF excerpt budget is exhausted. Answer using the passages already supplied.';
    let result: PdfReadResult;
    try {
      result = await reader(request, signal);
    } catch {
      return 'The applet could not read the requested PDF text. Report insufficient evidence if needed.';
    }
    // Leave room for punctuation and pagination/status data within the Rust result boundary.
    const budget = Math.min(this.remaining_bytes, 16 * 1024);
    const excerpts = this.excerpts(result.passages, 4, budget - 1024);
    const message = size(JSON.stringify(result.message)) <= 768 ? result.message : 'PDF read completed.';
    const encoded = JSON.stringify({ ...excerpts, message });
    this.remaining_bytes -= size(encoded);
    return encoded;
  }

  finish(completion: AiCompletion): AiCompletion {
    const cited = new Map<string, AiCitation>();
    const answer = completion.answer.replace(/\[(S\d+)\]/g, (marker, id: string) => {
      const citation = this.by_id.get(id);
      if (!citation) return '(unverified source)';
      cited.set(id, citation);
      return marker;
    });
    return { ...completion, answer, citations: [...cited.values()] };
  }
}

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
  private readonly operations = new Map<string, { request_id: string | null; controller: AbortController }>();

  constructor(private readonly host: LlmHost = apell_host) {}

  async cancel(operation_id: string): Promise<void> {
    const operation = this.operations.get(operation_id);
    if (!operation) return;
    operation.controller.abort();
    if (operation.request_id) await this.host.cancel(operation.request_id);
  }

  async run(operation_id: string, input: AiInput, on_event: (event: AiRunEvent) => void, read_pdf?: PdfToolReader): Promise<AiCompletion> {
    if (this.operations.has(operation_id)) throw new Error('That AI operation is already running.');
    const { initial_citations = [], ...policy_input } = input;
    const evidence = read_pdf && input.mode !== 'generate_note' ? new PdfEvidence() : null;
    const workflow = new AiWorkflow({ ...policy_input, read_pdf: evidence !== null,
      source: evidence?.initialSource(input.source, initial_citations) ?? input.source });
    const operation = { request_id: null as string | null, controller: new AbortController() };
    const signal = operation.controller.signal;
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
      // Rust enforces tool round limits and revokes tools for the final answer.
      for (;;) {
        if (signal.aborted) return interrupted('cancelled', partial, provenance);
        partial = '';
        const request_id = this.host.createId();
        operation.request_id = request_id;
        const request = workflow.request(request_id) as LlmRequest;
        let result: LlmResult;
        try {
          result = await this.host.generate(request);
        } catch (cause) {
          const answer = cause instanceof HostError ? cause.partial_content : partial;
          return interrupted(signal.aborted ? 'cancelled' : 'failed', answer, provenance,
            cause instanceof Error ? cause.message : String(cause));
        } finally {
          operation.request_id = null;
        }
        if (result.request_id !== request_id) throw new Error('The host returned an unrelated AI response.');
        provenance = result.provenance;
        partial = result.content;
        // A stop between the last delta and the final reply still wins locally.
        if (signal.aborted) return interrupted('cancelled', partial, provenance);
        const step = workflow.accept(result) as WorkflowStep;
        if (step.kind === 'finished') return evidence?.finish(step.completion) ?? step.completion;
        // Provider prose accompanying a tool call belongs to its replay message.
        // Clear it before displaying the next round or cancelling a local read.
        partial = '';
        on_event({ request_id: operation_id, kind: 'round_reset', text: '' });
        if (step.kind === 'read_pdf') {
          if (!read_pdf || !evidence) throw new Error('A PDF read was requested without a document reader.');
          const results = [];
          for (const call of step.calls) {
            if (signal.aborted) return interrupted('cancelled', partial, provenance);
            const content = await evidence.read(call.request, read_pdf, signal);
            if (signal.aborted) return interrupted('cancelled', partial, provenance);
            results.push({ tool_call_id: call.id, content });
          }
          workflow.supplyReads(results);
        }
      }
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
