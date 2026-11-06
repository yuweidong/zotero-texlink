#!/usr/bin/env python3
"""Validate TexLink bundle assets, INT8 model hashes, and offline constraints.

Usage:
    python3 tools/verify_assets.py

Standard library only. Run before building the XPI to catch missing files or a
wrong tokenizer before packaging.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "chrome/content/models"
GITHUB_REPO = "yuweidong/zotero-texlink"
EXPECTED_UPDATE_URL = (
    f"https://raw.githubusercontent.com/{GITHUB_REPO}/main/updates.json"
)
ORT_DIR = ROOT / "chrome/content/vendor/ort"
PLUGIN_ID = "zotero-texlink@yuweidong.dev"
RUNTIME_JS = [
    ROOT / "bootstrap.js",
    ROOT / "chrome/content/scripts/texlink-service.js",
    ROOT / "chrome/content/scripts/worker.js",
]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    sys.exit(1)


def main() -> None:
    required = [
        ROOT / "manifest.json",
        ROOT / "bootstrap.js",
        ROOT / "prefs.js",
        ROOT / "chrome/content/scripts/texlink-service.js",
        ROOT / "chrome/content/scripts/worker.js",
        ROOT / "chrome/content/models/texlink-model.json",
        ROOT / "chrome/content/models/tokenizer.json",
        ROOT / "chrome/content/models/encoder_model_int8.onnx",
        ROOT / "chrome/content/models/decoder_model_int8.onnx",
        ROOT / "chrome/content/vendor/ort/ort.min.js",
        ROOT / "chrome/content/vendor/ort/ort-wasm-simd.wasm",
    ]
    for path in required:
        if not path.is_file() or path.stat().st_size == 0:
            fail(f"Missing asset: {path.relative_to(ROOT)}")

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest.get("applications", {}).get("zotero", {})
    if manifest.get("manifest_version") != 2:
        fail("manifest_version must be 2")
    if not zotero.get("id", "").endswith("@yuweidong.dev"):
        fail("Unexpected Zotero plugin ID in manifest")
    if str(zotero.get("strict_min_version")) != "10.0":
        fail("strict_min_version must be 10.0")
    if "permissions" in manifest:
        fail("Zotero bootstrap manifests must not declare WebExtension permissions")
    # Zotero 10's ExtensionData validation requires update_url, and
    # AddonManager.checkUpdateSecurity requires an https: URL or it marks the
    # add-on appDisabled.
    update_url = str(zotero.get("update_url", ""))
    if not update_url.startswith("https://"):
        fail("applications.zotero.update_url is missing or not https://; Zotero will disable the add-on")
    if update_url != EXPECTED_UPDATE_URL:
        fail(
            "applications.zotero.update_url must be "
            f"{EXPECTED_UPDATE_URL!r}; found {update_url!r}"
        )

    updates_path = ROOT / "updates.json"
    if not updates_path.is_file():
        fail("Missing updates.json (Zotero auto-update manifest)")
    update_document = json.loads(updates_path.read_text(encoding="utf-8"))
    plugin_update = (
        update_document.get("addons", {}).get(PLUGIN_ID, {})
    )
    if "versions" in plugin_update:
        fail("updates.json must use an 'updates' array, not a 'versions' object")
    update_entries = plugin_update.get("updates")
    if not isinstance(update_entries, list) or not update_entries:
        fail("updates.json must contain a non-empty updates array")

    manifest_version = str(manifest["version"])
    version_pattern = re.compile(r"^\d+(?:\.\d+)*$")
    for entry in update_entries:
        if not isinstance(entry, dict):
            fail("Each updates[] entry must be an object")
        entry_version = str(entry.get("version", ""))
        if not version_pattern.fullmatch(entry_version):
            fail(f"Invalid update entry version: {entry_version!r}")
        update_link = str(entry.get("update_link", ""))
        expected_prefix = (
            f"https://github.com/{GITHUB_REPO}/releases/download/"
            f"v{entry_version}/"
        )
        if not update_link.startswith(expected_prefix):
            fail(
                f"Update link for {entry_version} must start with {expected_prefix!r}"
            )
        expected_asset = f"zotero-texlink-{entry_version}.xpi"
        if not update_link.endswith("/" + expected_asset):
            fail(
                f"Update link for {entry_version} must point to {expected_asset!r}"
            )
        ranges = entry.get("applications", {}).get("zotero", {})
        if str(ranges.get("strict_min_version")) != str(zotero["strict_min_version"]):
            fail(f"Update entry {entry_version} has a mismatched strict_min_version")
        if str(ranges.get("strict_max_version")) != str(zotero["strict_max_version"]):
            fail(f"Update entry {entry_version} has a mismatched strict_max_version")

    current_entries = [
        item for item in update_entries
        if str(item.get("version")) == manifest_version
    ]
    if not current_entries:
        fail(
            f"updates.json has no entry for manifest version {manifest_version}; "
            "run tools/update_manifest.py"
        )
    newest = max(
        (str(item["version"]) for item in update_entries),
        key=lambda value: tuple(int(part) for part in value.split(".")),
    )
    if newest != manifest_version:
        fail(
            f"updates.json newest version is {newest}, but manifest version is "
            f"{manifest_version}; run tools/update_manifest.py"
        )

    config = json.loads((MODEL_DIR / "texlink-model.json").read_text(encoding="utf-8"))
    expected = config.get("assets", {})
    for key, filename in [
        ("encoderSha256", "encoder_model_int8.onnx"),
        ("decoderSha256", "decoder_model_int8.onnx"),
        ("tokenizerSha256", "tokenizer.json"),
    ]:
        actual = sha256(MODEL_DIR / filename)
        if actual != expected.get(key):
            fail(f"{filename} SHA256 mismatch: {actual}")

    tokenizer = json.loads((MODEL_DIR / "tokenizer.json").read_text(encoding="utf-8"))
    if tokenizer.get("model", {}).get("type") != "BPE":
        fail("tokenizer.json is not a BPE model")
    if tokenizer.get("decoder", {}).get("type") != "ByteLevel":
        fail("tokenizer decoder is not ByteLevel; check the conversion steps")
    vocab = tokenizer.get("model", {}).get("vocab", {})
    if len(vocab) != config["decoder"]["vocabSize"]:
        fail(
            f"tokenizer vocabulary size {len(vocab)} does not match "
            f"model config {config['decoder']['vocabSize']}"
        )

    # Ensure runtime code cannot accidentally reach the network. Scan code only,
    # not documentation or model metadata.
    external_pattern = re.compile(r"(?:https?:)?//[a-z0-9.-]+\.[a-z]{2,}", re.I)
    for path in RUNTIME_JS:
        text = path.read_text(encoding="utf-8")
        for match in external_pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            fail(f"{path.relative_to(ROOT)}:{line} contains an external URL: {match.group(0)}")
        if re.search(r"\bfetch\s*\(\s*[\"']https?://", text):
            fail(f"{path.relative_to(ROOT)} contains an external fetch")

    print("[OK] manifest / update manifest / models / tokenizer / ORT assets verified")
    print(f"     encoder : {MODEL_DIR.joinpath('encoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     decoder : {MODEL_DIR.joinpath('decoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     wasm    : {ORT_DIR.joinpath('ort-wasm-simd.wasm').stat().st_size / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()
