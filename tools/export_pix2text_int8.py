#!/usr/bin/env python3
"""构建期：下载官方 Pix2Text-MFR ONNX，并做 INT8 动态量化。

注意：此脚本只用于**构建阶段**，绝不会被包含进运行期 XPI，也不会被
Zotero 调用。

官方仓库已经提供了 ONNX encoder/decoder，所以我们不再从 PyTorch 导出，
避免不同 transformers / optimum 版本造成的图差异。流程：

    Hugging Face 官方 ONNX
        -> onnxruntime.quantization.quantize_dynamic(QInt8)
        -> encoder_model_int8.onnx / decoder_model_int8.onnx
        -> 复制 tokenizer.json/config.json
        -> 计算 SHA256，更新 chrome/content/models/texlink-model.json

依赖：
    pip install "huggingface_hub>=0.23" "onnxruntime>=1.19" onnx
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil

from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic

REPO_ID = "breezedeus/pix2text-mfr"
KEEP_FILES = [
    "encoder_model.onnx",
    "decoder_model.onnx",
    "tokenizer.json",
    "config.json",
    "preprocessor_config.json",
    "generation_config.json",
]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("build/pix2text-mfr-int8"),
        help="输出目录",
    )
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    source = pathlib.Path(
        snapshot_download(
            repo_id=REPO_ID,
            allow_patterns=KEEP_FILES,
        )
    )
    print(f"[download] {source}")

    for source_name, target_name in [
        ("encoder_model.onnx", "encoder_model_int8.onnx"),
        ("decoder_model.onnx", "decoder_model_int8.onnx"),
    ]:
        src = source / source_name
        dst = out / target_name
        print(f"[quantize] {src.name} -> {dst.name}")
        quantize_dynamic(
            str(src),
            str(dst),
            weight_type=QuantType.QInt8,
            # 动态量化足以覆盖 MatMul / Gather 权重；不额外做静态校准，
            # 保持构建链路简单、可复现。
        )

    for name in ("tokenizer.json", "config.json", "preprocessor_config.json", "generation_config.json"):
        src = source / name
        if src.is_file():
            shutil.copy2(src, out / name)

    hashes = {
        "encoderSha256": sha256(out / "encoder_model_int8.onnx"),
        "decoderSha256": sha256(out / "decoder_model_int8.onnx"),
        "tokenizerSha256": sha256(out / "tokenizer.json"),
    }
    print("\n[sha256] 把下面的值写回 chrome/content/models/texlink-model.json：")
    print(json.dumps(hashes, indent=2, ensure_ascii=False))
    print(f"\n[done] 把 {out} 下四个文件复制到 chrome/content/models/，")
    print("       并把 encoder/decoder 重命名为 encoder_model_int8.onnx / decoder_model_int8.onnx。")
    print("\n提示：本项目自带模型由 onnxruntime==1.19.2 量化得到；")
    print("      换用其它 ORT 版本时 SHA256 可能变化，必须同步更新 texlink-model.json。")


if __name__ == "__main__":
    main()
