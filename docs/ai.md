# AI in the Apell applet

Apell owns provider settings, credentials, model selection, transport, and streaming. Paper Reader constructs the source context and completed conversation history, validates note proposals in Rust/WASM, and persists conversations and annotations through the applet's SQLite store.

Close the applet and use Apell Settings to configure the shared model. Demo mode provides scripted replies and is not evidence of a live model connection.

The initial answer offers `propose_annotation` as an optional tool. A valid call becomes a draft only; Paper Reader returns a tool result and requests a final text answer. Follow-ups do not offer tools. **Generate note** requires exactly one valid proposal, and failures retain the previous draft. **Save note** writes the reviewed content without another model call.

The runner uses `llm.generate`, not the legacy `llm.complete`. Each provider round has a distinct request ID, while UI events retain the enclosing operation ID. Stop cancels the currently active round and prevents starting another. Cancelled, truncated, failed, and unsupported outcomes retain available answer text as incomplete. Incomplete turns are excluded from future context.

Apell returns a replayable assistant `message`. Paper Reader passes it back intact during the tool exchange, preserving native `provider_state`. Ordinary completed question/answer turns form the durable history.

Thinking events are displayed transiently and excluded from stored answers and exports. Stored turns and notes carry `llm_provenance` with the connection ID, requested model, and nullable provider-reported model. The legacy display field `model_id` uses the requested model when the actual model is unknown; `llm_provenance.model_id` retains that distinction.

Paper Reader sends the selected passage, nearby context, title, authors, abstract, and completed conversation turns. It does not automatically read every cited paper. The applet rejects oversized context instead of silently truncating it.

Current compatibility limits:

- Provider capability reports can be `unknown`; each request's outcome is authoritative.
- A positively identified unsupported-tools response permits one text-only retry for an initial answer. Explicit note generation never substitutes ordinary answer text for a required proposal.
- Apell has no per-request thinking control. Providers that reject required tools in their configured thinking mode need a compatible model/host configuration.
- The current host cannot preserve nonempty streaming `reasoning_details`; it rejects that format explicitly.

Live-provider and physical-device behavior still require integration testing.
