# Desktop development

Use the native macOS app to test changes without reinstalling on an iPhone. This guide covers the desktop environment used for this project.

## Run with live updates

Prerequisites: Node.js 22 or newer, pnpm, Rust 1.88 or newer, and the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos). The frontend build targets Safari 18; testing currently uses this development Mac's native webview.

From the project directory:

```sh
pnpm install
pnpm desktop:dev
```

The command starts Vite at `http://127.0.0.1:1427`, builds the Rust backend, and opens Papertrail as a native app. Keep the terminal running while testing. Frontend edits update through Vite's hot reload; Rust edits rebuild and restart the app automatically. Press Ctrl+C in the terminal to stop the development session.

Download a paper, click a PDF page to reveal the reading overlay, select text, and use references, annotations, or AI as in the installed app. Local desktop development does not need an iPhone, an iOS package installation, or Apple device signing.

`pnpm dev` starts only the frontend for layout development. Native downloads, storage, and AI commands require `pnpm desktop:dev` or a bundled desktop app.

## Build a standalone app

```sh
pnpm desktop:build
```

The macOS app is written to `src-tauri/target/release/bundle/macos/Papertrail.app`. Open it from Finder to test the bundled frontend without a development server.

For a development bundle:

```sh
pnpm desktop:build --debug --bundles app
```

Its output is `src-tauri/target/debug/bundle/macos/Papertrail.app`.

## Local library

Downloaded PDFs, metadata, reading positions, and annotations persist in the desktop app data directory for `app.papertrail.reader`, including between development restarts. The desktop library is separate from the iPhone's sandboxed library; papers and notes are not automatically synchronized. Cached papers and notes work offline. Downloads, reference lookup, and remote AI requests need a connection.
