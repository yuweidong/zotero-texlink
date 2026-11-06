# Automatic updates

TexLink uses Zotero's standard add-on update mechanism. Zotero reads the
`applications.zotero.update_url` field from the installed `manifest.json`,
downloads that JSON document, and compares its version with the installed
version.

The update document is a normal JSON file served over HTTPS. It is not part of
the XPI and it is never fetched by TexLink's recognition code.

## Current configuration

```text
update manifest:
https://raw.githubusercontent.com/yuweidong/zotero-texlink/main/updates.json

release page:
https://github.com/yuweidong/zotero-texlink/releases/tag/v0.1.3

XPI asset:
https://github.com/yuweidong/zotero-texlink/releases/download/v0.1.3/zotero-texlink-0.1.3.xpi
```

`updates.json` uses an **array** named `updates`. Each version is a separate
object in that array. Do not use a `versions` object keyed by version number.

```json
{
  "addons": {
    "zotero-texlink@yuweidong.dev": {
      "updates": [
        {
          "version": "0.1.3",
          "update_link": "https://github.com/yuweidong/zotero-texlink/releases/download/v0.1.3/zotero-texlink-0.1.3.xpi",
          "applications": {
            "zotero": {
              "strict_min_version": "10.0",
              "strict_max_version": "10.999"
            }
          }
        }
      ]
    }
  }
}
```

## GitHub asset URL

The GitHub release page URL and the asset URL are different:

```text
release page:
https://github.com/<owner>/<repo>/releases/tag/v0.1.3

asset download:
https://github.com/<owner>/<repo>/releases/download/v0.1.3/<asset-name>.xpi
```

The asset path is `/releases/download/<tag>/<asset>`, not a path containing the
release page label. The exact asset name for TexLink is:

```text
zotero-texlink-<version>.xpi
```

The direct asset URL is required. A link to the HTML release page will not work
as `update_link`.

## Releasing a new version

1. Bump `version` in `manifest.json`.
2. Run the update-manifest helper:

   ```bash
   python3 tools/update_manifest.py
   ```

   The helper reads the current manifest version, adds or replaces that version
   in `updates.json`, and writes the GitHub asset URL automatically.
3. Build the XPI:

   ```bash
   python3 tools/build_xpi.py
   ```

4. Create a GitHub release with tag `v<version>`.
5. Upload the XPI as an asset using exactly the name
   `zotero-texlink-<version>.xpi`.
6. Commit and push the updated `updates.json` and `manifest.json` to `main`.
7. In Zotero, open **Tools → Add-ons**, open the gear menu, and choose
   **Check for Updates**. Zotero also checks periodically and on startup.

The version in `updates.json` must be greater than the installed version. If
the entry has the same version, Zotero correctly reports that no update is
available.

## Important: update_url is baked into the installed XPI

Zotero uses the `update_url` from the **installed** manifest. Rebuilding a newer
XPI does not change the update URL used by an already installed copy.

For that reason, an existing release built with a placeholder update URL cannot
be repaired by editing only `updates.json`. Publish a new version whose XPI
contains the real `update_url`, install that version once, and future versions
can then update automatically.

The currently published v0.1.3 asset was built before this update URL was added.
Replace that asset with the rebuilt
`dist/zotero-texlink-0.1.3.xpi`, or publish a new v0.1.4 release. Existing
installed v0.1.3 copies still contain the placeholder URL and must be reinstalled
once with a build that has the real URL before automatic updates can work for
them.

## Hosting choices

`raw.githubusercontent.com` is used because it is simple, HTTPS-only, and
serves the file from the `main` branch. A GitHub Pages URL or another HTTPS
host is also valid as long as:

- the `update_url` is stable and ends in `.json`;
- the response body is valid JSON;
- the host serves over HTTPS without authentication;
- the file is updated when a release is published.

Do not change `update_url` between ordinary releases. If you must move the host,
publish a build containing the new URL first.

## Zotero update manifest rules

- `updates` must be an array.
- Every item must contain `version`, `update_link`, and the Zotero application
  version range.
- `update_link` must be a direct HTTPS URL to the `.xpi`.
- `version` is compared using add-on version semantics; `0.1.10` is newer than
  `0.1.9`.
- `strict_max_version` should remain compatible with the target Zotero major
  version (`10.999` for Zotero 10).
- The exact plugin ID is `zotero-texlink@yuweidong.dev`.

## Privacy note

The automatic update check is performed by Zotero's Add-on Manager, not by
TexLink's OCR or note-writing code. It sends no screenshots, formulas, notes, or
library data. If update checks are disabled in Zotero, recognition remains fully
offline.
