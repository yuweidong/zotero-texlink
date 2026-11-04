#!/usr/bin/env python3
"""Build a double-clickable TexLink .xpi.

A Zotero bootstrap plugin XPI is a ZIP archive. manifest.json, bootstrap.js,
and prefs.js must be at the archive root. The ONNX models, WASM runtime, and
tokenizer are bundled; the runtime has no network dependency.

Usage:
    python3 tools/verify_assets.py
    python3 tools/build_xpi.py
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
INCLUDE_DIRS = [
    "chrome/content",
    "third_party",
]
INCLUDE_FILES = [
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    subprocess.run([sys.executable, str(ROOT / "tools/verify_assets.py")], check=True)
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    output = DIST / f"zotero-texlink-{version}.xpi"

    files: list[tuple[pathlib.Path, str]] = []
    for rel in INCLUDE_FILES:
        path = ROOT / rel
        if path.is_file():
            files.append((path, rel))
    for rel in INCLUDE_DIRS:
        base = ROOT / rel
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if path.name in (".DS_Store", "Thumbs.db"):
                continue
            files.append((path, path.relative_to(ROOT).as_posix()))

    required = {
        "manifest.json",
        "bootstrap.js",
        "prefs.js",
        "chrome/content/scripts/texlink-service.js",
        "chrome/content/scripts/worker.js",
        "chrome/content/models/encoder_model_int8.onnx",
        "chrome/content/models/decoder_model_int8.onnx",
        "chrome/content/models/tokenizer.json",
        "chrome/content/vendor/ort/ort.min.js",
        "chrome/content/vendor/ort/ort-wasm-simd.wasm",
    }
    present = {rel for _, rel in files}
    missing = required - present
    if missing:
        raise SystemExit("Missing required XPI files: " + ", ".join(sorted(missing)))

    # Reject path traversal: every file must stay under the project root.
    for path, rel in files:
        path.resolve().relative_to(ROOT.resolve())

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # Keep manifest.json first so the archive layout is easy to inspect.
        manifest_entry = next(item for item in files if item[1] == "manifest.json")
        zf.write(manifest_entry[0], manifest_entry[1])

        # Some older ZIP readers and AddonManager versions expect explicit
        # directory entries. They are not required by Zotero, but they improve
        # compatibility.
        directories = set()
        for _, rel in files:
            parent = pathlib.PurePosixPath(rel).parent
            while str(parent) not in ("", "."):
                directories.add(str(parent))
                parent = parent.parent
        directories = sorted(directories)
        for directory in directories:
            # Fixed timestamps make repeated builds of the same tree hashable.
            info = zipfile.ZipInfo(directory + "/", date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (0o40755 << 16) | 0x10
            info.compress_type = zipfile.ZIP_STORED
            zf.writestr(info, b"")

        for path, rel in sorted(files, key=lambda item: item[1]):
            if rel == "manifest.json":
                continue
            zf.write(path, rel)

    size_mb = output.stat().st_size / 1024 / 1024
    digest = sha256(output)
    (DIST / f"zotero-texlink-{version}.xpi.sha256").write_text(
        f"{digest}  {output.name}\n", encoding="utf-8"
    )
    print(f"[OK] Built {output.relative_to(ROOT)} ({size_mb:.1f} MiB)")
    print(f"     SHA256 {digest}")
    print("     Install: Zotero 10 -> Tools -> Add-ons -> gear -> Install Add-on From File...")


if __name__ == "__main__":
    main()
