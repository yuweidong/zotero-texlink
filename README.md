# Zotero-TexLink

**A Zotero-native structured formula knowledge anchor.**

TexLink converts a formula screenshot from a PDF into LaTeX and writes a
permanent, traceable formula block into the literature note. The result is not a
clipboard string and not a chat transcript: the formula lives where the reading
happened, with its page, timestamp, source item, and a native math preview.

The recognition path runs entirely inside Zotero: no Python service, no cloud
API, no external recognition call, and no LLM. The complete deliverable is one
`.xpi` containing the model, tokenizer, WASM runtime, and plugin code. The only
external request is Zotero's standard add-on update check, which never sees
screenshots, formulas, notes, or library data.

## Why TexLink

Most formula OCR tools stop at text. TexLink starts from Zotero's own annotation
model and ends at a durable note block.

| Typical formula workflow | TexLink |
| --- | --- |
| Screenshot → clipboard → paste into Markdown | Native image annotation → anchored formula block in a Zotero note |
| Page number recorded manually or lost | PDF page label and attachment key captured automatically |
| Formula preview and source drift apart | Native KaTeX preview and searchable LaTeX source in the same block |
| Cloud OCR or LLM call | Fully offline ONNX inference with deterministic greedy decoding |
| Python/FastAPI/Node backend | No service process and no runtime installation |
| One generic "OCR result" | One independent, timestamped, source-linked record per extraction |
| Network required | None for recognition; only Zotero's standard add-on update check is external |

### The differences that matter

- **Native Zotero input, not clipboard capture.** TexLink consumes Zotero's
  native region-image annotations. Zotero already owns the annotation cache,
  PDF coordinates, page label, sync state, and undo behavior. TexLink does not
  re-parse the PDF or invent a parallel screenshot store.
- **Notes are the destination.** A formula is written to the open note for the
  same item when available, or to a dedicated note tagged
  `texlink-formula-log`. There is no clipboard-only mode.
- **A knowledge block, not a text dump.** Every extraction becomes its own
  `<blockquote>` containing a native math node, the LaTeX source, page label,
  ISO 8601 timestamp, source links, and an optional comment. The block is
  independently addressable through `data-texlink-entry` and
  `data-texlink-annotation`.
- **Native math, not injected MathJax.** Zotero 10's note editor renders KaTeX
  math nodes (`<pre class="math">$$...$$</pre>` and
  `<span class="math">$...$</span>`). TexLink emits that native format, so
  previews survive note editing and sync and the source remains searchable.
- **Offline by construction.** No recognition HTTP client, no remote model, no
  telemetry, no LLM/VLM. Model, tokenizer, WASM, and ORT all load from
  `chrome://zotero-texlink/content/`. Auto-update checks are performed by
  Zotero's Add-on Manager through the HTTPS `update_url`, not by TexLink's
  recognition code.
- **Deterministic recognition.** Pix2Text-MFR with greedy decoding produces
  the same output for the same input. TexLink does not "clean up" formulas with
  generative guesses.
- **Worker-first inference.** The UI thread does only screenshot retrieval,
  a 384 × 384 Canvas preprocessing step, message passing, and note writing.
  ONNX Runtime Web, model loading, WASM compilation, and all matrix work run in
  a Web Worker.

## Workflow

1. Open a PDF in the Zotero reader.
2. Use the native **Region Image** annotation tool to select a formula.
3. Select the resulting image annotation and choose **TexLink: recognize
   formula and write to note** from the context menu, or press
   `Cmd/Ctrl + Shift + L`.
4. TexLink reads the annotation image, preprocesses it, runs the offline model,
   decodes LaTeX, and writes a new formula block to the target note.
5. A short-lived toast in the reader reports progress and completion without
   opening a separate native progress window.

The default shortcut can be changed in TexLink's preferences. Recognition can
also be started from the Tools menu.

## What a formula block looks like

```html
<blockquote data-texlink-entry="ABCD1234-mw0q4xcn"
            data-texlink-annotation="ABCD1234">
  <h3>TexLink formula anchor</h3>
  <pre class="math">$$\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}$$</pre>
  <p><strong>Page:</strong> 12 | <strong>Extracted:</strong> 2026-11-04T08:31:31.000Z</p>
  <p><strong>Source:</strong> Paper title |
     <a href="zotero://open-pdf/...">Open in PDF</a> |
     <a href="zotero://select/...">View item</a></p>
  <p><strong>LaTeX source:</strong></p>
  <pre>\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}</pre>
</blockquote>
```

The exact template is configurable through
`extensions.zotero.texlink.noteTemplate`. A custom template must retain
`{{latexRaw}}` and `{{pageLabel}}`; otherwise TexLink falls back to its internal
template so that a malformed preference cannot silently destroy the math node.

## Architecture

```text
┌───────────────────────────── Zotero 10 UI thread ─────────────────────────────┐
│                                                                               │
│  Native PDF region-image annotation                                           │
│       │                                                                       │
│       ├─ Zotero.Annotations.toJSON() → data:image/png;base64                  │
│       │                                                                       │
│       └─ Canvas: transparent-to-white, resize to 384×384, RGB normalize,      │
│          CHW Float32Array                                                     │
│                              │                                                │
│                              ▼ transferable ArrayBuffer (zero copy)           │
│  ┌──────────────────────────── Web Worker ────────────────────────────────┐   │
│  │ onnxruntime-web 1.17.3, non-threaded WASM                              │   │
│  │ Pix2Text-MFR INT8 encoder → hidden states                              │   │
│  │ decoder → greedy token ids                                             │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                              │ token ids                                      │
│                              ▼                                                │
│  Pure-JS ByteLevel BPE decoder → LaTeX                                        │
│                              │                                                │
│                              ▼                                                │
│  Zotero.Item("note") + setNote()/saveTx(), or live editor insertHTML          │
│  KaTeX preview + source + page label + timestamp + links + comment            │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

Only the small 384 × 384 image is processed on the UI thread. Model loading,
ORT initialization, and every inference operation stay in the Worker.

## Model choice

TexLink ships **Pix2Text-MFR 1.0** (TrOCR/VisionEncoderDecoder) in its official
ONNX form, dynamically quantized to INT8:

- encoder input: `pixel_values` `float32[1,3,384,384]`
- encoder output: `last_hidden_state` `float32[1,578,384]`
- decoder inputs: `input_ids` `int64`, `encoder_hidden_states`
- decoder output: `logits` `float32[1,seq,1200]`
- tokenizer: ByteLevel BPE, vocabulary size 1200
- decoding: deterministic greedy argmax, start/EOS token 2, pad token 0,
  maximum 512 new tokens

Pix2Text-MFR was chosen because its official repository publishes a complete
ONNX encoder/decoder and tokenizer, its output is deterministic, and the INT8
bundle is small enough to ship inside a single XPI. UniMERNet is a valid
alternative, but it does not ship a stable official ONNX release; the conversion
guide includes a build-time UniMERNet template rather than bundling unverified
weights.

See [docs/MODEL_CONVERSION.md](docs/MODEL_CONVERSION.md) for the reproducible
official-model conversion and INT8 quantization commands.

## Zotero-specific implementation notes

- Zotero 10 has no `Zotero.Notes.create()` API. New notes are created with
  `new Zotero.Item("note")`, `setNote()`, and `saveTx()`.
- The note editor renders native KaTeX math nodes; MathJax `<script>` injection
  is neither necessary nor safe for sync/search.
- Image annotations are the screenshot source. This preserves Zotero's page
  labels, attachment keys, image cache, sync semantics, and undo stack.
- When a note for the same item is already open, TexLink inserts through the
  editor's `insertHTML` message so unsaved editor content is not overwritten.
  Otherwise it appends to the note item and saves.
- Reader progress is shown as a lightweight toast inside the reader document,
  not as a separate native window. The menu command is deferred until the menu
  has closed before any asynchronous work begins.
- Reader context menu integration uses the official
  `Zotero.Reader.registerEventListener` API. A small number of guarded internal
  reader fields provide fallbacks for annotation selection; if those fields
  change, the service degrades to the annotation context menu or the shortcut.

## Install

1. Open Zotero 10.
2. Download the `.xpi` file from the
   [Releases page](https://github.com/yuweidong/zotero-texlink/releases).
3. Go to **Tools → Add-ons → gear menu → Install Add-on From File…**, then
   select the downloaded `.xpi`.
4. Restart Zotero, or disable and re-enable TexLink in the Add-ons Manager.

The XPI is about 25 MiB. On first use, Zotero compiles the WASM runtime and
loads two ONNX sessions in the Worker; later recognitions are much faster.

### Automatic updates

TexLink uses Zotero's built-in add-on updater. The installed manifest points to
an HTTPS update document with an `updates` array; Zotero checks it periodically
and can install newer releases without manual downloads. The update manifest is
hosted separately from the XPI and never participates in OCR.

For the release and hosting workflow, see
[docs/UPDATES.md](docs/UPDATES.md).

## Preferences

All preferences live under `extensions.zotero.texlink.*`.

| Preference | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch for menus, shortcuts, and automatic processing |
| `warmupOnStartup` | `true` | Load and warm up the model in the Worker at startup |
| `maxNewTokens` | `384` | Maximum generated tokens (model limit: 512) |
| `noteTarget` | `auto` | `auto`, `active`, or `dedicated` note destination |
| `logNoteTag` | `texlink-formula-log` | Tag identifying the dedicated note |
| `logNoteTitle` | `TexLink Formula Notes` | Title for a newly created dedicated note |
| `openNoteAfterInsert` | `false` | Open the destination note after writing |
| `promptForComment` | `false` | Ask for an optional comment before recognition |
| `autoProcessNewScreenshots` | `false` | Process new image annotations automatically |
| `shortcut` | `accel,shift,L` | Keyboard shortcut |
| `binarize` | `false` | Optional Otsu binarization before inference |
| `maxCommentLength` | `2000` | Maximum stored comment length |
| `debug` | `false` | Detailed Worker round-trip logging |
| `diagnosticLog` | `false` | Write stage breadcrumbs to `texlink-crash.log` in the temp directory |
| `noteTemplate` | built-in | HTML template for a formula block |

## Limitations

- TexLink recognizes formula images, not arbitrary page text or tables.
- Recognition quality depends on screenshot resolution and contrast; very small
  or blurry selections may be misread.
- A formula must be attached to a PDF item that has a regular parent item.
- Recognition is intentionally offline. It will not fall back to a cloud OCR
  service; only Zotero's built-in add-on update check uses the network.
- The bundled model is optimized for formulas, not for general handwriting or
  diagrams.

## Development

```bash
# Validate the manifest, model hashes, tokenizer, and ORT assets
python3 tools/verify_assets.py

# Run the pure-JS BPE decoder test with the bundled fixture
node tests/tokenizer_decode.test.js

# Add the current manifest version to updates.json
python3 tools/update_manifest.py

# Build a deterministic XPI
python3 tools/build_xpi.py
```

Packaging details: [docs/PACKAGING.md](docs/PACKAGING.md).

Auto-update and release workflow: [docs/UPDATES.md](docs/UPDATES.md).

Model conversion and quantization: [docs/MODEL_CONVERSION.md](docs/MODEL_CONVERSION.md).

## License

Plugin code is MIT-licensed. Pix2Text and ONNX Runtime are distributed under
their respective MIT licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and the files in `third_party/`.
