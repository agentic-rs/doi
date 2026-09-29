# Paper reader — product flow and implementation

Status: first implementation complete. PDF.js is accepted as the renderer; annotations use the app's versioned format. AI provider settings are user-configurable. See [verification notes](./verification.md).

## Core experience

Open an arXiv paper, follow its citations, ask about a selected passage, save the answer beside that passage, and return to the exact place where the exploration began.

The first release treats discovery as following references and reopening the local library. Topic recommendations and a general paper search engine are separate features.

## Proposed defaults

- Local desktop app using Tauri 2, Rust, React, and TypeScript.
- Original PDF layout with selectable text using PDF.js.
- An app-owned, versioned annotation format, independent of the PDF engine and its annotation editor.
- A local library, cached PDFs, and saved annotations that remain usable offline.
- User-configured AI providers through embedded Tokn components, with keys in the native credential store.
- User-directed reference exploration. Automatic AI traversal requires a separate decision about depth, context, and cost.
- No website creation or deployment.

## Screen and interaction plan

### Library and opening a paper

The home screen lists recently opened papers, a library search, and an input accepting modern and legacy arXiv IDs, version suffixes, and arXiv abstract/PDF URLs. Recency survives restart through `last_opened_at`, with download time as the fallback for papers not yet opened.

**Find paper** validates the input and retrieves metadata only. The preview shows title, authors, ID/version, and abstract, with exactly **Download & add to library** and **Cancel**. Cancel leaves the input intact and does not add a paper. Confirmation downloads the PDF, adds the completed paper to the library, and opens the reader. A failed download keeps the preview for retry without repeating metadata lookup. A cached lookup result opens directly without a new download.

Reopening a library paper restores its position and reading mode directly; **Info** optionally shows metadata over the reader. **View on arXiv** in that information sheet deliberately opens the website through browser confirmation. An explicit arXiv version stays pinned, and annotations attach to the exact PDF revision.

Metadata and PDF requests share one serialized arXiv connection and at least three seconds between requests. HTTP 429 produces a waiting state with a retry deadline. The app respects `Retry-After`, otherwise applies increasing delays with jitter, and stops after three automatic retries. The cooldown is saved for app restarts. Cancel stops queued work, waiting, network requests, and incomplete downloads; completed cached papers remain usable offline. A cancellation that arrives after the atomic download commit keeps the saved paper in the library without unexpectedly opening it.

**Close paper** keeps library data and the reading position. iPhone has one active reader. iPad and Mac maintain paper tabs, reuse an existing tab for the same revision, and return home after the last tab closes. Returning home retains open desktop/iPad tabs. Each tab retains its selection, unsent question, manual-note draft, and navigation history when switching away.

**Remove** in a library paper's menu requires confirmation explicitly naming the downloaded PDF, notes, and AI conversations. Successful removal deletes those records and the derived reading cache, stops that paper's AI requests, closes its tabs, and removes references to it from navigation history. Failed removal leaves the paper available and reports the error in the confirmation dialog.

### Reader

The center pane displays the PDF with selectable text, page navigation, zoom, and an outline when available. Back and Forward sit in the main reader toolbar.

An optional right pane has references and annotations. It can close to give the paper more room. Loading or failed auxiliary data should not prevent reading the PDF.

The reader integrates reusable rendering, text-selection, and link primitives behind a small adapter. The app owns the toolbar, annotation overlay, annotation persistence, and cross-paper navigation. Existing PDF links remain available independently of the app's custom annotation layer. See [reader architecture review](./reader-architecture.md).

### Following references

Hyperlinks distinguish PDF destinations, app destinations, and external websites. PDF links, including figure, section, page, and outline destinations, jump within the current paper while preserving PDF or Reading mode. Official arXiv paper URLs are app destinations: they open a saved paper directly or preview an unsaved paper before any download. Other valid HTTP(S) links are external, including DOI links and PDFs hosted elsewhere. Classification is local and does not resolve redirects or request metadata.

Citations keep their existing details popup. Reading reference rows and recognized embedded bibliography citation links open details without moving the paper, before any ordinary hyperlink routing. A bibliography entry can expose a detected arXiv ID, DOI, or URL. Its actions and match results share the hyperlink classification, preferring the arXiv ID, then DOI, then URL; an arXiv paper URL alone is enough to offer **Preview paper**.

**View bibliography** jumps to the source entry in the current mode and participates in Back/Forward history. **View in PDF** explicitly switches a Reading block or figure to the original PDF. Following an app link to another paper inherits the source reader's mode while preserving the destination's saved page and position, fitting the corresponding page or block if its mode changes. Reopening from the library or switching tabs continues to restore that paper's saved mode.

External links show a confirmation with the domain, full URL as plain text, **Open in browser**, and **Cancel**, initially focused on Cancel. The browser opens only after confirmation. While opening, repeat actions and dismissal are disabled. Failure leaves the dialog available for retry; cancellation leaves the paper and position intact and returns to any reference details or paper information underneath. The native opener accepts only bounded HTTP(S) URLs with a host and no embedded credentials.

A DOI or plain-text citation may need resolution before a readable PDF can be opened. Keep the original citation visible and show candidate matches rather than automatically choosing an uncertain result. If a readable copy is unavailable, show the source link and allow the user to continue reading the current paper.

Reference extraction is a separate pipeline from paper downloading: the arXiv metadata API does not supply the paper's bibliography. Start with embedded destinations and explicit identifiers, then expand citation matching against representative papers.

### Selection questions and annotations

Selecting text reveals an Ask AI action. The question panel previews the selection and the context that will be sent: the selected text, nearby text, and paper metadata. Broader paper context can be added explicitly.

Answers form a persistent conversation anchored to the original selection. Follow-ups continue that conversation; **Generate note** asks the model for a proposed note, and **Save note** explicitly creates an annotation. The first answer can include a suggested note. Keep unsaved drafts on failure and allow editing and deletion of saved notes. Returning home, changing tabs, or closing a reader does not cancel running AI; removing the paper does.

Persist page-specific quadrilaterals in unscaled PDF user-space coordinates, plus the selected quote and surrounding text. Convert between PDF and screen coordinates at the reader boundary so highlights survive zoom and rotation. A selection spanning pages has multiple page anchors. Never silently move annotations to another PDF revision.

Store annotations in the app's schema, with a schema version, stable IDs, target anchors, and typed content for notes or AI answers. Preserve the original PDF and export annotations as a portable JSON sidecar. PDF.js editor objects, DOM ranges, text-span indices, and screen pixel positions are not persistent anchors.

### Back and Forward

Navigation records paper revision, page, position, zoom, rotation, reading mode, and optional reading block. Ordinary scrolling updates the active location rather than filling history with scroll events.

On iPhone, internal paper jumps and cross-paper links share the active reader's history. Opening a citation popup alone does not navigate. Back restores the captured source position and reading mode; Forward restores the destination. On iPad and Mac, each paper tab owns its history, and a paper reference opens or focuses another tab with a **Back to source** action. A new jump after Back discards the forward branch. Failed destination loads preserve the source, and deleted papers are pruned from stored sessions and history.

## Command plan

All network and file operations use async Rust command handlers. Keep invocation wrappers in `src/lib/tauri.ts`; keep the app entry points small and place domain logic in modules.

Library commands:

- `preview_arxiv_paper`: validate input and return revision-bound metadata plus an opaque preview token, without downloading or saving a paper.
- `download_arxiv_paper`: use that preview token to download and atomically save the confirmed PDF; reuse a cached copy when available.
- `cancel_paper_operation`: cancel lookup or download by request ID, including queued work and cooldown waits.
- `list_papers`: return local papers ordered by most recent opening, falling back to download time.
- `mark_paper_opened`: persist recency while preserving metadata and the reading position.
- `remove_paper`: invalidate pending previews and delete the PDF and all dependent local records after UI confirmation.
- `get_pdf_bytes`: read a validated cached PDF.
- `save_reading_position`: persist a paper's last location.
- `resolve_reference`: look up an explicit identifier or return citation-match candidates.
- `list_ai_conversations`, `ask_ai_conversation`, `generate_ai_conversation_note`, `update_ai_conversation_note`, `save_ai_conversation_note`, `cancel_ai_request`: load conversations, stream answers, prepare and review notes, save explicit annotations, and stop work.
- `save_annotation`, `list_annotations`, `delete_annotation`: manage passage-linked notes.
- `save_annotation_file`: export a validated sidecar through a native Save dialog, returning the written path or cancellation.
- `get_settings`, `save_settings`: manage provider and reader preferences.

Downloads and AI requests report progress/status through events carrying a `request_id`, so late responses cannot replace another paper or selection. UI operations must be cancelable or safely discard stale results. Serialize and throttle arXiv API requests according to its usage policy.

Rust owns remote requests to avoid webview cross-origin restrictions. Provider credentials remain in the native credential store and are excluded from frontend persistence and logs.

## Data model plan

Shared frontend contracts live in `src/lib/types.ts` and map to Rust models. Persisted and serialized fields use `snake_case`.

- `PaperMetadata`: revision ID, arXiv ID/version, title, authors, abstract, and PDF URL.
- `PaperPreview`: `preview_id`, `metadata`, and optional `library_paper`; previews are temporary in-memory records.
- `Paper`: metadata plus `pdf_hash`, `downloaded_at`, optional `last_opened_at`, and `last_location`.
- `ReadingLocation`: `paper_id`, `page_number`, `page_position`, `zoom`, `zoom_mode`, `rotation`, `reader_mode`, and optional `reading_block_id`.
- `ReaderTarget`: a PDF location, a reference for the citation popup, or a `PaperUrlTarget` distinguishing an app arXiv destination from an external URL.
- `Reference`: `reference_id`, `source_paper_id`, `citation_text`, `arxiv_id`, `doi`, `source_anchor`, `resolution_status`.
- `PageAnchor`: `page_number`, `quad_points`, `text_quote`.
- `TextQuote`: `exact_text`, `prefix`, `suffix`, `normalization_version`.
- `AnnotationTarget`: `paper_id`, `pdf_hash`, `page_anchors`.
- `Annotation`: `schema_version`, `annotation_id`, `target`, `body`, `created_at`, `updated_at`.
- `AnnotationBody`: a discriminated content model for a note or an AI answer; an AI answer retains `question`, `answer`, `provider_id`, `model_id`, and the context actually sent.
- `AiSettings`: `provider_kind`, `base_url`, `model_id`, and derived `has_api_key` presence.
- `NavigationHistory`: `entries`, `current_index`.

SQLite schema v4 stores metadata, positions, annotations, reading caches, and AI conversations; PDFs are separate files in the app data directory. Atomic download completion prevents incomplete PDFs from appearing as cached successes. Paper removal uses a staged PDF move and a database transaction with cascading deletes; failure restores the file, and startup repairs interrupted removals.

## Delivery order

1. Evaluate the PDF reader against app-owned annotation requirements; bootstrap the desktop app and icons, then implement ID validation, download/cache, library, and PDF reading.
2. Add position tracking and Back/Forward for internal links and cross-paper navigation.
3. Add reference inspection and explicit arXiv reference opening; make unresolved references visible.
4. Add provider settings, selection questions, and persistent anchored annotations.
5. Broaden reference resolution after inspecting actual failure cases.

## Acceptance checks

- Enter an arXiv ID, inspect its abstract without downloading, then confirm download or cancel with the input retained. Restart and reopen saved papers directly in recency order.
- Support a legacy ID and an explicitly versioned ID; reject malformed IDs before making a request.
- Open a citation popup without moving the paper; use **View bibliography** in either mode, then return to the same location and zoom. Figure, section, page, and outline links preserve the mode; **View in PDF** switches explicitly.
- Follow an arXiv reference: preview unsaved papers, inherit the source reading mode while preserving the target position, restore cross-paper locations on iPhone, and return through **Back to source** with separate tab histories on iPad/Mac.
- Follow an external link or **View on arXiv**, inspect its domain and full URL, then confirm or cancel. Verify a failed browser launch allows retry and cancellation preserves any underlying reference popup and reader position.
- Close a reader or the last tab and return home without deleting library data.
- Confirm removal and verify PDF, notes, chats, and reading cache are deleted; late download/AI completions cannot restore the removed records.
- Simulate metadata and PDF HTTP 429 responses, honor cooldowns across restart, and cancel waits without affecting cached reading.
- Start a new navigation after Back and verify that the previous forward branch is removed.
- Ask about a selection, save the answer, restart, and revisit the annotation at the same passage.
- Zoom after annotating and verify that highlights still align with the selected text.
- Verify selection/highlight alignment after rotation, on cropped pages, and across multiple pages.
- Export and reimport an annotation without persisting viewer objects or changing the original PDF.
- Simulate a failed download or AI request and verify that the current paper and question draft survive.
- Try reference behavior on PDFs with embedded links and PDFs with plain bibliography text.

## Source notes

- [arXiv API user manual](https://info.arxiv.org/help/api/user-manual.html)
- [arXiv API terms of use](https://info.arxiv.org/help/api/tou.html)
- [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
- [Tauri command interface](https://v2.tauri.app/develop/calling-rust/)
- [Crossref bibliographic lookup](https://github.com/CrossRef/rest-api-doc)

## Future decisions

1. Whether to add embedded annotations to exported PDFs alongside the current sidecar format.
2. Whether to broaden discovery beyond reference exploration.
3. Whether to add automatic AI traversal of references.
4. How to migrate anchors deliberately between paper revisions.
