# 模型转换指南（构建期）

> 运行期插件绝不执行本文命令。Zotero 中只加载已经量化好的 `.onnx` 文件和
> `tokenizer.json`。

TexLink V0.1 的运行包使用 **Pix2Text-MFR**，它在产品允许的
“UniMERNet/Pix2Text”范围内，并且官方仓库直接提供 ONNX encoder/decoder。
UniMERNet 的转换放在文末附录，作为可替换路线；它没有被 V0.1 运行包采用。

---

## 1. 默认路线：Pix2Text-MFR → ONNX INT8

### 1.1 环境

```bash
cd /path/to/zotero-texlink
python3 -m venv .venv
source .venv/bin/activate

# 固定版本便于复现；本项目自带模型使用 onnxruntime==1.19.2 量化
pip install "huggingface_hub>=0.23" "onnxruntime==1.19.2" onnx
```

如果需要访问 Hugging Face 的凭据（公开模型通常不需要）：

```bash
export HF_TOKEN=hf_xxx
```

### 1.2 一键下载 + 量化

```bash
python3 tools/export_pix2text_int8.py --out build/pix2text-mfr-int8
```

脚本实际做的是：

```python
from huggingface_hub import snapshot_download
from onnxruntime.quantization import quantize_dynamic, QuantType

source = snapshot_download(
    repo_id="breezedeus/pix2text-mfr",
    allow_patterns=[
        "encoder_model.onnx",
        "decoder_model.onnx",
        "tokenizer.json",
        "config.json",
        "preprocessor_config.json",
        "generation_config.json",
    ],
)

quantize_dynamic(
    f"{source}/encoder_model.onnx",
    "build/pix2text-mfr-int8/encoder_model_int8.onnx",
    weight_type=QuantType.QInt8,
)
quantize_dynamic(
    f"{source}/decoder_model.onnx",
    "build/pix2text-mfr-int8/decoder_model_int8.onnx",
    weight_type=QuantType.QInt8,
)
```

### 1.3 复制到插件资源目录

```bash
cp build/pix2text-mfr-int8/encoder_model_int8.onnx chrome/content/models/
cp build/pix2text-mfr-int8/decoder_model_int8.onnx chrome/content/models/
cp build/pix2text-mfr-int8/tokenizer.json chrome/content/models/
cp build/pix2text-mfr-int8/config.json chrome/content/models/pix2text-mfr-config.json
cp build/pix2text-mfr-int8/preprocessor_config.json \
   chrome/content/models/pix2text-mfr-preprocessor.json
```

更新 `chrome/content/models/texlink-model.json` 中的
`assets.encoderSha256`、`assets.decoderSha256`、`assets.tokenizerSha256`。
脚本会把新的 SHA256 直接打印出来。

### 1.4 校验

```bash
python3 tools/verify_assets.py
python3 tools/smoke_test_onnx.py
```

本机已验证输出：

```text
\int _ { 0 } ^ { \infty } \! e ^ { - x ^ { 2 } } \, d x \! = \! \frac { \sqrt \pi } 2
```

### 1.5 当前打包模型

| 文件 | 大小 | SHA256 |
| --- | ---: | --- |
| `encoder_model_int8.onnx` | 23,112,706 B | `4ccd7d45173a08ad703203e1de0aa205421ed66a4972f553d0882cd74857940f` |
| `decoder_model_int8.onnx` | 7,989,844 B | `1b81c99876de606631449eacf1af32ce372f5641ebed3216e0208bde2bdbeaa6` |
| `tokenizer.json` | 39,161 B | `3e2ab757277d22639bec28c9d7972e352d3d1dba223051fa674002dc5ab64df3` |

模型结构：

```text
encoder: pixel_values float32 [1,3,384,384]
         -> last_hidden_state float32 [1,578,384]
decoder: input_ids int64 [1,seq]
         encoder_hidden_states float32 [1,578,384]
         -> logits float32 [1,seq,1200]
```

推理方式：贪心 argmax，`decoder_start_token_id=2`，`eos_token_id=2`，
`pad_token_id=0`。解码器使用 `use_cache=False` 的导出，所以每一步都重新
前向完整 prefix；这样导出稳定、结果确定，适合 V0.1。

---

## 2. 为什么 V0.1 不用 UniMERNet

- UniMERNet 官方模型权重在受控/需要申请的仓库中分发，且没有稳定的官方
  ONNX 导出；
- 它更依赖自定义 Nougat/TrOCR 代码、动态图像尺寸和更复杂的 tokenizer；
- Pix2Text-MFR 官方直接提供 ONNX，量化后体积可控，端到端已验证；
- TexLink 的架构通过 `texlink-model.json` 解耦了模型契约，后续可以接
  UniMERNet，而不改笔记锚定层。

---

## 3. 附录：UniMERNet 构建期导出模板（未随包验证）

以下流程**不被 V0.1 运行包采用**，仅用于说明如何在构建机上尝试。UniMERNet
不同版本的模型类、权重文件名和 tokenizer 布局可能变化，必须按你下载的
版本调整。不要把这些命令放进 Zotero 插件运行期。

### 3.1 获取权重与 tokenizer

先确认你有权访问 OpenDataLab 的 UniMERNet 权重（官方仓库/模型发布页可能
需要申请或登录）。取得权重目录后，应当至少包含：

```text
unimernet_model/
├── model.pth / *.bin      # 实际 checkpoint 文件名以官方发布为准
└── tokenizer/             # Nougat tokenizer 文件
    ├── tokenizer.json
    └── tokenizer_config.json
```

### 3.2 安装构建期依赖

```bash
python3 -m venv .venv-unimernet
source .venv-unimernet/bin/activate
pip install "unimernet==0.2.3" torch torchvision onnx onnxruntime
```

### 3.3 导出 encoder / decoder

UniMERNet 是 encoder-decoder 架构；为了在浏览器里做确定性贪心解码，建议
分别导出 encoder 和“不带 KV cache”的 decoder：

```python
# tools/export_unimernet_template.py
# 这是一个需要按实际权重布局调整的构建期模板，不随 XPI 发布。
import torch
from unimernet.models import load_model, load_model_and_preprocess

MODEL_TYPE = "unimernet"   # 以及官方发布对应的 checkpoint
CHECKPOINT = "unimernet_model/model.pth"

model, vis_processors, _ = load_model_and_preprocess(
    "unimernet", MODEL_TYPE, is_eval=True, device="cpu"
)
# 若 load_model_and_preprocess 没有自动加载你的 checkpoint：
# model.load_checkpoint(CHECKPOINT)
model.eval()

encoder = model.model.encoder
decoder = model.model.decoder

class EncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder

    def forward(self, pixel_values):
        # 具体字段名以实际 forward 返回值为准；大多数 VisionEncoderDecoder
        # encoder 返回 last_hidden_state。
        out = self.encoder(pixel_values=pixel_values)
        return out.last_hidden_state

class DecoderWrapper(torch.nn.Module):
    def __init__(self, decoder):
        super().__init__()
        self.decoder = decoder

    def forward(self, input_ids, encoder_hidden_states):
        out = self.decoder(
            input_ids=input_ids,
            encoder_hidden_states=encoder_hidden_states,
            use_cache=False,
        )
        return out.logits

# 输入尺寸必须与 UniMERNet 的 eval image processor 一致。
# 官方 V0.2 常用 192×672；请用 vis_processors["eval"] 的 size 核对。
pixel_values = torch.randn(1, 3, 192, 672)
encoder_hidden = EncoderWrapper(encoder)(pixel_values)
input_ids = torch.tensor([[2, 64, 370]], dtype=torch.long)

torch.onnx.export(
    EncoderWrapper(encoder).eval(),
    (pixel_values,),
    "build/unimernet/encoder_model.onnx",
    input_names=["pixel_values"],
    output_names=["last_hidden_state"],
    dynamic_axes={"pixel_values": {0: "batch_size"}},
    opset_version=17,
)

torch.onnx.export(
    DecoderWrapper(decoder).eval(),
    (input_ids, encoder_hidden),
    "build/unimernet/decoder_model.onnx",
    input_names=["input_ids", "encoder_hidden_states"],
    output_names=["logits"],
    dynamic_axes={
        "input_ids": {0: "batch_size", 1: "decoder_sequence_length"},
        "encoder_hidden_states": {0: "batch_size", 1: "encoder_sequence_length"},
        "logits": {0: "batch_size", 1: "decoder_sequence_length"},
    },
    opset_version=17,
)
```

实际执行前需要处理：

- `unimernet` 包的 `load_model*` 是一个较复杂的 OmegaConf/registry 流程；
  也可以直接参考官方 `demo.py` 的 `task.build_model(cfg)`；
- tokenizer 是否为 HuggingFace `tokenizer.json`、是否是 Nougat/Llama
  SentencePiece 格式，决定 `texlink-service.js` 中 tokenizer 的
  `kind` 配置（当前运行包默认 `bpe-bytelevel`）；
- 导出 decoder 时 `use_cache=False` 必须生效，否则会得到带
  `past_key_values` 的图，浏览器端协议不匹配。

### 3.4 量化

```bash
mkdir -p build/unimernet
python3 - <<'PY'
from onnxruntime.quantization import quantize_dynamic, QuantType

for name in ("encoder_model", "decoder_model"):
    quantize_dynamic(
        f"build/unimernet/{name}.onnx",
        f"build/unimernet/{name}_int8.onnx",
        weight_type=QuantType.QInt8,
    )
PY
```

### 3.5 接入运行时需要修改什么

把 `chrome/content/models/texlink-model.json` 改成对应契约，例如：

```json
{
  "input": {"name": "pixel_values", "channels": 3, "height": 192, "width": 672,
            "mean": [0.5,0.5,0.5], "std": [0.5,0.5,0.5]},
  "decoder": {
    "inputIds": "input_ids",
    "encoderHiddenStates": "encoder_hidden_states",
    "logits": "logits",
    "startTokenId": 2,
    "eosTokenId": 2,
    "vocabSize": 0,
    "maxNewTokens": 512
  },
  "tokenizer": {"kind": "sentencepiece"}
}
```

注意：

- `vocabSize` 必须与 decoder 最后一维一致；不要从 Pix2Text 的值复制。
- UniMERNet 的 image processor 可能使用不同 mean/std 和不同 resize 策略。
  当前 `texlink-service.js` 是直接 resize 到配置宽高；若官方 processor
  还包含 padding/crop，需要在 Canvas 预处理阶段同步实现。
- 若 tokenizer 不是 ByteLevel BPE，需扩展 service 中的
  `TexLinkBPEDecoder` 或替换为对应解码器；这部分必须用真实 tokenizer
  做逐 token 回归测试。

因此，V0.1 只对 **随包提供的 Pix2Text-MFR INT8** 提供端到端保证；
UniMERNet 路线属于后续适配项。

---

## 4. 模型选择的产品边界

- 不使用 LLM/VLM：不调用任何生成式模型，不进行“自动纠正”或补全。
- 只做单个公式图像到 LaTeX 的确定性映射。
- 不把识别结果写进剪贴板作为默认出口；默认出口是 Zotero 笔记。
- 模型输出未经正确性校验时，仍原样写入并附源码，方便用户人工核对。
