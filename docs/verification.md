# Verification — 2026-09-27

The first implementation includes all four core workflows: arXiv import and PDF reading, reference following, selection questions with persistent annotations, and cross-paper Back/Forward.

The immersive reader update shows metadata and the abstract when a paper is explicitly opened, then displays the PDF across the app window with tap-controlled overlays. On iOS, the overlay's portrait/landscape action changes native screen orientation independently of PDF page rotation. Back/Forward restores reading directly without reopening the metadata sheet.

## Automated checks

- `pnpm test`: 57 passing frontend tests covering geometry, clipped cross-page DOM selections, text normalization, reference parsing, sidecar validation, history, workspace interactions, mobile panel access, preserved touch-selection anchors, metadata-sheet accessibility and focus, tap gestures, orientation behavior, reading resumption, Safari-compatible text-stream extraction, persisted width fitting, fit/custom scale across PDF rotation, same-scale navigation, explicit link zoom, different page sizes, and bounded scrolling.
- `pnpm build`: TypeScript and production frontend build pass.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 13 passing tests covering IDs, real Atom metadata, persistence across restart, revision-bound annotations, provider URL validation, a local HTTP AI roundtrip, atomic native-export writes, reader orientation serialization, saved fit-width mode, and legacy reading locations without a zoom mode.
- Rust formatting and Clippy with warnings denied pass.
- `pnpm desktop:build --debug --bundles app`: the updated native Mac app builds with the bundled frontend.
- `pnpm ios:sim`: updated Rust and Swift code compiles and the Apple Silicon simulator package builds.
- The updated signed iPhone IPA exported successfully. Its executable is arm64, strict deep signature verification passes, and the current frontend assets are embedded. Device installation requires matching provisioning; signing settings and profile details remain local.
- `pnpm ios:open` prepares the generated Xcode environment and keeps Tauri's build helper running. A signed iPhone `xcodebuild` succeeds with an otherwise empty environment and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, reproducing Xcode's restricted tool search paths. The launcher passes a strict TypeScript check; fixture checks cover inline YAML conversion, repeat preparation, shell quoting, and preserving the project when a template is unrecognized. Direct Xcode UI access was rejected by automatic approval review; this verification uses the command-line builder.

The local HTTP test needs permission to bind a loopback port in restricted sandboxes. It does not contact an external AI provider or use a real API key.

## Native desktop checks

On this Mac running macOS 15.4.1, `pnpm desktop:dev` starts Vite on loopback port 1427, compiles and launches the Rust app, and enables the native source watcher. The interactive development session stays available until the app or session is closed. Vite reports the initial dependency optimization and reload.

The updated standalone `Papertrail.app` also opens successfully. Its cached library survives the rebuild, and the immersive PDF reader loads the cached paper, page diagrams, text layer, and captured-selection action in the native desktop window. See the [desktop development guide](desktop.md) for live updates and standalone builds.

The scale fix was checked with the cached Attention Is All You Need paper in the native Mac app. Fit Width remains selected as PDF rotation recalculates the percentage between 172% and 223%, with the page fitting the window. A same-scale Next Page jump reaches the next page and retains Fit Width. Mixed-size page layout uses independent centering; its CSS layout has not been visually checked with a mixed-size PDF. Geometry tests use bounded scroll and rotation mocks rather than a browser layout engine.

A signed iPhone build of the scale update succeeds through `xcodebuild`. The scale update has not been installed or interaction-tested on a physical iPhone; the simulator interaction results below describe the earlier immersive-reader update.

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
