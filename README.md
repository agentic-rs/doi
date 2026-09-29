# Papertrail

A local desktop and iOS app for reading arXiv papers, following references, and saving AI explanations beside selected passages.

Built with Tauri 2, Rust, React, TypeScript, and PDF.js. PDFs stay unchanged; annotations belong to the app and can be exported separately.

## Run locally

Prerequisites: Node.js 22.18 or newer, pnpm, Rust 1.90 or newer, and your platform's [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm desktop:dev
```

This opens the native desktop app for testing. Frontend changes reload automatically; Rust changes rebuild and restart the app. Keep the terminal running, and press Ctrl+C to stop. Local desktop development does not require an iPhone installation or Apple device signing.

The install step copies PDF.js fonts, character maps, and WASM assets locally. The development server binds to `127.0.0.1:1427`. Your desktop library persists between runs and is separate from the phone's library. See [desktop development](docs/desktop.md) for the workflow.

To make a desktop bundle:

```sh
pnpm desktop:build
```

To check the project:

```sh
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

`pnpm dev` displays the interface in a browser for layout development. Downloads, storage, and AI requests require the native app runtime.

## Build for iOS

Requires macOS, Xcode with iOS support, CocoaPods, XcodeGen, libimobiledevice, and the Rust iOS targets. The app supports iOS 18 or newer.

```sh
pnpm ios:init
pnpm ios:sim
```

To build or run on an iPhone through Xcode:

```sh
pnpm ios:open
```

This prepares the local Xcode toolchain environment, bundles the frontend, and opens the generated project. Keep the terminal running while using Xcode's Run or Build actions; Ctrl+C stops the helper. Select your Apple account/team and iPhone in Xcode, then press Run. The launcher itself does not install or run the app on the phone.

To export a signed iPhone package after configuring signing:

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm ios:build
```

See [iOS build and installation](docs/ios.md) for simulator installation, signed device installation, and Xcode troubleshooting. The generated Xcode project and signing settings stay local; run `pnpm ios:init` on each fresh checkout.

## Use

1. The app opens to your library, with recent papers, search, and **Add a paper**. Enter an arXiv ID or URL and choose **Find paper**. Modern IDs, legacy IDs, and explicit versions are supported.
2. Review the title, authors, ID/version, and abstract before downloading. The preview has two actions: **Download & add to library** and **Cancel**. Cancel returns to the input with your entry preserved. A successful download adds the paper and opens it; reopening a saved paper resumes reading directly. **Info** remains available for its metadata and abstract.
3. Tap a page to show or hide the reading controls. The overlay opens the library, **Info**, **Refs & notes**, and settings. **Close paper** saves the reading position and keeps the paper in the library. iPhone has one active reader; iPad and Mac use tabs, and closing the last tab returns home. On iOS, **Landscape** or **Portrait** changes the viewer's screen orientation; **Rotate clockwise** in the PDF controls separately rotates the PDF pages.
4. Select text, then tap the floating sparkle icon to ask AI. Use the Notes panel to add a manual note. Drag the icon to move it out of the way. **Ask** streams the answer and any provider-exposed thinking. Review and edit the model's suggested note, then use **Save note** to keep it beside the passage. In Settings, choose your AI provider, enter your own API key, and use **Load models** to choose a model. You can also enter its ID manually. On iPhone, AI opens full screen in portrait; **Back to paper** restores the previous reading direction. iPad and Mac keep AI available alongside landscape reading. Tokn's Rust provider components run inside the app on desktop and iOS. See [AI setup](docs/ai.md).
5. Follow PDF citation links or open detected arXiv references. Unsaved papers use the same abstract preview before downloading. Saved papers open directly. For references that need matching, review the suggested papers before choosing one.
6. Back and Forward restore earlier positions and view modes. On iPhone, history includes cross-paper links. On iPad and Mac, each tab has its own history; following a paper reference opens or focuses its tab, with **Back to source** returning to the referring paper. Switching tabs or returning home preserves running AI conversations.
7. Use a library paper's menu to **Remove** it. Confirmation deletes its downloaded PDF, notes, AI conversations, and reading cache, and closes its tabs. Closing a reader or tab does not remove these records.
8. Export annotations as a JSON sidecar. Import it alongside the exact same PDF revision.

Choose **Reading view** in the overlay for an optional stream of cropped source blocks. It trims whitespace, reads clear columns in sequence, and places reliably detected figures with their captions after an explicit figure reference. Tap a figure or choose **Enlarge** for a closer look. The small document icon (**View in PDF**) opens its original location; Back returns to the reading block. Source icons for text appear with the reading controls, hover, or keyboard focus. Switch back using **Original PDF**. The layout is analyzed locally and cached for later openings.

Reading view preserves the paper's original typography. It does not reflow text or use OCR. Complex layouts and uncertain figure matches retain their source arrangement, so some papers benefit more than others.

Pinch the PDF with two fingers, use a Mac trackpad pinch, or hold Ctrl while scrolling to zoom. Only the PDF scales; reading overlays keep their size. A page preview follows the gesture, then sharpens after release or a short pause in Ctrl+scroll.

**Fit page width** remains selected across page and citation jumps, reopening a paper, viewport changes, and PDF rotation. A PDF link with an explicit zoom level can override this. Pinching or using the + and − buttons selects manual zoom. Older saved reading positions retain their numeric zoom until you select **Fit page width**.

PDFs, library metadata, positions, and annotations live in the platform's app data directory for `app.papertrail.reader`. Credentials use the native credential store, rather than the annotation file or frontend storage. Reading cached papers and notes works offline; paper downloads, reference lookup, and remote AI calls need a connection.

If arXiv returns HTTP 429 during metadata lookup or PDF download, Papertrail shows **Waiting for arXiv** and the retry time. Requests share a three-second pacing clock and use up to three automatic retries, honoring `Retry-After` or increasing delays when it is absent. Cooldowns persist across app restarts. Cancel stops waiting and keeps your input; cached papers remain readable. A failed PDF download keeps the preview so retrying does not repeat its metadata lookup.

Reference extraction from plain PDF text is heuristic. Embedded links and explicit identifiers are the most reliable path; bibliography text without an identifier can require manual review. AI answers use the selected passage, surrounding text, and paper metadata; they do not automatically read every cited paper.

## Project layout

- `src/pages`: workspace and interaction state.
- `src/components`: reader, selection/annotation UI, and settings.
- `src/lib/types.ts`: shared serialized contracts.
- `src/lib/tauri.ts`: command wrappers.
- `src/lib/history.ts`: reading-location history for the phone reader and each desktop/iPad tab.
- `src/lib/annotations.ts`: sidecar validation and serialization.
- `src-tauri/src`: downloads, persistence, provider requests, and reference lookup.
- `docs`: product plan, reader decisions, and annotation format.

All website content stays local. There is no hosting or deployment setup.

See [verification notes](docs/verification.md) for completed checks and remaining native interaction limits.
