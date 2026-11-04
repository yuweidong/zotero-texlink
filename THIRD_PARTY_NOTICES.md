# Third-party notices

The TexLink XPI bundles the following third-party components. They are
distributed offline with the plugin, and none of them makes a network request
at runtime.

## Pix2Text-MFR (model weights and tokenizer)

- Project: Pix2Text / Math Formula Recognition model
- Source: <https://huggingface.co/breezedeus/pix2text-mfr>
- Architecture: TrOCR / VisionEncoderDecoder (DeiT encoder + TrOCR decoder)
- License: MIT
- Copyright: Copyright (c) 2022 BreezeDeus
- Bundled files:
  - `encoder_model_int8.onnx`: derived from the official
    `encoder_model.onnx` with ONNX Runtime dynamic quantization (QInt8)
  - `decoder_model_int8.onnx`: derived from the official
    `decoder_model.onnx` with the same quantization flow
  - `tokenizer.json`: from the official repository
- The upstream weights are MIT-licensed. The complete license text is kept in
  `third_party/LICENSE-pix2text.txt`.
- The model is used only for deterministic image-to-LaTeX recognition. TexLink
  does not use an LLM or VLM.

## onnxruntime-web

- Project: ONNX Runtime
- Source: <https://github.com/microsoft/onnxruntime>
- Version: 1.17.3 (`onnxruntime-web` npm package)
- License: MIT
- Copyright: Copyright (c) Microsoft Corporation
- Bundled files: `ort.min.js`, `ort-wasm-simd.wasm`
- Complete license text: `third_party/LICENSE-onnxruntime.txt`

## Not included in the XPI

- Zotero itself, its bundled KaTeX, and the Firefox ESR runtime are not
  distributed with this XPI.
- Build-time tools (Python, ONNX Runtime for Python, Pillow, and Hugging Face
  Hub) are not runtime dependencies.

## Note

This file is not legal advice. Organizations that redistribute TexLink should
review model training-data provenance, export controls, and third-party license
obligations under their own open-source compliance process.
