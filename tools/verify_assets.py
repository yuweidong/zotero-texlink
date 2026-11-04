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
ORT_DIR = ROOT / "chrome/content/vendor/ort"
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

    print("[OK] manifest / models / tokenizer / ORT assets verified")
    print(f"     encoder : {MODEL_DIR.joinpath('encoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     decoder : {MODEL_DIR.joinpath('decoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     wasm    : {ORT_DIR.joinpath('ort-wasm-simd.wasm').stat().st_size / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()
