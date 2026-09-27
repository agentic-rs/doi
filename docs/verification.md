# Verification — 2026-09-27

The first implementation includes all four core workflows: arXiv import and PDF reading, reference following, selection questions with persistent annotations, and cross-paper Back/Forward.

The immersive reader update shows metadata and the abstract when a paper is explicitly opened, then displays the PDF across the app window with tap-controlled overlays. On iOS, the overlay's portrait/landscape action changes native screen orientation independently of PDF page rotation. Back/Forward restores reading directly without reopening the metadata sheet.

## Automated checks

- `pnpm test`: 50 passing frontend tests covering geometry, clipped cross-page DOM selections, text normalization, reference parsing, sidecar validation, history, workspace interactions, mobile panel access, preserved touch-selection anchors, metadata-sheet accessibility and focus, tap gestures, orientation behavior, reading resumption, and Safari-compatible text-stream extraction.
- `pnpm build`: TypeScript and production frontend build pass.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 11 passing tests covering IDs, real Atom metadata, persistence across restart, revision-bound annotations, provider URL validation, a local HTTP AI roundtrip, atomic native-export writes, and reader orientation serialization.
- Rust formatting and Clippy with warnings denied pass.
- `pnpm desktop:build --debug --bundles app`: the updated native Mac app builds with the bundled frontend.
- `pnpm ios:sim`: updated Rust and Swift code compiles and the Apple Silicon simulator package builds.
- The updated signed iPhone IPA exported successfully. Its executable is arm64, strict deep signature verification passes, and the current frontend assets are embedded. Device installation requires matching provisioning; signing settings and profile details remain local.

The local HTTP test needs permission to bind a loopback port in restricted sandboxes. It does not contact an external AI provider or use a real API key.

## Native desktop checks

On this Mac running macOS 15.4.1, `pnpm desktop:dev` starts Vite on loopback port 1427, compiles and launches the Rust app, and enables the native source watcher. The interactive development session stays available until the app or session is closed. Vite reports the initial dependency optimization and reload.

The updated standalone `Papertrail.app` also opens successfully. Its cached library survives the rebuild, and the immersive PDF reader loads the cached paper, page diagrams, text layer, and captured-selection action in the native desktop window. See the [desktop development guide](desktop.md) for live updates and standalone builds.

The iOS screen-orientation action is intentionally available only on iOS. Desktop checks cover the shared reader and backend; phone geometry, touch selection, iOS Keychain, and Files behavior use simulator or physical-device checks. Older macOS versions remain unverified.

## Native simulator checks

Installed the updated build over the existing app on an iPhone 16 simulator running iOS 18.4, without uninstalling it. The cached library survived the update. Native interaction checks verified:

- Real Attention Is All You Need metadata and its complete abstract appear when opening the paper.
- **Read paper** and **Resume reading** reveal the unobstructed PDF; tapping opens the controls, and **Info** reopens the information sheet.
- The viewer switches portrait → landscape → portrait while retaining the reading page and refitting the viewport.
- **Refs & notes** contains 40 detected bibliography entries. Following Layer Normalization opens that paper's metadata and PDF.
- Back and Forward return directly to the correct PDFs without showing their information sheets.

The scoped Safari text-stream adapter restores PDF text extraction through `getReader()` without a global stream polyfill. It supplies both the selectable text layer and detected bibliography; tests cover chunk aggregation, error cleanup, and the separate XFA path.

## Real paper check

Fetched public arXiv metadata and PDF for `1706.03762v7` (Attention Is All You Need). PDF.js parsed all 15 pages and 113 embedded links, rendered the first page to a PNG, and the app's bibliography parser extracted 40 numbered references, including 22 explicit arXiv identifiers.

Workspace integration tests use a mocked reader and command boundary; DOM selection tests use actual JSDOM ranges with geometry stubs. These check app logic and anchors but do not replace native webview interaction testing.

## Remaining validation limits

- Browser-based UI inspection was rejected by automatic approval review under the user's no-Chrome instruction; it was not retried through another surface.
- No real AI provider/key was supplied. The configurable request/response protocol is tested with a local server; remote provider behavior and native credential writes are unverified.
- Native Save dialog clicks and visual highlight alignment in the running app are unverified. Export validation and file writing are tested.
- Plain-text reference extraction is heuristic; uncertain matches are presented as candidates. The app reads arXiv targets internally and opens other source links externally.
- The iOS packages are development builds. The immersive flow is verified in the native simulator; the updated package was not installed or interaction-tested on a physical phone by this task. Physical-device interaction with Keychain, Files export, PDF selection, and AI remains unverified. iOS 18 is the minimum supported version. See [installation steps](ios.md).
- Windows, Linux, Android, and older macOS versions have not been built or tested.
