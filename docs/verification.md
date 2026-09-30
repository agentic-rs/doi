# Verification — 2026-09-27

The first implementation includes all four core workflows: arXiv import and PDF reading, reference following, selection questions with persistent annotations, and cross-paper Back/Forward.

The immersive reader update shows metadata and the abstract when a paper is explicitly opened, then displays the PDF across the app window with tap-controlled overlays. On iOS, the overlay's portrait/landscape action changes native screen orientation independently of PDF page rotation. Back/Forward restores reading directly without reopening the metadata sheet.

## Automated checks

- `pnpm test`: 80 passing frontend tests covering geometry, clipped cross-page DOM selections, text normalization, reference parsing, sidecar validation, history, workspace interactions, mobile panel access, preserved touch-selection anchors, metadata-sheet accessibility and focus, tap gestures, orientation behavior, reading resumption, Safari-compatible text-stream extraction, persisted width fitting, fit/custom scale across PDF rotation, same-scale navigation, explicit link zoom, different page sizes, and bounded scrolling. Zoom regressions cover touch/Safari/Ctrl-wheel event handling, moving pinch anchors, gesture overlap and cleanup, native pixel density, the canvas pixel budget, retaining the previous bitmap, rejecting stale renders, and releasing canceled buffers while text extraction is pending.
- `pnpm build`: TypeScript and production frontend build pass.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 13 passing tests covering IDs, real Atom metadata, persistence across restart, revision-bound annotations, provider URL validation, a local HTTP AI roundtrip, atomic native-export writes, reader orientation serialization, saved fit-width mode, and legacy reading locations without a zoom mode.
- Rust formatting and Clippy with warnings denied pass.
- `pnpm desktop:build --debug --bundles app`: the updated native Mac app builds with the bundled frontend.
- `pnpm ios:sim`: updated Rust and Swift code compiles and the Apple Silicon simulator package builds.
- The updated signed iPhone IPA exported successfully. Its executable is arm64, strict deep signature verification passes, and the current frontend assets are embedded. Device installation requires matching provisioning; signing settings and profile details remain local.
- `pnpm ios:open` prepares the generated Xcode environment and keeps Tauri's build helper running. A signed iPhone `xcodebuild` succeeds with an otherwise empty environment and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, reproducing Xcode's restricted tool search paths. The launcher passes a strict TypeScript check; fixture checks cover inline YAML conversion, repeat preparation, shell quoting, and preserving the project when a template is unrecognized. Direct Xcode UI access was rejected by automatic approval review; this verification uses the command-line builder.

The local HTTP test needs permission to bind a loopback port in restricted sandboxes. It does not contact an external AI provider or use a real API key.

Pinch performance regressions exercise 60 touch frames, 30 Safari gesture frames, and 60 Ctrl-wheel frames. Preview frames start no PDF renders or text layers, copy no canvases, and emit no reading-location updates. Completion starts one final render/text layer/canvas copy per visible page and reports one final location. Tests also cover midpoint continuity between pages, Safari-to-touch handoff, cancellation on paper/panel changes, and reuse of a completed page after an unchanged or canceled gesture. These count work with mocked PDF.js and JSDOM geometry; they do not measure native frame rate.

## Native desktop checks

On this Mac running macOS 15.4.1, `pnpm desktop:dev` starts Vite on loopback port 1427, compiles and launches the Rust app, and enables the native source watcher. The interactive development session stays available until the app or session is closed. Vite reports the initial dependency optimization and reload.

The updated standalone `Papertrail.app` also opens successfully. Its cached library survives the rebuild, and the immersive PDF reader loads the cached paper, page diagrams, text layer, and captured-selection action in the native desktop window. See the [desktop development guide](desktop.md) for live updates and standalone builds.

The scale fix was checked with the cached Attention Is All You Need paper in the native Mac app. Fit Width remains selected as PDF rotation recalculates the percentage between 172% and 223%, with the page fitting the window. A same-scale Next Page jump reaches the next page and retains Fit Width. Mixed-size page layout uses independent centering; its CSS layout has not been visually checked with a mixed-size PDF. Geometry tests use bounded scroll and rotation mocks rather than a browser layout engine.

The pinch-zoom update routes gestures through the PDF scale instead of magnifying the webview. The Mac app loads the cached paper with the staged canvas/text rendering path. Its + button changes 223% to 238%, displays sharp text, and keeps the controls at their original size; Fit Width returns to 223%. The performance update was rebuilt and relaunched, resuming the cached paper at its saved scale. It previews only mounted page images during gestures, then renders the final scale on release. Automated gesture tests use synthetic events and geometry mocks; native pinch frame rate has not been measured by this task.

The earlier signed pinch-zoom IPA is at `src-tauri/gen/apple/build/arm64/Papertrail.ipa`. The subsequent performance and landscape updates use the existing live Xcode helper and signed iPhone `xcodebuild`; the IPA has not been re-exported. The helper remains available for Xcode Run/Build. These updates have not been installed or interaction-tested on a physical iPhone; the landscape simulator checks below cover the latest native changes.

The iOS screen-orientation action is intentionally available only on iOS. Desktop checks cover the shared reader and backend; phone geometry, touch selection, iOS Keychain, and Files behavior use simulator or physical-device checks. Older macOS versions remain unverified.

## Native simulator checks

The landscape update (2026-09-28) was checked on iPhone 16 and iPhone SE (3rd generation) simulators running iOS 18.4. Native checks confirmed:

- Single-row top and bottom controls fit both 852×393 and 667×375 landscape viewports, with 44-point targets.
- The iPhone 16 reference panel sits below the top bar and inside the notch-safe edges; its first citation and action are visible without scrolling past decorative headings.
- Native geometry diagnostics identified duplicate 59-point left/right scroll insets. Disabling native inset adjustment restored the full viewport and eliminated horizontal shifts when focusing a field. Temporary diagnostics were removed from the final build.
- The status bar hides in landscape and returns in portrait. The overlay's orientation button, physical simulator rotation, and launch in landscape were exercised.
- The native Files export picker opens and cancels successfully with the new controller containment.
- All 80 frontend tests pass. The fit/resize test now explicitly advances animation frames instead of depending on a busy machine meeting a one-second timer deadline.
- Final simulator, signed iPhone, and desktop bundles build successfully. Strict deep signature verification passes for the iPhone app with system trust services available. The physical iPhone build uses the restricted Xcode PATH and existing live helper.

Earlier immersive-reader checks installed the build over the existing iPhone 16 app without uninstalling it. The cached library survived. Native interaction checks verified:

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
- The native iOS export picker opens and cancels in the simulator; completing a Files save and visual highlight alignment in the running app remain unverified. Export validation and file writing are tested.
- Plain-text reference extraction is heuristic; uncertain matches are presented as candidates. The app reads arXiv targets internally and opens other source links externally.
- The iOS packages are development builds. The immersive flow is verified in the native simulator; the updated package was not installed or interaction-tested on a physical phone by this task. Physical-device interaction with Keychain, Files export, PDF selection, and AI remains unverified. iOS 18 is the minimum supported version. See [installation steps](ios.md).
- Windows, Linux, Android, and older macOS versions have not been built or tested.


## Optional Reading view (2026-09-28)

- 123 frontend tests pass, including cropped selection geometry, multiple blocks from the same page, display-order selections across moved figures, mode/history restoration, cancelled/stale analysis, cache failures, and deferred sharp rendering after pinch gestures in both the main reader and figure dialog.
- All 19 Rust tests pass. Derived layouts validate PDF hash, extractor version, geometry, identifiers, payload size, and coverage of every source page. SQLite v1 libraries migrate to v2, retaining notes and legacy PDF positions.
- Independent full-resolution raster coverage checks retain every ink pixel across Attention Is All You Need (15 pages), Layer Normalization (14 pages), and BERT (16 pages). BERT supplies a real two-column case: left-column/right-column reading order and full-width figure grouping were visually checked. A column-gutter safety margin prevents clipping italic glyph tails.
- Attention and BERT each expose all five figures. LayerNorm exposes five of six; the prose-wrapped figure stays intact in its original region. These checks do not establish universal figure detection accuracy.
- Native desktop checks confirm saved Reading view reopening, visible sharp cropped text, figure enlargement with complete caption, zoom controls, source-PDF navigation, and Back returning to the Reading view. Text source actions no longer add vertical space between paragraphs.
- Final desktop bundle, simulator build, and signed physical-iPhone build succeed. The simulator build is installed over the existing iPhone 16 library and launches. Simulator coordinate input was unreliable during this pass, so the new Reading-mode interactions on iPhone remain unverified; native desktop interaction and automated phone-sized geometry/gesture tests provide the current coverage. The prior landscape checks above still describe the previous feature's verification.
- The signed iPhone app has not been installed on the physical device and the older IPA has not been re-exported. The existing Xcode helper remains running.

## Compact reader actions and figure scrolling (2026-09-28)

- All 132 frontend tests pass. New checks cover dragging the floating selection action, preserving the selected text, suppressing activation on drag release, keyboard activation, cancellation, safe-bound clamping, and retaining its screen position across controls and composer toggles. Figure geometry checks now account for the actual wrapper CSS and verify both horizontal edges remain reachable after enlargement.
- Native desktop checks with Attention Is All You Need confirm icon-only PDF source actions in Reading view and the enlarged figure dialog. At twice the initial figure scale, dragging the horizontal scrollbar reaches both source edges. The figure remains centered when it fits.
- Native desktop text selection shows the floating sparkle icon. Dragging moves it without opening the composer or losing the selection; tapping opens the selected-passage AI composer. Closing the composer retains the chosen icon position.
- The production frontend, desktop bundle, signed iPhone build, and iPhone simulator build succeed. The final iOS builds use the existing Xcode helper. These changes have not been installed or interaction-tested on a physical phone; touch behavior is covered by automated pointer tests. The older IPA has not been re-exported.

## Embedded Tokn and BYOK (2026-09-28)

- All 144 frontend tests and 28 Rust tests pass. Frontend coverage includes provider changes, draft-key model discovery, endpoint-scoped saved-key status, stale responses, manual model IDs, model-list failures, and focus handling. Rust mock HTTP checks exercise all seven provider choices, provider-specific request transformations, model IDs and endpoint prefixes, optional and required credentials, bounded responses, sanitized errors, rejected redirects and truncated answers, and legacy settings.
- TypeScript, the production frontend build, Rust formatting, and Clippy with warnings denied pass. The declared Rust minimum now matches the locked dependency graph: Rust 1.90.
- The native desktop bundle builds and opens the new provider/key/model settings screen. Existing library data remains available. The user began editing that form during inspection, so their draft was left untouched. External provider inference was not exercised by this task; protocol tests use local mock servers.
- The signed physical-iPhone build succeeds with the embedded Tokn crates and their native dependencies, using the existing Xcode helper. SwiftPM's refresh of an existing SwiftRs dependency temporarily stalled on network access, then completed without a helper restart or configuration change. This build was not installed on the physical device, and the older IPA was not re-exported. The simulator was not rebuilt for this integration.

## Proxy certificate handling (2026-09-28)

- Reproduced model discovery's TLS `UnknownIssuer` failure through the desktop app's inherited local proxy. The environment supplied a CA bundle, but the HTTP client did not load it. A diagnostic using the corrected client and configured roots reached Z.ai's Coding Plan model endpoint through that proxy and received HTTP 401, as expected without an API key. Direct access also reached the endpoint. No user API key or paper content was sent by the diagnostic; authenticated discovery and inference remain unverified.
- All 36 Rust tests pass. New local TLS checks verify rejection of an untrusted certificate, acceptance with the explicitly configured root, continued hostname verification, and the resulting certificate-specific error. Other coverage includes CA bundle precedence and bounds, sanitized transport errors, correct operation names, and cached PDF/database access with invalid PEM or DER trust configuration.
- Rust formatting, Clippy with warnings denied, and diff checks pass. Frontend source is unchanged in this fix.
- The production frontend and native desktop bundle build successfully. The signed physical-iPhone build also succeeds using the existing live Xcode helper. This iPhone build was not installed, the older IPA was not re-exported, and the simulator was not rebuilt. The desktop app's open Settings draft was left untouched while the replacement bundle was built; it must be reopened to load the networking fix.

## Streamed AI drafts and explicit saving (2026-09-28)

- All 161 frontend tests and 48 Rust tests pass. Coverage includes streamed thinking/answer events, listener registration and cleanup, cancellation before and during requests, late responses after navigation, edited proposals, missing-tool fallback, retrying failed saves without another model request, and preserving legacy AI answers when editing notes. Streaming does not re-render the PDF. A delayed annotation snapshot cannot hide a note saved during navigation.
- Local Rust HTTP tests cover fragmented UTF-8, LF/CRLF/CR SSE lines, BOM handling, multi-line events, fragmented tool arguments, bounded responses, provider errors, incomplete/truncated responses, and real socket closure on Stop. Tool-only replies and replies with a preliminary message continue once with preserved reasoning and a draft-only tool result to obtain the final answer. Clear unsupported-tool errors retry once without tools; other HTTP failures do not trigger that retry.
- TypeScript, Rust formatting, Clippy with warnings denied, and diff checks pass. The production frontend and regular native desktop bundle build successfully. The signed physical-iPhone build succeeds using the existing Xcode helper. It was not installed, and neither the simulator nor the older IPA was updated.
- A separate native macOS QA bundle and isolated library used the cached public Attention Is All You Need paper with a keyless loopback mock provider. Native checks verified live expandable thinking, a completed answer replacing the preliminary message, editable model-proposed note content, explicit Save and disabled Saved state, and Stop with an incomplete response. The database held zero annotations after answering, one after Save, and still one after cancellation. The saved note retained the reviewed text and original answer without thinking text.
- The QA run did not read or transmit a real provider key, contact an external model, or change the open production app's Settings draft. Actual cloud model output and physical-iPhone interaction remain unverified.

## Persistent AI conversations (2026-09-29)

- All 177 frontend tests and 63 Rust tests pass. TypeScript, Rust formatting, all-targets Clippy with warnings denied, and diff checks pass. Coverage includes completed-only conversation history, explicit tool-based note generation, unsupported/malformed proposal errors, interrupted request recovery, per-conversation operation guards, immutable/idempotent note saving, schema v2→v3 migration, reopening history, cross-paper responses, draft edit/save races, and stale background refreshes. Streaming remains independent of PDF rendering, and the Notes-only scroll behavior is preserved.
- Native macOS QA used the cached public Attention Is All You Need paper, an isolated library, and a keyless loopback model fixture. Asking then following up produced two persisted turns without creating an annotation or updating the first draft. Generate new note sent both completed answers and produced a fresh editable tool proposal. After editing the draft and restarting the app, the two answers and edited draft reopened; transient thinking did not return. Save created exactly one additional annotation, retaining both source answers and the original paper/selection anchor. No thinking was present in the stored conversation or annotation.
- The final production frontend, native desktop app bundle, and ad-hoc signed iPhone simulator app build successfully. The updated app was installed over the existing iPhone 16 simulator library and launched using the existing Xcode helper. Conversation interaction was verified in the native desktop app and automated UI tests; this feature's conversation controls have not been manually exercised on the simulator or a physical iPhone. The physical-device app and older IPA were not rebuilt in this pass.
- The QA run did not use a real provider key or an external model. Cloud-provider inference remains unverified for this feature; provider request behavior is covered by local HTTP fixtures.

## Portrait AI on iPhone (2026-09-29)

- All 196 frontend tests and 64 Rust tests pass. TypeScript, Rust formatting, all-targets Clippy with warnings denied, and diff checks pass. New tests cover waiting for native portrait confirmation, Back/Escape restoration, serialized transitions and unmount cleanup, stale errors, retained selection and unsent questions, continuing model requests while closed, unknown device detection failures, narrow iPad layout, and focus wrapping with collapsed conversations.
- The production frontend, native desktop bundle, and ad-hoc signed iPhone simulator app build successfully. The updated app was installed over the existing iPhone 16 simulator library and launched using the existing Xcode helper. Simulator screenshots confirm launch, but touch automation returned `noWindowsAvailable` or left the interface unchanged even after raising/reselecting the window. Actual portrait entry, keyboard layout, and return rotation therefore remain unverified by native interaction; automated lifecycle tests and the iOS compilation are the current evidence.
- The physical-device app and older IPA were not rebuilt or installed in this pass. No external AI request or real provider credential was used for these checks.

## Library home, previews, and paper tabs (2026-09-29)

- All 248 frontend tests and 82 Rust tests pass. TypeScript, Rust formatting, all-targets Clippy with warnings denied, and diff checks pass. Tests cover metadata-only previews and their two actions, explicit download/retry, cancellable cooldowns, durable recency, direct cached resume, phone close/history, iPad/Mac tabs and source return paths, independent drafts, removal rollback/recovery, and late download/AI/save responses after deletion.
- The production frontend and native desktop bundle build successfully. An isolated macOS QA app shows the new Library home, opens a cached PDF directly with a tab, returns home when its final tab closes, and displays the removal confirmation with focus restored after Cancel. Existing QA papers and notes were retained; transactional deletion tests use temporary libraries.
- A live public arXiv lookup entered the rate-limit waiting state with a visible retry time. Cancel immediately restored the form and retained the entered ID. arXiv did not supply fresh metadata during that check, so the successful preview/download path is covered by local HTTP fixtures and UI integration tests rather than a successful live download in this pass. HTTP fixtures verify both metadata and PDF 429 responses, Retry-After seconds/dates, bounded retries, persisted cooldown, cancellation, exact revision pinning, and no library row before confirmation.
- The ad-hoc signed iPhone simulator build is installed over the existing app and launches the new Library home with both saved papers retained. The landscape home respects the notch-safe edges. Simulator scroll/swipe automation left the interface unchanged, so this pass does not claim native touch coverage of the new reader/preview actions; desktop interaction and automated UI tests cover them.
- No real model request or provider credential was used for this pass. The physical-device app and older IPA have not been rebuilt or installed.

## Xcode incremental archive linking (2026-09-29)

- Native verification caught an Xcode build that recompiled Rust but kept the previous app executable. The generated Frameworks entry lowered to `-lapp` and did not identify the actual archive as a linker input. The launcher now supplies the architecture/configuration-specific archive explicitly in `OTHER_LDFLAGS`, preserves existing flags, and updates the XcodeGen template without restarting the running Tauri helper.
- The rebuilt link command consumes the current archive, and its linker dependency record includes that exact file. One Xcode clean/build refreshed inconsistent cached signing outputs; the subsequent ordinary incremental build succeeds, and strict/deep signature verification passes. The freshly installed simulator app visibly shows the new Library UI.
- Thirteen launcher fixture tests cover archive/output matching, repeated preparation, existing scalar/list linker flags, regeneration settings, and leaving unknown configurations untouched. The existing 248 frontend tests remain green. Generated Xcode files and local signing settings remain outside Git.

## iOS app icon synchronization (2026-09-29)

- The tracked Papertrail artwork was correct, but the generated Xcode catalog still contained Tauri's default icon. Project preparation now copies the 18 referenced canonical iOS PNGs after checking that every source exists and has the required dimensions. A second preparation copies zero files; existing catalog metadata and unrelated images are preserved.
- All 20 focused icon/Xcode launcher tests, strict script TypeScript, and diff checks pass. The iPhone simulator build recompiles the asset catalog, builds successfully, and passes strict/deep signature verification.
- The app was installed over the existing iPhone 16 simulator app without uninstalling it. Native home-screen inspection confirms Papertrail's green paper-and-check icon. The artwork itself and desktop icons are unchanged. The physical iPhone and older IPA were not updated in this pass.

## Inline references and shared citation details (2026-09-29)

- The complete Vitest run passed 309 tests; the final additional native-link association regression and affected reader/identifier tests also pass (310 tests now in the suite). All 87 Rust tests pass with local HTTP fixtures. TypeScript, Rust formatting, all-target Clippy with warnings denied, and diff checks pass.
- Real cached PDFs yielded all 40 numbered Attention Is All You Need references and 56 hanging-indent BERT references. Their 76 and 209 embedded bibliography citation links respectively matched unambiguous source entries. Metadata was separated for 39/40 and 54/56 entries; uncertain entries retain the original citation. This is fixture coverage, not a guarantee for arbitrary paper layouts.
- Native macOS QA verified a PDF citation opening formatted details, View bibliography landing on the correct source page, Back restoring the citing page, and a compact reference row beneath the corresponding Reading block. Clicking that row opens the same details. A live arXiv request for 1705.03122v2 returned the title, authors, exact revision, and abstract; Cancel returned to the existing Reading view without downloading or adding a paper. The isolated library and its notes/chats were retained.
- The production macOS bundle and ad-hoc signed iPhone simulator app build successfully. Strict/deep signature verification passes, and the updated simulator app is installed and launches with both saved papers retained. Simulator touch automation returned windowNotFoundAtPosition, so reference interaction was verified on native macOS and in automated reader/workspace tests, not through simulator touch or on a physical iPhone. The older physical-device app/IPA was not updated.
- PDF citation taps use embedded links; scanned/unlinked citations do not gain synthetic tap targets. Reference extraction failures leave the PDF readable. New rows wait for active zoom gestures to finish, and metadata lookup does not trigger automatic arXiv downloads.

## Reference publication subtitles (2026-09-29)

- All 26 affected reference UI/parser tests and the frontend build pass. Coverage includes arXiv precedence, raw entries with known identifiers, journal pagination, conference page ranges, and preserving meaningful venue numbers and the original citation.
- The Attention and BERT fixtures retain 40/56 references and all 76/209 citation links. Their subtitles now show arXiv identifiers or venues without pagination; the joined Attention Visualizations heading no longer contaminates the final reference.
- The macOS bundle and ad-hoc signed iPhone simulator build succeed. The simulator signature passes strict/deep verification, and the update was installed over the existing iPhone 16 app and launched. This refinement was checked with automated UI tests and real PDF extraction; native touch interaction and the physical-device app were not updated or verified in this pass.

### Author and year retained in subtitles

- The second line now combines author, year, and arXiv identifier or venue. Compact rows retain the first author; details and match results retain every author. Missing fields are omitted without stray separators, and uncertain entries keep their existing raw presentation.
- All 13 affected reference UI tests pass, including arXiv priority, venue pagination removal, and missing-field fallbacks. The frontend and macOS/iOS simulator builds succeed. The signed simulator app was verified, installed over the existing library, and launched; this follow-up did not include native touch testing or a physical-device build.

## Selected PDF text ghosting (2026-09-29)

- Native Mac reproduction showed a second set of glyphs over the selected word in Reading view. The global `::selection` style supplied a dark foreground to PDF.js's normally transparent text layer; the PDF-specific rule overrode only the background. This is a selection styling defect shared by original PDF pages, Reading crops, and enlarged figures.
- The PDF text-layer selection rule now explicitly keeps the foreground transparent while preserving the highlight background. The canvas remains the visible text, and the selectable DOM still supplies the word and annotation anchors. All 39 affected reader, page, and selection tests pass.
- Native Mac before/after checks on the cached Attention paper confirm that selecting “mechanism” in Reading view no longer paints duplicate lettering. Original PDF selection is also clean at 167%, and selecting “Transformer” after zooming to 182% remains clean. The native accessibility selection reports the correct word and the highlight remains visible. Back restores the original Reading passage.
- The frontend, isolated QA bundle, and regular macOS bundle build successfully. This Mac-focused correction did not rebuild or interaction-test the simulator or physical iPhone.

## Hyperlink classification and reading-mode navigation (2026-09-29)

- All 393 frontend tests pass. Coverage includes official arXiv URL classification, unsafe URL rejection, citation-popup precedence in both modes, rotated PDF destinations and crop mapping, mode inheritance through cached papers/metadata previews/downloads/existing tabs, history restoration, and external confirmation/cancel/retry. Deferred destination and paper-load tests verify that superseded work cannot navigate behind a dialog. TypeScript and diff checks pass.
- Native macOS QA on the cached Attention paper confirms that an embedded bibliography citation still opens its formatted popup. View bibliography reaches the source entry in Reading mode; Back restores the source. A document outline jump to Model Architecture also stays in Reading mode. View on arXiv shows the domain and full URL with Cancel initially focused; Escape restores the information sheet. No browser was opened during native QA; confirmed opener calls, duplicate clicks, and failure/retry are verified with mocked native calls.
- The production frontend, isolated QA bundle, regular macOS bundle, and ad-hoc signed iPhone simulator app build successfully. Strict/deep simulator signature verification passes; the update is installed over the existing library and launches successfully. Rust commands and stored schemas are unchanged. Native interaction was checked on macOS; simulator touch flows and a physical iPhone were not interaction-tested in this pass. The physical-device app and older IPA were not rebuilt.

## Reading-mode pinch background overlap (2026-09-29)

- The Mac report occurs only during trackpad pinch. Reading previews transform cropped PDF wrappers, while their parent articles previously retained white backgrounds and stationary reference/action rows. Those layers remained at the original size and could cover the moving crops. The Reading background also lived on the content strip rather than the full scroll viewport.
- During preview, article backgrounds are now transparent and reference/action rows are invisible while retaining their layout space. Only the cropped paper scales; ending or cancelling restores the rows. The scroll viewport paints a uniform Reading background, including horizontal overflow. Canvas buffering and gesture rendering frequency are unchanged.
- All 77 affected viewer, crop, figure, and gesture tests pass. Two new regressions load the real CSS and exercise Safari gesture events at increasing/decreasing scales, finished/cancelled previews, reference rows, figure controls, offscreen blocks, fixed toolbar geometry, retained source anchors, and no extra PDF rendering during preview. TypeScript and diff checks pass.
- An isolated native Mac QA build with temporary, controlled preview transforms reproduced the old white shells and reference overlap on the cached Attention paper. The same reduced and enlarged previews after the fix show only the scaled crops against a uniform background, and resetting restores the references. This verifies native paint composition; physical trackpad input was not automated. Temporary controls are excluded from source control and the clean app builds. This Mac-focused pass does not rebuild or test iOS.
- The production frontend, clean QA app, and regular macOS app build successfully. The temporary preview script is absent from the clean frontend output.

## References remain visible during Reading zoom (2026-09-30)

- The disappearing cards were the intentional preview visibility rule from the previous fix, not lost reference data. Reading previews now transform each passage article, including its crop, background, reference cards, and source actions. Cards remain visible and aligned with their passage; the reader toolbar remains outside the transform. Unrendered offscreen articles remain hidden to prevent stationary backgrounds from overlapping the preview.
- Visible articles whose long reference lists outlast their offscreen crop bitmap are included. Preview transforms still reuse existing bitmaps without PDF raster or text-layer work; ending or cancelling clears the article transforms and restores interaction.
- All 78 focused viewer, crop, figure, and gesture tests pass. Real-CSS regressions cover zoom in/out with moving midpoints, reference title/subtitle visibility, offscreen article suppression, visible reference-only articles, preserved PDF anchors and toolbar geometry, finish/cancel cleanup, and reference popups after scrolling.
- Native Mac controlled previews at 1.6× and 0.65× keep reference cards visible without white-background overlap. Resetting, scrolling, and opening a reference details popup succeeds. This checks native paint composition with temporary preview controls; physical trackpad input was not automated. The temporary controls are excluded from tracked source and clean builds. iOS was not rebuilt in this Mac-focused pass.
- TypeScript, frontend, clean QA and regular macOS builds pass. Diff checks pass, and the clean frontend contains no injected preview controls.

## Continuous pinch and proportional reference cards (2026-09-30)

- The user confirmed that reference cards should scale with the paper and reported roughness while fingers were moving. Native WebKit tracing found a premature cancellation: entering preview changes `clientWidth` from 1088 to 1094 when the scrollbar disappears, although the reader's 1094-pixel border box remains unchanged. The resize callback treated this as a real resize, cleared the preview, and detached the gesture after its first frame.
- PDF, Reading, and enlarged-figure viewers now ignore scrollbar-only changes during preview while still cancelling for an actual viewport resize. The content width is frozen for the gesture, preventing recentering or Reading fit-width changes when the gutter disappears. Reading preview layers are restricted to the transformed viewport plus 128 pixels of overscan using cached geometry; unannotated pages no longer allocate an empty blended highlight SVG.
- Reference fonts, padding, buttons, icons, source actions, and passage gaps use the committed Reading scale. They therefore retain the requested paper-relative size after release. The reader toolbar and standalone figure-dialog controls retain their normal sizes.
- All 90 focused tests pass. New regressions cover scrollbar-only width/height changes, genuine resizes, 60 Reading frames with no geometry reads or PDF/text rendering, offscreen promotion on zoom-out, scaled reference metrics, and preserved annotation geometry. CSS metric tests substitute the custom variable because JSDOM cannot resolve inherited custom properties; native WebKit verifies the actual inherited font size.
- In an isolated native QA app, a synthetic 150-frame Safari gesture previously retained preview for only 1 frame. With the resize guard it remains active for all 150 frames (17 ms median, 22 ms p95 in that run). Reference text grows from 13.584193 px to 20.376289 px after a 1.5× gesture, as expected. Controlled all-layer versus bounded-layer runs reduced average promoted articles from 19 to 10.6; their median frame times were both 17 ms, so this is evidence of less compositing work, not a measured frame-rate improvement. These are synthetic native tests, not physical trackpad measurements. Temporary diagnostics are not tracked or included in clean builds. iOS was not rebuilt in this Mac-focused pass.
- The final frontend, clean QA app, and regular macOS app build successfully. TypeScript and diff checks pass; the clean frontend contains neither temporary benchmark nor preview scripts.

## Proportional Reading block gaps (2026-09-30)

- The production stylesheet loaded the generic PDF container's fixed 12px gap after Reading's scaled gap. Equal specificity meant the fixed value won, so preview spacing scaled correctly but settled spacing did not. The shared container now owns one gap rule using the Reading zoom variable, with a scale of one for the original PDF.
- All 89 affected reader, reference, figure, and gesture tests pass. CSS fixtures now include both container classes and the production import order; the regression failed against the old styles and passes at 0.1×, 0.75×, 1×, 2×, and 3×. TypeScript and diff checks pass.
- A temporary native WebKit fixture using the bundled app styles measured Reading gaps of approximately 1.2px, 12px, and 36px at 0.1×, 1×, and 3×; original PDF spacing remains 12px. The smallest actual layout gap is 1.188px after WebKit subpixel rounding. This verifies CSS inheritance and native layout, not physical trackpad interaction.
- The frontend, clean QA app, and regular macOS app build successfully. Temporary diagnostics are excluded from the clean builds and Git. iOS was not rebuilt in this Mac-focused pass.
