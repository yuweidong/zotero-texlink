# Third-party notices / 第三方组件声明

TexLink V0.1 的 XPI 中包含以下第三方组件。它们均随安装包离线分发，
运行期不会联网。

## Pix2Text-MFR（模型权重与 tokenizer）

- 项目：Pix2Text / Math Formula Recognition model
- 来源：<https://huggingface.co/breezedeus/pix2text-mfr>
- 架构：TrOCR / VisionEncoderDecoder（DeiT encoder + TrOCR decoder）
- 许可：MIT
- 版权：Copyright (c) 2022 BreezeDeus
- 打包内容：
  - `encoder_model_int8.onnx`：由官方 `encoder_model.onnx` 经
    ONNX Runtime dynamic quantization（QInt8）得到
  - `decoder_model_int8.onnx`：由官方 `decoder_model.onnx` 经同一流程量化
  - `tokenizer.json`：来自官方仓库
- 原始权重许可：MIT；本仓库在 `third_party/LICENSE-pix2text.txt` 中保留
  完整许可文本。
- 模型卡片和历史版本见 Hugging Face 仓库；模型仅用于数学公式图像到
  LaTeX 的确定性识别，未使用 LLM/VLM。

## onnxruntime-web

- 项目：ONNX Runtime
- 来源：<https://github.com/microsoft/onnxruntime>
- 版本：1.17.3（`onnxruntime-web` npm 包）
- 许可：MIT
- 版权：Copyright (c) Microsoft Corporation
- 打包内容：`ort.min.js`、`ort-wasm-simd.wasm`
- 完整许可文本：`third_party/LICENSE-onnxruntime.txt`

## 不在 XPI 中的组件

- Zotero 本身及其内置 KaTeX / Firefox ESR 运行时不随本 XPI 分发。
- 构建期工具（Python、ONNX Runtime Python、Pillow、Hugging Face Hub）
  不属于运行期交付物。

## 备注

本文件不是法律意见。若要在组织内分发，请按贵组织的开源合规流程
复核模型训练数据、出口管制和第三方依赖许可。
