# Papertrail

A local desktop app for reading arXiv papers, following references, and saving AI explanations beside selected passages.

Built with Tauri 2, Rust, React, TypeScript, and PDF.js. PDFs stay unchanged; annotations belong to the app and can be exported separately.

## Run locally

Prerequisites: Node.js 22 or newer, pnpm, Rust 1.88 or newer, and your platform's [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

The install step copies PDF.js fonts, character maps, and WASM assets locally. The development server binds to `127.0.0.1:1427`.

To make a desktop bundle:

```sh
pnpm tauri build
```

To check the project:

```sh
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

`pnpm dev` displays the interface in a browser for layout development. Downloads, storage, and AI requests require the desktop runtime.

## Use

1. Enter an arXiv ID or arXiv URL. Modern IDs, legacy IDs, and explicit versions are supported. Downloaded papers enter the local library.
2. Read the original PDF, select text, and add a note or ask a question.
3. Configure your AI service in Settings: an endpoint base URL, model ID, and optional API key. The endpoint must support the chat-completions request format; `/chat/completions` is appended to the base URL. Local services can be used without an API key.
4. Follow PDF citation links or open detected arXiv references. For references that need matching, review the suggested papers before choosing one.
5. Use Back and Forward to return to earlier reading positions, including across papers.
6. Export annotations as a JSON sidecar. Import it alongside the exact same PDF revision.

PDFs, library metadata, positions, and annotations live in the platform's app data directory for `app.papertrail.reader`. Credentials use the native credential store, rather than the annotation file or frontend storage. Reading cached papers and notes works offline; paper downloads, reference lookup, and remote AI calls need a connection.

Reference extraction from plain PDF text is heuristic. Embedded links and explicit identifiers are the most reliable path; bibliography text without an identifier can require manual review. AI answers use the selected passage, surrounding text, and paper metadata; they do not automatically read every cited paper.

## Project layout

- `src/pages`: workspace and interaction state.
- `src/components`: reader, selection/annotation UI, and settings.
- `src/lib/types.ts`: shared serialized contracts.
- `src/lib/tauri.ts`: command wrappers.
- `src/lib/history.ts`: cross-paper navigation.
- `src/lib/annotations.ts`: sidecar validation and serialization.
- `src-tauri/src`: downloads, persistence, provider requests, and reference lookup.
- `docs`: product plan, reader decisions, and annotation format.

All website content stays local. There is no hosting or deployment setup.

See [verification notes](docs/verification.md) for completed checks and remaining native interaction limits.
