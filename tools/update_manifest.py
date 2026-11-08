#!/usr/bin/env python3
"""Add the current TexLink version to the Zotero update manifest.

The update document uses Zotero's `updates` array format. It is a server-side
file and is not packaged inside the XPI.

Usage:
    python3 tools/update_manifest.py
    python3 tools/update_manifest.py --version 0.1.4 --tag v0.1.4

Bump `version` in manifest.json before running this script. The script verifies
the manifest update URL, adds or replaces the version entry, writes a direct
GitHub release asset URL, and computes update_hash from the built XPI.

Use --no-hash for the first pass before build_xpi.py, then run the script again
after the XPI exists to add the final SHA-256 hash.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest.json"
UPDATES = ROOT / "updates.json"
PLUGIN_ID = "zotero-texlink@yuweidong.dev"
DEFAULT_REPO = "yuweidong/zotero-texlink"
EXPECTED_UPDATE_URL = (
    f"https://raw.githubusercontent.com/{DEFAULT_REPO}/main/updates.json"
)


def version_key(value: str) -> tuple[int, ...]:
    """Return a sortable tuple for simple numeric add-on versions."""
    match = re.fullmatch(r"\d+(?:\.\d+)*", value)
    if not match:
        raise ValueError(f"Unsupported version format: {value!r}")
    return tuple(int(part) for part in value.split("."))


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        help="Version to add; defaults to manifest.json's version",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help="GitHub owner/repository used for release asset URLs",
    )
    parser.add_argument(
        "--tag",
        help="Git tag; defaults to v<version>",
    )
    parser.add_argument(
        "--asset",
        help="Release asset name; defaults to zotero-texlink-<version>.xpi",
    )
    parser.add_argument(
        "--xpi",
        type=pathlib.Path,
        help="Built XPI used for update_hash; defaults to dist/<asset>",
    )
    parser.add_argument(
        "--no-hash",
        action="store_true",
        help="Do not add update_hash (not recommended for a release)",
    )
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    version = args.version or str(manifest["version"])
    if version != str(manifest["version"]):
        raise SystemExit(
            "manifest.json version is "
            f"{manifest['version']!r}, but --version is {version!r}. "
            "Bump manifest.json first."
        )

    expected_update_url = (
        f"https://raw.githubusercontent.com/{args.repo}/main/updates.json"
    )
    if zotero.get("update_url") != expected_update_url:
        raise SystemExit(
            "manifest.json applications.zotero.update_url must be "
            f"{expected_update_url!r}; found {zotero.get('update_url')!r}"
        )

    tag = args.tag or f"v{version}"
    asset = args.asset or f"zotero-texlink-{version}.xpi"
    xpi_path = args.xpi or (ROOT / "dist" / asset)
    update_link = (
        f"https://github.com/{args.repo}/releases/download/{tag}/{asset}"
    )

    update_hash = None
    if not args.no_hash:
        if not xpi_path.is_file():
            raise SystemExit(
                f"Built XPI not found at {xpi_path}. Run tools/build_xpi.py first, "
                "or pass --no-hash explicitly."
            )
        update_hash = f"sha256:{sha256(xpi_path)}"

    if UPDATES.is_file():
        document = json.loads(UPDATES.read_text(encoding="utf-8"))
    else:
        document = {"addons": {}}

    addons = document.setdefault("addons", {})
    plugin = addons.setdefault(PLUGIN_ID, {})
    if "versions" in plugin:
        raise SystemExit(
            "updates.json uses a 'versions' object. Zotero expects an 'updates' "
            "array; remove the legacy field before running this script."
        )

    updates = plugin.setdefault("updates", [])
    if not isinstance(updates, list):
        raise SystemExit("updates.json field updates must be an array")

    entry: dict[str, Any] = {
        "version": version,
        "update_link": update_link,
        "applications": {
            "zotero": {
                "strict_min_version": str(zotero["strict_min_version"]),
                "strict_max_version": str(zotero["strict_max_version"]),
            }
        },
    }
    if update_hash:
        entry["update_hash"] = update_hash

    updates = [
        item for item in updates
        if not (isinstance(item, dict) and str(item.get("version")) == version)
    ]
    updates.append(entry)
    updates.sort(key=lambda item: version_key(str(item["version"])), reverse=True)
    plugin["updates"] = updates

    UPDATES.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"[OK] Updated {UPDATES.relative_to(ROOT)} for {version}")
    print(f"     update_url: {expected_update_url}")
    print(f"     asset     : {update_link}")
    if update_hash:
        print(f"     update_hash: {update_hash}")
    print("     Next: publish the GitHub release, upload the XPI asset, then commit/push.")


if __name__ == "__main__":
    main()
