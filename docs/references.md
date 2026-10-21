# References

Reading view places compact reference rows below the blocks that cite them, scaling them with the paper. Tapping one opens the existing reference details popup without moving the paper. Recognized embedded bibliography citation links open the same popup in PDF and Reading modes. Citation handling takes precedence over ordinary hyperlink navigation.

The line below a reference title shows author, year, and `arxiv:xxxx` when an arXiv identifier is available, otherwise author, year, and the publication venue without page numbers. Missing fields are omitted. Compact rows use the first author; details and match results use the same ordering with the full author list.

Details show conservatively parsed titles, authors, publication years, and venues. Printed labels are retained instead of renumbering the bibliography. Author/year bibliographies have no invented ordinal. The original citation remains available, and entries that cannot be separated confidently remain plain text. Parsing does not rewrite the PDF or annotation sidecars.

**View bibliography** jumps to the source entry while keeping the current PDF or Reading mode. In Reading mode, the reader locates the corresponding block; a source page remains available when exact entry geometry is missing. Back restores the prior page position, zoom, and Reading block. The separate **View in PDF** action explicitly switches to the original PDF.

**Preview paper** uses the existing arXiv metadata preview. An unsaved paper still requires **Download & add to library**; **Cancel** leaves the current paper intact. A saved target opens from the local library. Following another paper inherits the source reader's PDF or Reading mode while preserving the target paper's saved page and position. If its mode changes, the destination fits the corresponding page or block. The existing phone history or iPad/Mac tabs retain the source return path. No bulk arXiv lookup or PDF download runs while the bibliography is being extracted. The existing metadata cache, pacing, cancellation, and persisted 429 cooldown apply.

**Find a match** performs an on-demand Crossref lookup. DOI results are identified as identifier matches; bibliographic search results are possible matches that the reader chooses. Results include the metadata Crossref supplied and are cached for the session. Lookup errors stay within the reference card, with retry available.

## Hyperlink destinations

Ordinary hyperlinks have three destination types. Classification uses the URL itself and makes no network requests.

| Type | Behavior |
| --- | --- |
| PDF | Figure, section, page, and outline links jump within the current paper and preserve PDF or Reading mode. |
| App | Recognized paper URLs on official arXiv hosts open a saved paper or begin the metadata preview in the app. |
| External | Other valid HTTP(S) links, including DOI links and PDFs on other sites, require browser confirmation. |

Reference actions and match results use the same classification, preferring an explicit arXiv identifier, then a DOI, then the stored URL. A reference containing only an official arXiv paper URL still offers **Preview paper**. Recognized citations retain their details popup before the reader chooses one of these actions.

External confirmation shows the domain and complete URL as plain text, with **Open in browser** and **Cancel**. Cancel receives initial focus. Opening disables repeat actions and dismissal until the request finishes; an error remains in the dialog so the same action can retry. Canceling leaves the paper and position intact and returns to any reference details or paper information that was open. Only HTTP(S) URLs with a host, no embedded credentials, and a bounded length can reach the native browser opener.

**View on arXiv** in paper information deliberately opens the website and uses external confirmation, even though ordinary arXiv paper hyperlinks navigate within the app.

## Detection and limits

- Bibliography extraction starts with the last 6–25 pages, depending on document length. If that range has no bibliography heading, it searches backward until it finds one, preserving references that precede long appendices. Reads are sequential and stop when the paper is closed or replaced. If no heading exists, only the original tail range supplies the URL fallback. Parsing stops at an appendix/supplement heading or a larger unnumbered section heading. It recognizes numbered/alphabetic labels, hanging-indent entries, and unindented author/year entries, including wrapped comma- or semicolon-separated authors and page continuations. Paragraph spacing and a completed date/title keep wrapped author lines within their entry.
- Reading blocks combine unique printed-label or author/year matches with the PDF's own citation destinations. Forms such as `Smith et al. (2025)`, `(Smith et al. 2025; Jones and Doe 2024a)`, listed authors, and grouped full years are recognized, including year suffixes and PDF line wrapping. Bibliography parsing handles inverted initials and abbreviated author lists, and keeps DOI/arXiv identifiers separate from printed labels and publication years. Repeated citations are deduplicated per block; ambiguous author/year or printed-label matches remain unresolved.
- A citation destination just before the first line of a bibliography entry takes precedence over a neighboring column's body text. Ambiguous entry starts or overlapping interior destinations remain unresolved.
- Titles may begin with lowercase model or project names. Trailing links back to citing page numbers are omitted from publication metadata, while the complete printed citation remains available. URLs wrapped between their scheme and `//` are rejoined for link handling.
- Reference rows stay outside PDF text and canvas layers, while scaling together with their Reading block during pinch. Their installation waits for an active pinch to finish and preserves the current source position.
- Original-PDF citation taps rely on embedded links. Scanned pages have no OCR; unusual bibliographies may retain raw text or be missed. Ordinary page and external links remain available even if extraction fails.
