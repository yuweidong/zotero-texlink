#!/usr/bin/env python3
"""校验 TexLink 打包资源是否完整、是否为预期的 INT8 模型与离线资源。

用法：
    python3 tools/verify_assets.py

只依赖 Python 标准库。构建 XPI 前运行，避免把 404 占位文件或错误的
tokenizer 打进最终交付物。
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
            fail(f"缺少资源：{path.relative_to(ROOT)}")

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest.get("applications", {}).get("zotero", {})
    if manifest.get("manifest_version") != 2:
        fail("manifest_version 必须为 2")
    if not zotero.get("id", "").endswith("@yuweidong.dev"):
        fail("manifest 中的 Zotero 插件 ID 不符合预期")
    if str(zotero.get("strict_min_version")) != "10.0":
        fail("strict_min_version 必须为 10.0")
    if "permissions" in manifest:
        fail("Zotero bootstrap 插件清单不使用 WebExtension permissions 字段")
    # Zotero 10 的 ExtensionData 校验强制要求 update_url；同时
    # AddonManager.checkUpdateSecurity 要求它以 https: 开头，否则 appDisabled。
    update_url = str(zotero.get("update_url", ""))
    if not update_url.startswith("https://"):
        fail("applications.zotero.update_url 缺失或不是 https://，插件会被 Zotero 禁用")

    config = json.loads((MODEL_DIR / "texlink-model.json").read_text(encoding="utf-8"))
    expected = config.get("assets", {})
    for key, filename in [
        ("encoderSha256", "encoder_model_int8.onnx"),
        ("decoderSha256", "decoder_model_int8.onnx"),
        ("tokenizerSha256", "tokenizer.json"),
    ]:
        actual = sha256(MODEL_DIR / filename)
        if actual != expected.get(key):
            fail(f"{filename} SHA256 不匹配：{actual}")

    tokenizer = json.loads((MODEL_DIR / "tokenizer.json").read_text(encoding="utf-8"))
    if tokenizer.get("model", {}).get("type") != "BPE":
        fail("tokenizer.json 不是 BPE 模型")
    if tokenizer.get("decoder", {}).get("type") != "ByteLevel":
        fail("tokenizer decoder 不是 ByteLevel，请检查模型转换步骤")
    vocab = tokenizer.get("model", {}).get("vocab", {})
    if len(vocab) != config["decoder"]["vocabSize"]:
        fail(
            f"tokenizer 词表大小 {len(vocab)} 与模型配置 "
            f"{config['decoder']['vocabSize']} 不一致"
        )

    # 确保运行时不会意外访问外网。这里只扫代码，不扫文档/模型配置。
    external_pattern = re.compile(r"(?:https?:)?//[a-z0-9.-]+\.[a-z]{2,}", re.I)
    for path in RUNTIME_JS:
        text = path.read_text(encoding="utf-8")
        for match in external_pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            fail(f"{path.relative_to(ROOT)}:{line} 出现外部 URL：{match.group(0)}")
        if re.search(r"\bfetch\s*\(\s*[\"']https?://", text):
            fail(f"{path.relative_to(ROOT)} 包含外部 fetch")

    print("[OK] manifest / 模型 / tokenizer / ORT 资源校验通过")
    print(f"     encoder : {MODEL_DIR.joinpath('encoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     decoder : {MODEL_DIR.joinpath('decoder_model_int8.onnx').stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"     wasm    : {ORT_DIR.joinpath('ort-wasm-simd.wasm').stat().st_size / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()
