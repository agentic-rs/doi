# Verification of the Apell migration

The production build and TypeScript check passed. The final Vitest run passed **706 tests across 49 files**; Rust passed **18 tests**. `git diff --check` passed.

The migration is checked with:

- A production self-contained bundle build, including Rust/WASM compilation and TypeScript checking.
- The reader, annotation, navigation, selection, and workspace UI tests.
- Compiled-WASM LLM integration tests covering tool continuation, transient reasoning, cancellation, concurrent request isolation, explicit outcomes, and unknown actual-model attribution.
- Real SQLite-backed tests covering multi-chunk Unicode records, transaction rollback, reopening storage, durable conversations, idempotent annotation saves, interrupted recovery, early cancellation, and preventing deleted-paper resurrection.
- Actual PDF.js text extraction and canvas rendering using embedded standard-font data without a worker URL or asset fetch. The rendered smoke image is written to `artifacts/pdf-smoke.png`.
- Rust policy and inherited model/record-validation tests.

These tests use simulated Apell services and provider fixtures. They do not establish live-provider compatibility or end-to-end installation in the native host. Native UI inspection returned no usable app controls during this migration; a physical-device smoke test remains outstanding.

In particular, verify complex PDFs, selection alignment, zoom performance, the opaque-origin sandbox, real arXiv responses, and required note tools on the intended model before relying on full device parity. The current host limits and deliberate UI changes are listed in the README.

The standalone data directory is untouched. There is no automatic library importer in this version.
