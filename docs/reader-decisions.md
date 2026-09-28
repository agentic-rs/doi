# Optional Reading view

Reading view is a local, derived layout of source PDF rectangles. The PDF remains the canonical document: vector figures, equations, captions, and typography are rendered by PDF.js at the current display scale. This first version does not reflow text or offer a separate font size.

A bounded analysis bitmap and the text geometry protect content while detecting empty outer margins, paragraph gaps, and clear column gutters. Splits pass through empty corridors; ambiguous regions retain their original arrangement. Figures include their labels and captions. A uniquely numbered figure moves after the first clear single-number Figure/Fig. reference; unmatched or ambiguous figures retain source order. Scanned pages remain cropped originals without OCR.

Analysis runs one page at a time, can be cancelled by returning to PDF, and reports progress. Rust stores the completed layout in SQLite keyed to the cached PDF hash and extractor version. Invalid or stale derived data is rebuilt. Cache failures do not block reading.

Every block retains its source page and PDF-space rectangle. Selections follow displayed block order and produce the existing annotation schema's original PDF quads. Reading positions additionally retain the view mode and block ID, with source page fractions as a fallback; legacy positions default to PDF. Source links and Back/Forward preserve the passage across view changes. Figure enlargement uses staged, scoped PDF zoom so its toolbar remains fixed.
