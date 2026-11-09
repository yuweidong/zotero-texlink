# XPI packaging

A Zotero 10 bootstrap plugin is a ZIP archive with an `.xpi` extension.
`manifest.json`, `bootstrap.js`, and `prefs.js` must be at the ZIP root; do not
nest them inside an extra directory.

## 1. XPI layout

```text
zotero-texlink-<version>.xpi
├── manifest.json
├── bootstrap.js
├── prefs.js
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── third_party/
│   ├── LICENSE-onnxruntime.txt
│   └── LICENSE-pix2text.txt
├── locale/
│   ├── en-US/texlink.ftl
│   └── zh-CN/texlink.ftl
└── chrome/
    └── content/
        ├── scripts/
        │   ├── texlink-service.js
        │   └── worker.js
        ├── preferences/
        │   ├── preferences.xhtml
        │   ├── preferences.js
        │   └── preferences.css
        ├── models/
        │   ├── texlink-model.json
        │   ├── encoder_model_int8.onnx
        │   ├── decoder_model_int8.onnx
        │   ├── tokenizer.json
        │   ├── pix2text-mfr-config.json
        │   └── pix2text-mfr-preprocessor.json
        ├── vendor/
        │   └── ort/
        │       ├── ort.min.js
        │       └── ort-wasm-simd.wasm
        └── icons/
            ├── texlink-48.png
            ├── texlink-96.png
            ├── texlink-prefs.svg
            └── texlink-prefs.png
```

Do **not** package `README.md`, `docs/`, `tools/`, `tests/`, or `.venv` into the
runtime XPI. The build script excludes them automatically.

Fluent source files live in `addon/locale/<locale>/texlink.ftl` in the repository.
The build script maps them into the XPI at `locale/<locale>/texlink.ftl`, which
is the path Zotero's plugin localization loader scans.

## 2. Resource URL mapping

At startup `bootstrap.js` runs:

```js
const aomStartup = Components.classes[
  "@mozilla.org/addons/addon-manager-startup;1"
].getService(Components.interfaces.amIAddonManagerStartup);
const manifestURI = Services.io.newURI(rootURI + "manifest.json");
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "zotero-texlink", rootURI + "chrome/content/"]
]);
```

A file stored at:

```text
chrome/content/scripts/worker.js
```

is therefore available at:

```text
chrome://zotero-texlink/content/scripts/worker.js
```

The model, tokenizer, and ORT WASM use the same prefix:
`chrome://zotero-texlink/content/{models,vendor/ort}/...`.

TexLink pins onnxruntime-web 1.17.3 and its non-threaded WASM asset
(`ort-wasm-simd.wasm`). The Worker reads the file and exposes it to Emscripten
through a Blob URL. This avoids a dependency on `SharedArrayBuffer` and works
around browser differences in fetching `chrome://` resources.

This is safer than hard-coding `file:///...` paths and is independent of
platform path separators.

### Why no `chrome.manifest`?

A static `chrome.manifest` at the XPI root is possible, but modern Zotero 10
plugins usually register their content package from `bootstrap.js` (as TexLink
does). This:

- does not depend on the application scanning a legacy manifest at startup;
- lets `chromeHandle.destruct()` release the mapping precisely on unload;
- avoids content-package name collisions with other plugins.

## 3. Build

```bash
python3 tools/verify_assets.py
python3 tools/build_xpi.py
```

Artifacts:

```text
dist/zotero-texlink-<version>.xpi
dist/zotero-texlink-<version>.xpi.sha256
```

The build script:

1. validates the manifest (including the required HTTPS `update_url` and
   `updates.json` array format), model SHA256 values, tokenizer vocabulary size,
   ORT assets, and any declared `update_hash`;
2. scans runtime JavaScript and rejects external HTTP URLs;
3. writes runtime files into the XPI with deflate compression;
4. computes the XPI SHA256.

## 4. Manual checks

```bash
unzip -l dist/zotero-texlink-<version>.xpi | sed -n '1,80p'
unzip -p dist/zotero-texlink-<version>.xpi manifest.json | python3 -m json.tool
```

Expected:

- `manifest.json` is at the top level;
- `chrome/content/models/encoder_model_int8.onnx` exists;
- `chrome/content/vendor/ort/ort-wasm-simd.wasm` exists;
- no `__MACOSX/` or `.DS_Store` entries;
- the XPI is approximately 25 MiB (about 43 MiB uncompressed: models about
  31 MiB, WASM about 10 MiB, and a small amount of code).

## 5. Install and development

### Normal installation

Zotero 10 → Tools → Add-ons → gear menu → Install Add-on From File… → select
the XPI. Zotero shows its standard warning for unsigned add-ons.

### Development

Do not install the `chrome/` directory directly. The `chrome://` mapping
depends on the `rootURI` of an installed XPI. Rebuild and install the XPI, or
point a dedicated debug profile at the real XPI path.

### Updating

- Increment `version` in `manifest.json`.
- Do not change the plugin ID `zotero-texlink@yuweidong.dev`; Zotero would treat
  it as a different plugin.
- If model files change, update the SHA256 values in `texlink-model.json`.
- Fully quit and restart Zotero after an upgrade so an old Worker cannot keep
  an old model open.

## 6. Manifest permissions

Zotero 10's plugin manifest uses a subset of Zotero 7 fields: `manifest_version`,
`name`, `version`, `description`, `author`, `icons`, and `applications.zotero`.
It is **not** a regular Firefox WebExtension, and there is no `permissions`
field for `webRequest` or `storage`.

Within `applications.zotero`, `id`, `update_url`, and `strict_max_version` are
required by Zotero 10's install validation. `update_url` must start with
`https:`; otherwise the Addon Manager's `checkUpdateSecurity` marks the add-on
as `appDisabled`. TexLink uses
`https://raw.githubusercontent.com/yuweidong/zotero-texlink/main/updates.json`
as its update manifest. The Add-on Manager may fetch that document to check for
new releases; TexLink's OCR and note-writing code never does. See
[UPDATES.md](UPDATES.md) for the release workflow.

The plugin's capability boundary is enforced by its code:

- it reads only `chrome://zotero-texlink/` resources;
- it uses the Zotero object model and a few guarded, read-only Reader UI fields;
- its runtime code makes no external network requests; Zotero's Add-on Manager
  handles the separate HTTPS update check;
- it launches no external process;
- it bundles the model, WASM, and tokenizer in full.

The absence of a `permissions` field is therefore intentional.

## 8. Continuous integration

`.github/workflows/verify.yml` runs asset validation, decoder tests, service
helper tests, and an XPI build for pushes and pull requests.

`.github/workflows/release.yml` runs on `v*` tags, checks the tag, manifest, and
`updates.json` entry, builds and verifies the XPI, and creates or updates the
GitHub release with the XPI and checksum.

## 7. Signing and distribution

Zotero add-ons do not require a Mozilla signature by default. For public
distribution:

1. publish the `.xpi` and its `.sha256`;
2. document the model provenance and MIT licenses;
3. follow the signing and supply-chain requirements of any marketplace or
   organization that reviews the add-on. Never forge a Mozilla signature.
