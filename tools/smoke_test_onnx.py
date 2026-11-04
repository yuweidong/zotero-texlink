#!/usr/bin/env python3
"""End-to-end smoke test for the INT8 ONNX models bundled in the XPI.

Build/test-time only; not included in the XPI. It reproduces the numerical path
used by texlink-service.js + worker.js:

  RGB -> 384x384 BICUBIC -> /255 -> (x-0.5)/0.5 -> CHW float32
  encoder -> greedy decoder -> token ids -> ByteLevel BPE -> LaTeX

Dependencies:
    pip install onnxruntime numpy pillow

Usage:
    python3 tools/smoke_test_onnx.py [image-path]
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "chrome/content/models"
DEFAULT_IMAGE = ROOT / "tests/fixtures/formula.png"


def build_byte_decoder() -> dict[str, int]:
    """GPT-2 ByteLevel map matching _buildByteMap in the service."""
    bs = list(range(ord("!"), ord("~") + 1))
    bs += list(range(ord("¡"), ord("¬") + 1))
    bs += list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for b, c in zip(bs, cs)}


def decode_ids(ids: list[int], tokenizer: dict) -> str:
    vocab = tokenizer["model"]["vocab"]
    id_to_token = {int(v): k for k, v in vocab.items()}
    special = {int(t["id"]) for t in tokenizer.get("added_tokens", []) if t.get("special")}
    byte_map = build_byte_decoder()
    raw = bytearray()
    for token_id in ids:
        if token_id in special:
            continue
        token = id_to_token.get(token_id, "")
        for ch in token:
            if ch in byte_map:
                raw.append(byte_map[ch])
            else:
                raw.extend(ch.encode("utf-8"))
    return raw.decode("utf-8", "replace").strip()


def main() -> None:
    image_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IMAGE
    if not image_path.is_file():
        raise SystemExit(f"Test image not found: {image_path}")

    import json

    config = json.loads((MODEL_DIR / "texlink-model.json").read_text(encoding="utf-8"))
    tokenizer = json.loads((MODEL_DIR / "tokenizer.json").read_text(encoding="utf-8"))

    image = Image.open(image_path).convert("RGB").resize(
        (config["input"]["width"], config["input"]["height"]),
        Image.Resampling.BICUBIC,
    )
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - np.asarray(config["input"]["mean"], dtype=np.float32)) / np.asarray(
        config["input"]["std"], dtype=np.float32
    )
    array = np.transpose(array, (2, 0, 1))[None, ...]

    encoder = ort.InferenceSession(
        str(MODEL_DIR / config["files"]["encoder"]),
        providers=["CPUExecutionProvider"],
    )
    decoder = ort.InferenceSession(
        str(MODEL_DIR / config["files"]["decoder"]),
        providers=["CPUExecutionProvider"],
    )
    hidden = encoder.run(None, {config["input"]["name"]: array})[0]

    ids = [config["decoder"]["startTokenId"]]
    for _ in range(config["decoder"]["maxNewTokens"]):
        logits = decoder.run(
            None,
            {
                config["decoder"]["inputIds"]: np.asarray([ids], dtype=np.int64),
                config["decoder"]["encoderHiddenStates"]: hidden,
            },
        )[0]
        next_id = int(np.argmax(logits[0, -1]))
        ids.append(next_id)
        if next_id == config["decoder"]["eosTokenId"]:
            break

    latex = decode_ids(ids[1:], tokenizer)
    print(f"Image: {image_path}")
    print(f"Tokens: {len(ids) - 2}")
    print(f"LaTeX: {latex}")
    if not latex:
        raise SystemExit("Model returned an empty result")
    if not latex.startswith("\\"):
        raise SystemExit("Output does not look like LaTeX (missing leading backslash)")
    print("[OK] ONNX inference and JS-compatible BPE byte decoding passed")


if __name__ == "__main__":
    main()
