# Verification — 2026-09-27

The first implementation includes all four core workflows: arXiv import and PDF reading, reference following, selection questions with persistent annotations, and cross-paper Back/Forward.

## Automated checks

- `pnpm test`: 31 passing tests covering geometry, clipped cross-page DOM selections, text normalization, reference parsing, sidecar validation, history, workspace interactions, mobile panel access, preserved touch-selection anchors, and orientation changes.
- `pnpm build`: TypeScript and production frontend build pass.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 10 passing tests covering IDs, real Atom metadata, persistence across restart, revision-bound annotations, provider URL validation, a local HTTP AI roundtrip, and atomic native-export writes.
- Rust formatting and Clippy with warnings denied pass.
- A local macOS development bundle builds with `pnpm tauri build --debug --bundles app`.
- iOS Rust and Swift code compiles for `aarch64-apple-ios-sim`; simulator and signed iPhone development packages build with `pnpm ios:sim` and `pnpm ios:build`.
- Installed and launched the iOS simulator package on an iPhone 16 running iOS 18.4. A native simulator screenshot confirms that the mobile interface loads with bundled assets and no Vite server.
- The final iPhone build uses a development provisioning profile containing the paired iPhone's UDID. Signature verification passes. Its profile expires October 4, 2026; physical-device installation is a separate step.

The local HTTP test needs permission to bind a loopback port in restricted sandboxes. It does not contact an external AI provider or use a real API key.

## Real paper check

Fetched public arXiv metadata and PDF for `1706.03762v7` (Attention Is All You Need). PDF.js parsed all 15 pages and 113 embedded links, rendered the first page to a PNG, and the app's bibliography parser extracted 40 numbered references, including 22 explicit arXiv identifiers.

Workspace integration tests use a mocked reader and command boundary; DOM selection tests use actual JSDOM ranges with geometry stubs. These check app logic and anchors but do not replace native webview interaction testing.

## Remaining validation limits

- Browser-based UI inspection was rejected by automatic approval review under the user's no-Chrome instruction; it was not retried through another surface.
- No real AI provider/key was supplied. The configurable request/response protocol is tested with a local server; remote provider behavior and native credential writes are unverified.
- Native Save dialog clicks and visual highlight alignment in the running app are unverified. Export validation and file writing are tested.
- Plain-text reference extraction is heuristic; uncertain matches are presented as candidates. The app reads arXiv targets internally and opens other source links externally.
- The iOS packages are development builds. The simulator launch is verified; physical-device interaction with Keychain, Files export, PDF selection, and AI remains unverified. iOS 18 is the minimum supported version. See [installation steps](ios.md).
- Windows, Linux, Android, and older macOS versions have not been built or tested.
