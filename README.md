# Paper Reader

A local Apell applet for reading arXiv papers, following references, and saving AI explanations beside selected passages. React and PDF.js provide the reader; Rust/WASM owns AI prompts, tool-call policy, arXiv parsing, hashing, and record validation. Apell supplies SQLite, private files, HTTP, and the shared model connection.

The package name is `@agentic-rs/doi`, the Apell applet ID is `doi`, and the display name is **Paper Reader**. The `doi` applet uses a separate data store from the earlier `papertrail` nightly.

The applet replaces the standalone Tauri application. PDFs remain unchanged; annotations belong to Paper Reader.

## Build and install

Requires Node.js 24+, pnpm, Rust, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` **0.2.126** (matching the pinned crate).

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm install --frozen-lockfile
cargo fetch --manifest-path crates/doi-ai/Cargo.toml
APELL_BIN=apell pnpm build
```

Builds use the locked Rust dependencies offline after that initial fetch. Output:

- `artifacts/doi.apel`: self-contained installable bundle.
- `artifacts/doi.sha256`: checksum of the exact bundle bytes.

In Apell, tap **+ → Install an .apel file** and select `artifacts/doi.apel`. Install the current Apell CLI and put `apell` on PATH, or set `APELL_BIN` to its executable. Packaging uses `apell pack` with API revision 2.

The required LLM contract includes `llm.generate`, tool continuation, explicit outcomes, and per-request provenance. The SDK snapshot is pinned in `applet/vendor/apell-sdk/ORIGIN.md`.

Updating the bundle with the same `doi` applet ID preserves its library. This version starts a separate applet library; it does not automatically read the former standalone application's files or credentials. Those files are not modified. Existing annotation sidecars can be imported after downloading the exact same PDF revision.

### Update the iOS simulator

After changing the applet, run the following command on the development Mac with Xcode and a configured Apell iOS checkout.

```sh
pnpm simulator:sync
```

This builds Paper Reader, runs the applet and Rust tests, then uses `apell dev --install` to launch the shell and wait for its install receipt. The defaults are the sibling `../apell` checkout and the **Apell iPhone 16 Pro** simulator. Set `APELL_PROJECT` or `APELL_SIMULATOR` to use another checkout or simulator. Same-version development builds update in place and keep the simulator's Paper Reader library.

## Use

1. Enter an arXiv ID or URL, inspect its metadata, then download and open it.
2. Read the original PDF or switch to Reading view. Reading view crops source blocks and preserves the paper's typography; it does not use OCR or reflow text.
3. Choose **Ask AI** in the reader, or select a passage to ask about it. The agent can search the cached PDF and read page excerpts. Tap a citation to inspect the quoted passage, then return to your answer.
4. Use **Save as note** on an answer, edit the takeaway, and choose the whole paper or a passage as its home. The note carries its cited passages when exported. Conversations and drafts persist locally. Set the shared model connection in **Apell Settings**.
5. Follow detected arXiv references in the reader; Crossref can suggest matches for citations without an identifier.
6. Removing a paper deletes its library records and queues its cached PDF files for cleanup. Closing a tab only saves the reading position.

## Current host limits

- PDF downloads use Apell HTTP and are limited to **16 MiB**. Redirect responses are reported as errors. Cancellation stops waiting and prevents saving a cancelled download; the host does not expose individual HTTP transport cancellation.
- PDF.js runs its worker protocol on the main thread with embedded fonts, CMaps, and decoder assets. Native font-face loading is disabled to comply with Apell's sandbox. Large or complex documents may render more slowly.
- Screen orientation follows the device. Applet-controlled rotation of the screen is unavailable; PDF page rotation still works.
- External links are shown as selectable addresses. Annotation export shows selectable JSON. Native browser opening, file export/share, and automatic import of the standalone library require additional host support.
- PDF reading uses extractable text and its page geometry. Image-only scans and visual details of figures require a separate visual-reading capability. Models without tool support can answer from supplied context. See [AI behavior](docs/ai.md).

## Verification

```sh
pnpm test
pnpm test:ai
```

`pnpm test` first builds the applet and type-checks it, then runs the reader/UI suite, compiled-WASM LLM tests, SQLite-backed persistence tests, and an actual PDF.js rendering check. Provider tests use fixtures and do not spend model credits. See [verification notes](docs/verification.md) for the limits of these checks.

## Source layout

- `src/`: reader UI, PDF analysis, navigation, and annotation contracts.
- `applet/src/`: Apell bridge adapters, transactional storage, paper downloads, conversations, and embedded PDF setup.
- `crates/doi-ai/`: portable Rust/WASM policy, parsing, models, and validation.
- `scripts/build-applet.ts`: self-contained bundle packaging.

## Publish to Apell Store

The [manual GitHub Actions workflow](.github/workflows/publish.yml) builds and
tests Paper Reader on `main`, then publishes the verified bundle through Apell's
GitHub OIDC integration. Normal pushes do not trigger Store publishing.

1. Sign in to the intended Apell Store and register or claim access to `doi`.
2. Set the repository Actions variable `APELL_STORE_URL` to that Store's canonical HTTPS origin.
3. Connect the package to `agentic-rs/doi`, `.github/workflows/publish.yml`,
   `refs/heads/main`, and the `workflow_dispatch` event. A Store maintainer can
   configure this in the Store or run the following after `apell login`:

   ```sh
   apell package oidc set doi --repo agentic-rs/doi \
     --workflow .github/workflows/publish.yml \
     --ref refs/heads/main --event workflow_dispatch
   ```

4. Once the tested release commit is on `main`, run **Publish Paper Reader to
   Apell Store** from the Actions tab.

Store versions are immutable. Bump `package.json` before publishing changed
bundle bytes, listing metadata, or artwork. The artwork migrated from Apell's
Paper Reader showcase is now maintained in `assets/icon.svg` here. When it changes,
regenerate the 256 × 256 `assets/icon.png` used in the package and Store listing.
