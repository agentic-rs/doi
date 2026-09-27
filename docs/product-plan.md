# Paper reader — proposed first release

Status: first implementation complete. PDF.js is accepted as the renderer; annotations use the app's versioned format. AI provider settings are user-configurable. See [verification notes](./verification.md).

## Core experience

Open an arXiv paper, follow its citations, ask about a selected passage, save the answer beside that passage, and return to the exact place where the exploration began.

The first release treats discovery as following references and reopening the local library. Topic recommendations and a general paper search engine are separate features.

## Proposed defaults

- Local desktop app using Tauri 2, Rust, React, and TypeScript.
- Original PDF layout with selectable text using PDF.js.
- An app-owned, versioned annotation format, independent of the PDF engine and its annotation editor.
- A local library, cached PDFs, and saved annotations that remain usable offline.
- A user-configured AI provider; provider details remain an open decision.
- User-directed reference exploration. Automatic AI traversal requires a separate decision about depth, context, and cost.
- No website creation or deployment.

## Screen and interaction plan

### Library and opening a paper

A compact library sidebar lists downloaded papers. An input accepts modern and legacy arXiv IDs, optional version suffixes, and arXiv abstract/PDF URLs.

Opening a paper validates the input, loads its metadata, downloads and caches the PDF, then opens the reader. Reopening a cached paper restores its saved reading position. A specified version stays pinned to that version; annotations attach to the PDF revision, not just the unversioned arXiv ID.

Show distinct states for an empty library, invalid input, metadata lookup, download progress, unavailable paper, and network failure. A failed operation leaves the existing paper readable and offers retry.

### Reader

The center pane displays the PDF with selectable text, page navigation, zoom, and an outline when available. Back and Forward sit in the main reader toolbar.

An optional right pane has references and annotations. It can close to give the paper more room. Loading or failed auxiliary data should not prevent reading the PDF.

The reader integrates reusable rendering, text-selection, and link primitives behind a small adapter. The app owns the toolbar, annotation overlay, annotation persistence, and cross-paper navigation. Existing PDF links remain available independently of the app's custom annotation layer. See [reader architecture review](./reader-architecture.md).

### Following references

Internal PDF links jump to their destinations. Links containing an explicit arXiv identifier open that paper inside the app and cache it on demand. A bibliography entry can expose a detected arXiv ID or DOI when present.

A DOI or plain-text citation may need resolution before a readable PDF can be opened. Keep the original citation visible and show candidate matches rather than automatically choosing an uncertain result. If a readable copy is unavailable, show the source link and allow the user to continue reading the current paper.

Reference extraction is a separate pipeline from paper downloading: the arXiv metadata API does not supply the paper's bibliography. Start with embedded destinations and explicit identifiers, then expand citation matching against representative papers.

### Selection questions and annotations

Selecting text reveals an Ask AI action. The question panel previews the selection and the context that will be sent: the selected text, nearby text, and paper metadata. Broader paper context can be added explicitly.

The result stays attached to that selection as an annotation, with the original question and provider/model information. Keep the draft question on failure and offer retry. Allow editing and deletion of saved notes.

Persist page-specific quadrilaterals in unscaled PDF user-space coordinates, plus the selected quote and surrounding text. Convert between PDF and screen coordinates at the reader boundary so highlights survive zoom and rotation. A selection spanning pages has multiple page anchors. Never silently move annotations to another PDF revision.

Store annotations in the app's schema, with a schema version, stable IDs, target anchors, and typed content for notes or AI answers. Preserve the original PDF; a portable sidecar export is proposed. PDF.js editor objects, DOM ranges, text-span indices, and screen pixel positions must not become the persistent format. The exact schema and export requirements remain open.

### Back and Forward

Navigation records paper revision, page, position within the page, and zoom. Internal citation jumps and opening another paper both create history entries. Ordinary scrolling updates the active location rather than filling history with scroll events.

Before following a link, capture the source position. Back restores it; Forward restores the destination. A new jump after Back discards the forward branch. A failed destination load does not lose the source position.

## Command plan

All network and file operations use async Rust command handlers. Keep invocation wrappers in `src/lib/tauri.ts`; keep the app entry points small and place domain logic in modules.

Proposed commands:

- `open_arxiv_paper`: normalize and validate input, resolve metadata, and fetch/cache a PDF.
- `list_papers`: return local library summaries.
- `get_paper`: return cached metadata and a handle for accessing PDF bytes.
- `save_reading_position`: persist a paper's last location.
- `resolve_reference`: look up an explicit identifier or return citation-match candidates.
- `ask_selection`: send the chosen text/context and question to the configured provider.
- `save_annotation`, `list_annotations`, `delete_annotation`: manage passage-linked notes.
- `save_annotation_file`: export a validated sidecar through a native Save dialog, returning the written path or cancellation.
- `get_settings`, `save_settings`: manage provider and reader preferences.

Downloads and AI requests report progress/status through events carrying a `request_id`, so late responses cannot replace another paper or selection. UI operations must be cancelable or safely discard stale results. Serialize and throttle arXiv API requests according to its usage policy.

Rust owns remote requests to avoid webview cross-origin restrictions. Provider credentials must not be persisted in frontend storage or included in logs; choose a native credential store once the provider design is confirmed.

## Data model plan

Shared frontend contracts live in `src/lib/types.ts` and map to Rust models. Persisted and serialized fields use `snake_case`.

- `Paper`: `paper_id`, `arxiv_id`, `arxiv_version`, `title`, `authors`, `abstract`, `pdf_url`, `pdf_hash`, `downloaded_at`.
- `ReadingLocation`: `paper_id`, `page_number`, `page_position`, `zoom`, `rotation`.
- `Reference`: `reference_id`, `source_paper_id`, `citation_text`, `arxiv_id`, `doi`, `source_anchor`, `resolution_status`.
- `PageAnchor`: `page_number`, `quad_points`, `text_quote`.
- `TextQuote`: `exact_text`, `prefix`, `suffix`, `normalization_version`.
- `AnnotationTarget`: `paper_id`, `pdf_hash`, `page_anchors`.
- `Annotation`: `schema_version`, `annotation_id`, `target`, `body`, `created_at`, `updated_at`.
- `AnnotationBody`: a discriminated content model for a note or an AI answer; an AI answer retains `question`, `answer`, `provider_id`, `model_id`, and the context actually sent.
- `AiSettings`: `provider_id`, `base_url`, `model_id`, `credential_id`.
- `NavigationHistory`: `entries`, `current_index`.

Use a versioned SQLite schema for metadata and annotations, with PDFs stored separately in the app data directory. Use atomic download completion so an incomplete PDF is never treated as a cached success.

## Delivery order

1. Evaluate the PDF reader against app-owned annotation requirements; bootstrap the desktop app and icons, then implement ID validation, download/cache, library, and PDF reading.
2. Add position tracking and Back/Forward for internal links and cross-paper navigation.
3. Add reference inspection and explicit arXiv reference opening; make unresolved references visible.
4. Add provider settings, selection questions, and persistent anchored annotations.
5. Broaden reference resolution after inspecting actual failure cases.

## Acceptance checks

- Enter a valid arXiv ID, read its PDF, restart, and reopen the cached paper without another download.
- Support a legacy ID and an explicitly versioned ID; reject malformed IDs before making a request.
- Follow an internal citation, then return to the same location and zoom.
- Follow an explicit arXiv reference to another paper; Back and Forward restore each paper's location.
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
