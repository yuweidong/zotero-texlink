#!/usr/bin/env python3
"""构建可双击安装的 TexLink .xpi。

Zotero Bootstrap 插件的 XPI 就是一个 ZIP 文件，manifest.json、
bootstrap.js、prefs.js 必须位于 ZIP 根目录。ONNX、WASM、tokenizer
全部随包携带，运行期没有任何网络依赖。

用法：
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
        raise SystemExit("XPI 缺少必要文件：" + ", ".join(sorted(missing)))

    # 不允许目录穿越；所有文件必须位于项目根目录下。
    for path, rel in files:
        path.resolve().relative_to(ROOT.resolve())

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # manifest.json 放第一个，便于人工排查 ZIP 结构。
        manifest_entry = next(item for item in files if item[1] == "manifest.json")
        zf.write(manifest_entry[0], manifest_entry[1])

        # 一些老式 ZIP 读取器/AddonManager 更习惯显式的目录条目；
        # 虽然目录条目不是 Zotero 的硬性要求，但加上能提升兼容性。
        directories = set()
        for _, rel in files:
            parent = pathlib.PurePosixPath(rel).parent
            while str(parent) not in ("", "."):
                directories.add(str(parent))
                parent = parent.parent
        directories = sorted(directories)
        for directory in directories:
            # 固定目录条目时间，保证同一份源码重复构建得到相同 SHA256。
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
    print(f"[OK] 已生成 {output.relative_to(ROOT)} ({size_mb:.1f} MiB)")
    print(f"     SHA256 {digest}")
    print("     安装：Zotero 10 -> 工具 -> 插件 -> 齿轮 -> 从文件安装插件")


if __name__ == "__main__":
    main()
