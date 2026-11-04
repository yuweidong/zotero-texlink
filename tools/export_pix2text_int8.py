#!/usr/bin/env python3
"""Build-time download and INT8 dynamic quantization for Pix2Text-MFR.

This script is **build-time only**. It is never included in the runtime XPI and
is never called by Zotero.

The official repository already provides ONNX encoder/decoder files, so there
is no PyTorch export and no graph variation from transformers/optimum
versions. Flow:

    official Hugging Face ONNX
        -> onnxruntime.quantization.quantize_dynamic(QInt8)
        -> encoder_model_int8.onnx / decoder_model_int8.onnx
        -> copy tokenizer.json/config.json
        -> compute SHA256 values for chrome/content/models/texlink-model.json

Dependencies:
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
        help="Output directory",
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
            # Dynamic quantization covers MatMul/Gather weights. No static
            # calibration is used, keeping the build simple and reproducible.
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
    print("\n[sha256] Write these values back to chrome/content/models/texlink-model.json:")
    print(json.dumps(hashes, indent=2, ensure_ascii=False))
    print(f"\n[done] Copy the four files from {out} into chrome/content/models/,")
    print("       using the encoder_model_int8.onnx and decoder_model_int8.onnx names.")
    print("\nNote: the bundled files were quantized with onnxruntime==1.19.2;")
    print("      another ORT version can change the hashes. Update texlink-model.json.")


if __name__ == "__main__":
    main()
