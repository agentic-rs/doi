# Reader engine and annotation ownership

Status: PDF.js accepted and implemented with app-owned annotation storage and overlays. Geometry and selection behavior have automated coverage. Native simulator checks cover paper information, full-screen reading, portrait/landscape changes, reference following, and Back/Forward. Physical-device selection, highlight alignment, and alternative-engine benchmarks remain unverified. See [verification notes](./verification.md).

## Decision being considered

An app-owned annotation format is compatible with PDF.js. The important boundary is between PDF rendering and the app's annotation domain. Selecting an engine should depend on rendering fidelity, selection behavior, link access, performance, and packaging rather than whether it offers its own annotation editor.

PDF.js provides the Apell/React reader. Prefer composing its documented display API and reusable viewer components inside our reader. Evaluate the components we need before committing to either the full viewer or rebuilding page management ourselves. Avoid a viewer fork or changes to PDF.js internals.

## Ownership

| Concern | Owner |
| --- | --- |
| Parse PDF and render pages | PDF engine |
| Extract text, page geometry, and embedded links | PDF engine, normalized by reader adapter |
| Capture selection and translate screen coordinates | Reader adapter |
| Document revision and content hash | App |
| Annotation schema, migrations, and storage | App |
| Highlight overlay and AI discussion UI | App |
| Library home, paper tabs, per-reader history, and reference return paths | App |
| Paper information and reading controls | App |
| Native screen orientation | Platform reader plugin |
| Optional export into another format | App export adapter |

Keep the adapter small and driven by actual needs. We need page metrics, selection anchors, link targets, coordinate conversion, and navigation events. We do not need a general plugin system or multiple working engines for the first release.

## Library, preview, and reader lifecycle

The workspace starts at Library home with recent papers, search, and **Add a paper**. `preview_arxiv_paper` returns metadata and an opaque token without fetching a PDF or creating a library row. The preview exposes only **Download & add to library** and **Cancel**. Confirmation calls `download_arxiv_paper` with the token; cancellation retains the input. Metadata stays in a bounded in-memory preview cache so a failed PDF download can retry without another lookup. A cached paper opens directly through `get_pdf_bytes` and `mark_paper_opened`.

Native device capabilities determine the navigation model. iPhone uses one active reader with history across paper references. iPad and Mac use one tab per opened revision, each with its own navigation history and transient editor state. References open or focus the destination tab and retain a source-paper return action. Only the active PDF reader is mounted; tab sessions preserve reading position, selection, and unsent drafts. Home and tab switches leave workspace-owned AI requests running. Closing a paper saves position and removes its tab/session, while keeping all library records. Closing the last tab returns home.

`last_opened_at` tracks recency independently of metadata and reading position. Removing a paper invalidates its preview tokens, cancels its AI work, and transactionally deletes the library entry, PDF reference, annotations, conversations, and derived layouts. Apell retains the underlying resource because its API has no per-resource delete operation. Older downloads stored as private file chunks are queued for cleanup. The frontend also drops that paper's tabs, sources, histories, and late asynchronous results.

arXiv request starts share a three-second pacing clock. Metadata uses `http.request` so the applet can honor a `Retry-After` header. PDF downloads use `resources.download`, which reports byte progress and a status error on failure. A PDF HTTP 429 uses the applet’s increasing retry delay because the resource API omits response headers. Cooldowns are saved across restarts.

For each new PDF, the applet stores the resource’s SHA-256 ID and byte count alongside the library entry in one SQLite transaction. The reader and Ask AI can reopen the same bytes offline through `resources.read` in chunks of up to 1 MiB. Existing private-file PDFs remain readable. Cancelling before the commit discards the applet’s operation, even if the host finishes caching that resource.

## Immersive reading

Saved papers open directly at their reading location; newly confirmed downloads open the original PDF. **Info** displays metadata over the mounted reader on demand. Dismissing it returns to reading, and taps show or hide controls without resizing or recreating the document. The close icon closes the paper rather than merely hiding its controls. Back/Forward restores the destination directly. Taps on links, scrolling gestures, long presses, and active text selection do not toggle controls.

Screen orientation follows the host device. PDF page rotation is independent of screen orientation. Viewport changes preserve the normalized page position, and fit-width mode refits automatically.

On short landscape screens, the top and bottom controls use single rows with 44-point targets, and references and notes open in a narrow panel below the top bar. Safe-area insets keep overlays clear of the notch and home indicator. Apell owns native safe-area and WebView integration. The applet follows physical device orientation; it cannot change native orientation or status-bar policy.

On phones, Ask AI shows one conversation over the mounted reader. Opening a source temporarily displays the original PDF with the cited geometry highlighted. Returning restores the prior reading location and the originating question, draft, or note. The applet uses Apell's platform information and the mobile display's short side to distinguish phones from tablets. Larger devices use the existing inspector.

The text adapter consumes PDF.js text streams with `getReader()` because affected WebKit versions lack the asynchronous stream iteration used by `getTextContent()`. Both text layers and bibliography extraction use the same adapter. It retains chunk styles, language, cleanup, and the separate XFA path without modifying global stream prototypes or PDF.js internals.

## App-owned annotation proposal

Separate the target from the body:

- The target identifies the exact PDF revision and either a passage or the whole paper.
- Page anchor: one-based page number, PDF user-space quadrilaterals, selected quote, and surrounding text.
- New pinned notes carry reviewed text, cited passage anchors, attribution, and an optional local conversation link. Legacy AI answer bodies retain their question and full response.
- Record: schema version, stable annotation ID, and timestamps.

Define quad point ordering and coordinate conventions explicitly. Preserve unscaled, unrotated PDF user-space coordinates, including page box offsets; use engine transforms when displaying them. Do not assume every page starts at zero or every page uses the same size. Screen/device pixel coordinates and PDF.js text item indices are transient.

Geometry places an annotation exactly on the same PDF bytes. Quoted text with prefix/suffix helps validate or recover a text anchor. Define our text normalization rules and version them. Repeated text, equations, ligatures, and two-column reading order can make text matching ambiguous; do not silently attach an annotation to a different match.

An arXiv version and a content hash serve different purposes: the version identifies the published revision, and the hash identifies the exact cached bytes. A different revision requires explicit anchor migration. A PDF.js fingerprint is not guaranteed unique and should not replace a content hash.

Proposed storage is SQLite with portable, versioned JSON sidecar export. The custom schema is authoritative. Embedded PDF annotations can be an additional export projection if needed; a PDF highlight/comment does not by itself preserve all structured AI context.

Borrow the W3C Web Annotation model's body/target separation and text-quote selectors. Full JSON-LD conformance is optional; our own snake_case schema must not be presented as conforming merely because it uses those concepts.

## Candidate engine checks

| Candidate | Relevant tradeoff |
| --- | --- |
| PDF.js | Fits the webview; provides rendering, text content, and embedded link access. Custom annotations can use a separate overlay. Must evaluate text selection and overlay lifecycle in our actual webview. |
| PDFium through a Rust binding | Native rendering, per-character bounds, and hit-testing APIs; requires native-library packaging and reader integration. The app still needs an interactive selection layer. Serialize native API access according to its threading contract. |
| MuPDF | Native rendering/text primitives; requires native packaging and evaluation of its licensing terms. Does not decide our annotation schema. |

There is no measured reason yet to replace PDF.js. A Rust-first backend remains useful for downloads, persistence, and reference services without requiring native rendering.

## Focused evaluation before commitment

Use a small set of representative arXiv PDFs: two-column text, equations, ligatures, embedded citation destinations, cropped/rotated pages, and a longer paper.

Check:

1. Select a passage and capture the intended text, especially around column boundaries and equations.
2. Store page anchors in our format and redraw them after zoom, rotation, resize, and reopening.
3. Create and restore anchors spanning pages without assuming all pages remain mounted.
4. Overlay highlights while keeping text selection and embedded links usable.
5. Route embedded link navigation through app-owned history and restore the source position.
6. Check page rendering and memory behavior in the Apell webview on a longer document.
7. Export/reimport our record without depending on viewer state or altering the PDF bytes.

Accept PDF.js if these checks pass. Consider a native-engine comparison if a concrete failure cannot be resolved through its supported integration surface. Keep the annotation format independent either way.

## Sources

- [PDF.js architecture](https://mozilla.github.io/pdf.js/getting_started/)
- [Page rendering, text, and annotation APIs](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
- [Document destinations and fingerprint caveat](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html)
- [PDF.js page-view layers](https://github.com/mozilla/pdf.js/blob/master/web/pdf_page_view.js)
- [W3C Web Annotation model](https://www.w3.org/TR/annotation-model/)
- [PDFium character bounds and text hit testing](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_text.h)
- [PDFium rendering and threading contract](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdfview.h)
- [MuPDF structured text and quadrilaterals](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/StructuredText.html)
- [MuPDF licensing](https://mupdf.com/releases)

## Reading view

The optional Reading view crops and rearranges PDF source rectangles while retaining original annotation coordinates. See [layout decisions](reader-decisions.md) for detection, caching, figure placement, and fallback behavior.
