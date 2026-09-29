# References

Reading view places compact, unscaled reference rows below the blocks that cite them. Tapping one opens reference details without moving the paper. Embedded bibliography citation links in the original PDF open the same details; figure, section, and other links retain their normal navigation.

Details show conservatively parsed titles, authors, publication years, and venues. Printed labels are retained instead of renumbering the bibliography. Author/year bibliographies have no invented ordinal. The original citation remains available, and entries that cannot be separated confidently remain plain text. Parsing does not rewrite the PDF or annotation sidecars.

**View bibliography** opens the source entry in the original PDF. Back restores the prior page position, zoom, and Reading block. Following another paper uses the existing phone history or iPad/Mac tabs and source return path.

**Preview paper** uses the existing arXiv metadata preview. An unsaved paper still requires **Download & add to library**; **Cancel** leaves the current paper intact. A saved target opens from the local library. No bulk arXiv lookup or PDF download runs while the bibliography is being extracted. The existing metadata cache, pacing, cancellation, and persisted 429 cooldown apply.

**Find a match** performs an on-demand Crossref lookup. DOI results are identified as identifier matches; bibliographic search results are possible matches that the reader chooses. Results include the metadata Crossref supplied and are cached for the session. Lookup errors stay within the reference card, with retry available.

## Detection and limits

- Bibliography extraction examines the last 6–25 pages, depending on document length, and stops at an appendix/supplement heading. It recognizes numbered/alphabetic labels and hanging-indent author/year entries, including wrapped authors and page continuations.
- Reading blocks combine unique printed-label or author/year matches with the PDF's own citation destinations. Repeated citations are deduplicated per block. Ambiguous duplicate labels or overlapping destination geometry are left unresolved.
- Reference rows are outside PDF text, canvas, and pinch transforms. Their installation waits for an active pinch to finish and preserves the current source position.
- Original-PDF citation taps rely on embedded links. Scanned pages have no OCR; unusual bibliographies may retain raw text or be missed. Ordinary page and external links remain available even if extraction fails.
