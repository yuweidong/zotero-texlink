# Automatic updates

TexLink uses Zotero's standard add-on update mechanism. Zotero reads the
`applications.zotero.update_url` field from the installed `manifest.json`,
downloads that JSON document, and compares its version with the installed
version.

The update document is a normal JSON file served over HTTPS. It is not part of
the XPI and is never fetched by TexLink's recognition code.

## Current configuration

```text
update manifest:
https://raw.githubusercontent.com/yuweidong/zotero-texlink/main/updates.json

release page:
https://github.com/yuweidong/zotero-texlink/releases/tag/v0.1.4

XPI asset:
https://github.com/yuweidong/zotero-texlink/releases/download/v0.1.4/zotero-texlink-0.1.4.xpi
```

`updates.json` uses an **array** named `updates`. Each version is a separate
object in that array. Do not use a `versions` object keyed by version number.

```json
{
  "addons": {
    "zotero-texlink@yuweidong.dev": {
      "updates": [
        {
          "version": "0.1.4",
          "update_link": "https://github.com/yuweidong/zotero-texlink/releases/download/v0.1.4/zotero-texlink-0.1.4.xpi",
          "update_hash": "sha256:<64-character-xpi-sha256>",
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
https://github.com/<owner>/<repo>/releases/tag/v0.1.4

asset download:
https://github.com/<owner>/<repo>/releases/download/v0.1.4/<asset-name>.xpi
```

The asset path is `/releases/download/<tag>/<asset>`, not a path containing the
release page label. The exact asset name for TexLink is:

```text
zotero-texlink-<version>.xpi
```

The direct asset URL is required. A link to the HTML release page will not work
as `update_link`.

## Releasing a new version

The update helper needs the final XPI in order to compute `update_hash`, but
the build verifier also expects an entry for the new version. Use this two-pass
sequence:

1. Bump `version` in `manifest.json` and the service fallback version.
2. Add the update entry without a hash:

   ```bash
   python3 tools/update_manifest.py --no-hash
   ```

3. Build the XPI:

   ```bash
   python3 tools/build_xpi.py
   ```

4. Add the hash from `dist/zotero-texlink-<version>.xpi`:

   ```bash
   python3 tools/update_manifest.py
   ```

5. Re-run the full verification:

   ```bash
   python3 tools/verify_assets.py
   ```

6. Create a GitHub release with tag `v<version>` and upload the XPI as an asset
   with exactly the name `zotero-texlink-<version>.xpi`.
7. Upload the `.sha256` file as well.
8. Commit and push the final `updates.json` and `manifest.json` to `main`.
9. In Zotero, open **Tools → Add-ons**, open the gear menu, and choose
   **Check for Updates**. Zotero also checks periodically and on startup.

Publish the release asset before pushing the update entry. Otherwise Zotero can
see an update whose download URL returns 404.

The version in `updates.json` must be greater than the installed version. If
the entry has the same version, Zotero correctly reports that no update is
available.

## update_hash

Zotero's update parser supports `update_hash` and validates the downloaded XPI
against a strong SHA-2 hash. TexLink uses:

```text
sha256:<64-character-hex>
```

The helper automatically computes this value from the built XPI. If the XPI is
rebuilt after the helper runs, run the helper again; otherwise the hash will
not match the uploaded asset.

## Important: update_url is baked into the installed XPI

Zotero uses the `update_url` from the **installed** manifest. Rebuilding a newer
XPI does not change the update URL used by an already installed copy.

The published v0.1.3 XPI already contains the real update URL and matches the
v0.1.3 release asset. Existing v0.1.3 users can therefore update to v0.1.4
automatically once the v0.1.4 entry is live. Older builds that still contain a
placeholder update URL require one manual install of a corrected build.

Do not change `update_url` between ordinary releases. If you must move the
host, publish a build containing the new URL first.

## Hosting choices

`raw.githubusercontent.com` is used because it is simple, HTTPS-only, and
serves the file from the `main` branch. A GitHub Pages URL or another HTTPS
host is also valid as long as:

- the `update_url` is stable and ends in `.json`;
- the response body is valid JSON;
- the host serves over HTTPS without authentication;
- the file is updated when a release is published.

The content type does not need to be `application/json`; Zotero parses the
response body itself.

## Zotero update manifest rules

- `updates` must be an array.
- Every item must contain `version`, `update_link`, and the Zotero application
  version range.
- `update_link` must be a direct HTTPS URL to the `.xpi`.
- `update_hash` is optional but strongly recommended for release assets.
- `version` is compared using add-on version semantics; `0.1.10` is newer than
  `0.1.9`.
- `strict_max_version` should remain compatible with the target Zotero major
  version (`10.999` for Zotero 10).
- The exact plugin ID is `zotero-texlink@yuweidong.dev`.

## CI

`.github/workflows/verify.yml` runs the asset checks, decoder tests, service
helper tests, and an XPI build on pushes and pull requests.

`.github/workflows/release.yml` runs on `v*` tags and requires:

- the tag version to equal the manifest version;
- a matching `updates.json` entry with a `sha256:` hash;
- a successful build and hash verification.

It then creates or updates the GitHub release and uploads the XPI and checksum.

## Privacy note

The automatic update check is performed by Zotero's Add-on Manager, not by
TexLink's OCR or note-writing code. It sends no screenshots, formulas, notes, or
library data. If update checks are disabled in Zotero, recognition remains fully
offline.
