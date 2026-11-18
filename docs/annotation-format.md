# App-owned annotation format, version 1

Annotations are stored separately from the original PDF. SQLite is the working store; a JSON sidecar is the portable representation. Neither format contains PDF.js editor objects or DOM references.

## Sidecar envelope

The envelope has `format: "papertrail_annotations"`, `schema_version: 1`, `paper_id`, `pdf_hash`, `exported_at`, and `annotations`.

`paper_id` identifies a concrete arXiv version, such as `1706.03762v7`. `pdf_hash` is the SHA-256 digest of the exact PDF bytes. Imports must match both. Different revisions require deliberate migration; the app must not guess a new attachment silently.

## Annotation record

Each record contains:

- `schema_version`: 1.
- `annotation_id`: stable identifier.
- `target`: `paper_id`, `pdf_hash`, and `page_anchors`.
- `body`: a typed note or AI answer.
- `created_at` and `updated_at`: RFC3339 timestamps.

A note body has `kind: "note"` and `content`. A note pinned from an AI turn also carries `citations`, a local `origin` containing `conversation_id` and `turn_id`, and available `llm_provenance`. Each citation contains a turn-local `citation_id` such as `S1` and a complete `anchor` in the same PDF revision. Its quote and coordinates travel with the exported note. The local conversation supplies the full answer when available.

Saving a reviewed turn note updates its annotation and conversation in one transaction. Repeated saves reuse its annotation ID. Earlier `kind: "ai_answer"` records retain their original question, answer, context, attribution, and optional edited `note_content`. Existing sidecars can still be imported.

## Anchoring

Each page anchor has a one-based `page_number`, `quad_points`, and a `text_quote`.

A passage placement has one or more anchors in `target.page_anchors`. A whole-paper placement explicitly sets `target.scope` to `"paper"` and uses an empty `page_anchors` list. Either placement can cite passages elsewhere in the paper.

Each quadrilateral is eight numbers in the order top-left, top-right, bottom-right, bottom-left as seen in the viewport when captured. The points themselves are converted to the PDF's unscaled, unrotated user-space coordinates. This preserves rotation, crop-box offsets, and page geometry without assuming a screen resolution. The reader's viewport transform converts them back for display.

An annotation spanning pages contains a separate anchor for each page. It does not depend on whether those pages are currently rendered or mounted.

`text_quote` contains `exact_text`, `prefix`, `suffix`, and `normalization_version: 1`. Text is normalized to Unicode NFKC, soft hyphens are removed, and runs of whitespace are collapsed before trimming. Geometry anchors the same PDF exactly; the quote is supporting evidence for verification and future recovery. Quotes alone can be ambiguous in repeated passages, equations, or multi-column documents.

## Reading history

Reading locations are separate from annotation geometry. `page_position` is a pair of fractions in the rotated page viewport, from its top-left corner. History also stores page, paper, zoom, and rotation. `[0, 0]` means the page's top-left corner.

## Validation and evolution

Import validates the envelope, version, IDs, timestamps, finite quadrilateral coordinates, text anchors, and body type before attempting saves. The backend validates again against the local paper. Duplicate IDs within a sidecar are rejected; importing an existing ID updates that record.

Unsupported versions fail explicitly. Future schema migrations belong to the app and remain independent of the chosen PDF renderer. Optional export to native PDF highlights/comments would be an additional projection of these records, not the source of truth.

## Apell model attribution

New AI annotations may include `body.llm_provenance` with `connection_id`,
`requested_model_id`, and nullable `model_id`. A null actual model remains unknown;
the existing display `model_id` can fall back to the requested model. Continuation
handles and thinking are never exported. Older sidecars remain valid.
