# Reader engine and annotation ownership

Status: PDF.js accepted and implemented with app-owned annotation storage and overlays. Geometry and selection behavior have automated coverage. Native simulator checks cover paper information, full-screen reading, portrait/landscape changes, reference following, and Back/Forward. Physical-device selection, highlight alignment, and alternative-engine benchmarks remain unverified. See [verification notes](./verification.md).

## Decision being considered

An app-owned annotation format is compatible with PDF.js. The important boundary is between PDF rendering and the app's annotation domain. Selecting an engine should depend on rendering fidelity, selection behavior, link access, performance, and packaging rather than whether it offers its own annotation editor.

PDF.js remains the leading candidate for a Tauri/React reader. Prefer composing its documented display API and reusable viewer components inside our reader. Evaluate the components we need before committing to either the full viewer or rebuilding page management ourselves. Avoid a viewer fork or changes to PDF.js internals.

## Ownership

| Concern | Owner |
| --- | --- |
| Parse PDF and render pages | PDF engine |
| Extract text, page geometry, and embedded links | PDF engine, normalized by reader adapter |
| Capture selection and translate screen coordinates | Reader adapter |
| Document revision and content hash | App |
| Annotation schema, migrations, and storage | App |
| Highlight overlay and AI discussion UI | App |
| Back/Forward across internal links and papers | App |
| Paper information and reading controls | App |
| Native screen orientation | Platform reader plugin |
| Optional export into another format | App export adapter |

Keep the adapter small and driven by actual needs. We need page metrics, selection anchors, link targets, coordinate conversion, and navigation events. We do not need a general plugin system or multiple working engines for the first release.

## Immersive reading

Explicit paper openings show metadata over an already mounted PDF. Closing the information sheet reveals the full reader; taps show controls without resizing or recreating the document. Back/Forward restores the destination directly. Taps on links, scrolling gestures, long presses, and active text selection do not toggle controls.

The iOS plugin requests portrait or landscape through the foreground window scene. Screen orientation is independent of PDF page rotation and never changes annotation coordinates or the sidecar schema. Viewport changes preserve the normalized page position; fit-width mode refits automatically, while manually chosen or restored zoom remains stable.

On short landscape screens, the top and bottom controls use single rows with 44-point targets, and references and notes open in a narrow panel below the top bar. Safe-area insets keep overlays clear of the notch and home indicator. A UIKit container retains Tauri's original controller as a child and manages the iPhone status bar: hidden in landscape and visible in portrait, including physical rotation. The WKWebView disables native scroll-inset adjustment because CSS already handles safe areas; applying both would shrink and shift the document viewport. Native dialog guards check both the original controller and its root container.

The text adapter consumes PDF.js text streams with `getReader()` because affected WebKit versions lack the asynchronous stream iteration used by `getTextContent()`. Both text layers and bibliography extraction use the same adapter. It retains chunk styles, language, cleanup, and the separate XFA path without modifying global stream prototypes or PDF.js internals.

## App-owned annotation proposal

Separate the target from the body:

- Target: exact document hash and revision, with one or more page anchors.
- Page anchor: one-based page number, PDF user-space quadrilaterals, selected quote, and surrounding text.
- Body: a user note or an AI answer, including its question, provider/model, and actual context used.
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
6. Check page rendering and memory behavior in the Tauri webview on a longer document.
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
