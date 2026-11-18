# Ask AI in Paper Reader

Open a paper to start a conversation, or select a passage to attach it to a question. Follow-ups can attach other passages from the same PDF revision. Apell supplies the configured model, credentials, streaming transport and cancellation. Configure the model in Apell Settings. Demo mode uses scripted replies.

## Reading and citing a PDF

Paper Reader sends the paper's title, arXiv revision, authors, abstract, attached text and completed conversation history. During an initial answer or a follow-up the model can request two local tools.

- `search_document` finds text matching a literal phrase in the cached PDF. Results give the pages searched and the next starting page when more pages remain.
- `read_page` extracts passages from a one-based page number. Long pages have a continuation offset. Image-only pages have no extractable passages.

PDF.js reads the exact stored revision locally. Apell receives short text excerpts with page numbers. The applet retains each excerpt's normalized quote and PDF-space highlight coordinates. It assigns source IDs for one answer, including IDs for eligible attached passages and recent cited evidence. The model can refer to an excerpt with a marker such as `[S1]`. Opening that citation takes the reader to the stored passage. The app verifies that each linked ID was supplied to the model in that answer. Readers can inspect the quote to judge whether it supports the claim.

Reads run within a budget of three tool rounds, four calls per round and 32 KiB of tool excerpts per answer. The initial prompt and completed history share a separate 128 KiB budget. Stop cancels the active Apell request or local PDF read. A confirmed unsupported-tools response on the first model call permits one text-only retry using the supplied context.

## Saved notes and conversations

**Save as note** opens an editable note for a completed answer. Choose its placement on the paper or beside a passage. Pinning stores the reviewed text, verified source anchors, model attribution and a local link to the originating turn. A note can sit beside the introduction and cite an appendix. Saving requires no further model call.

During tool use, Paper Reader replays the complete assistant message returned by `llm.generate`, including Apell's native `provider_state`. It routes subsequent rounds of the answer to the connection and requested model that began it. Each provider round has a distinct request ID. Progress is associated with the enclosing operation. The applet stores completed question/answer turns and their source locations. It excludes interrupted turns from subsequent prompts and renders streaming thinking transiently. Later turns receive the original page and quote for previously cited claims.

Stored model provenance includes the connection ID, requested model and nullable provider-reported model. Existing AI answers and drafts keep their original records. The legacy **Generate note** action requires one valid `propose_annotation` tool result and retains the previous draft on failure.

The PDF reader currently handles extractable text. Figures and scans require visual input or OCR to ground an answer in their contents.
