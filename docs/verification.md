# Verification of the Apell migration

Run `pnpm test` to build the bundle, check TypeScript and exercise the applet and reader in Vitest. Run `pnpm test:ai` for the native Rust tests. Coverage includes the following paths.

- A production self-contained bundle build, including Rust/WASM compilation and TypeScript checking.
- The reader, annotation, navigation, selection, and workspace UI tests.
- Compiled-WASM LLM integration tests covering multi-round PDF search and reading, native message replay, validation of source IDs, malformed calls, read budgets, cancellation during extraction, text-only fallback, transient reasoning and attribution.
- SQLite integration tests search a generated PDF through an Apell tool exchange, save an edited note beside the claim, and reopen its citation on a different page. They also cover whole-paper placement, retries, edits, deletion, annotation export, interrupted requests, and legacy drafts.
- Actual PDF.js text extraction and canvas rendering using embedded standard-font data without a worker URL or asset fetch. The rendered smoke image is written to `artifacts/pdf-smoke.png`.
- A generated PDF larger than 16 MiB goes through a fixture Apell resource service. Paper Reader saves its reference in SQLite and Ask AI reads a passage from the cached PDF. Download tests also cover progress, rate limits, cancellation, integrity checks, and removal of legacy file chunks.
- Revision-pinned PDF tool tests exercise real text extraction, PDF-coordinate anchors, bounded search and page continuation, empty pages, corrupt files and cancellation.
- Rust policy and inherited model/record-validation tests.

The automated tests use simulated Apell services and model replies. Live model tool selection, citation quality on real papers and physical-device interaction require a separate run in the native Apell host.

For 0.4.0, a separate browser smoke test opened the packaged applet inside Apell's scripts-only iframe sandbox with a fixture host. Ask, follow-up, pin, and library lookup buttons invoke their JavaScript actions directly because native form submissions are blocked in that sandbox. Physical-device checks should cover touch selection, the on-screen keyboard, complex PDFs, zoom performance, real arXiv responses, and the intended model connection.

The standalone data directory is untouched. There is no automatic library importer in this version.
