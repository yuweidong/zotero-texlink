# Model conversion guide (build time)

> The runtime plugin never executes the commands in this document. Zotero loads
> only the already-quantized `.onnx` files and `tokenizer.json` shipped inside
> the XPI.

The bundled runtime model is **Pix2Text-MFR**, which publishes official ONNX
encoder/decoder files and a tokenizer. UniMERNet is documented at the end as an
alternative build-time path; it is not bundled because there is no stable
official ONNX export.

---

## 1. Default path: Pix2Text-MFR to ONNX INT8

### 1.1 Environment

```bash
cd /path/to/zotero-texlink
python3 -m venv .venv
source .venv/bin/activate

# Pinned for reproducibility; the bundled files were quantized with 1.19.2.
pip install "huggingface_hub>=0.23" "onnxruntime==1.19.2" onnx
```

If your Hugging Face account needs a token (the public model usually does not):

```bash
export HF_TOKEN=hf_xxx
```

### 1.2 Download and quantize

```bash
python3 tools/export_pix2text_int8.py --out build/pix2text-mfr-int8
```

The script effectively performs:

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

### 1.3 Copy files into the plugin

```bash
cp build/pix2text-mfr-int8/encoder_model_int8.onnx chrome/content/models/
cp build/pix2text-mfr-int8/decoder_model_int8.onnx chrome/content/models/
cp build/pix2text-mfr-int8/tokenizer.json chrome/content/models/
cp build/pix2text-mfr-int8/config.json chrome/content/models/pix2text-mfr-config.json
cp build/pix2text-mfr-int8/preprocessor_config.json \
   chrome/content/models/pix2text-mfr-preprocessor.json
```

Update `assets.encoderSha256`, `assets.decoderSha256`, and
`assets.tokenizerSha256` in `chrome/content/models/texlink-model.json`. The
export script prints the new hashes.

### 1.4 Verify

```bash
python3 tools/verify_assets.py
python3 tools/smoke_test_onnx.py
```

Expected smoke-test output on the bundled fixture:

```text
\int _ { 0 } ^ { \infty } \! e ^ { - x ^ { 2 } } \, d x \! = \! \frac { \sqrt \pi } 2
```

### 1.5 Bundled artifacts

| File | Size | SHA256 |
| --- | ---: | --- |
| `encoder_model_int8.onnx` | 23,112,706 B | `4ccd7d45173a08ad703203e1de0aa205421ed66a4972f553d0882cd74857940f` |
| `decoder_model_int8.onnx` | 7,989,844 B | `1b81c99876de606631449eacf1af32ce372f5641ebed3216e0208bde2bdbeaa6` |
| `tokenizer.json` | 39,161 B | `3e2ab757277d22639bec28c9d7972e352d3d1dba223051fa674002dc5ab64df3` |

Model contract:

```text
encoder: pixel_values float32 [1,3,384,384]
         -> last_hidden_state float32 [1,578,384]
decoder: input_ids int64 [1,seq]
         encoder_hidden_states float32 [1,578,384]
         -> logits float32 [1,seq,1200]
```

Decoding is greedy argmax with `decoder_start_token_id=2`, `eos_token_id=2`,
and `pad_token_id=0`. The decoder is exported with `use_cache=False`, so every
step re-runs the full prefix. This keeps the graph simple and deterministic.

---

## 2. Why UniMERNet is not the default

- UniMERNet weights are distributed through gated/controlled repositories and
  there is no stable official ONNX export.
- Its runtime depends on custom Nougat/TrOCR model code, dynamic image sizes,
  and a more complex tokenizer.
- Pix2Text-MFR publishes ONNX directly, quantizes to a manageable size, and has
  been verified end to end.
- The model contract is isolated in `texlink-model.json`, so a future
  UniMERNet integration can replace the recognizer without changing the note
  anchoring layer.

---

## 3. Appendix: UniMERNet build-time export template (not bundled or verified)

The following is **not used by the shipped plugin**. It documents how to try a
UniMERNet export on a build machine. Model classes, checkpoint names, image
processors, and tokenizer layouts can differ between UniMERNet releases; adapt
these commands to the version you obtain. Never run this code inside Zotero at
runtime.

### 3.1 Obtain weights and tokenizer

Access to OpenDataLab's UniMERNet weights may require approval or login. A
typical download contains:

```text
unimernet_model/
├── model.pth / *.bin      # actual checkpoint name depends on the release
└── tokenizer/             # Nougat tokenizer files
    ├── tokenizer.json
    └── tokenizer_config.json
```

### 3.2 Install build dependencies

```bash
python3 -m venv .venv-unimernet
source .venv-unimernet/bin/activate
pip install "unimernet==0.2.3" torch torchvision onnx onnxruntime
```

### 3.3 Export encoder and decoder

UniMERNet is encoder-decoder based. For deterministic browser decoding, export
the encoder and a decoder graph that does not use a KV cache:

```python
# tools/export_unimernet_template.py
# Build-time template only; adapt it to the actual checkpoint layout.
# This file is not shipped in the XPI.
import torch
from unimernet.models import load_model, load_model_and_preprocess

MODEL_TYPE = "unimernet"
CHECKPOINT = "unimernet_model/model.pth"

model, vis_processors, _ = load_model_and_preprocess(
    "unimernet", MODEL_TYPE, is_eval=True, device="cpu"
)
# If load_model_and_preprocess does not load your checkpoint automatically:
# model.load_checkpoint(CHECKPOINT)
model.eval()

encoder = model.model.encoder
decoder = model.model.decoder

class EncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder

    def forward(self, pixel_values):
        # Check the actual forward() return value for your release; most
        # VisionEncoderDecoder encoders return last_hidden_state.
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

# Input dimensions must match UniMERNet's eval image processor.
# UniMERNet 0.2 commonly uses 192×672; verify with vis_processors["eval"].
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

Before running this, check:

- `unimernet`'s `load_model*` helpers use a complex OmegaConf/registry flow.
  The official `demo.py` (`task.build_model(cfg)`) is a useful reference.
- Whether the tokenizer is a Hugging Face `tokenizer.json` or a
  Nougat/Llama SentencePiece layout determines the tokenizer `kind` in
  `texlink-service.js` (the shipped model uses `bpe-bytelevel`).
- `use_cache=False` must actually take effect; otherwise the exported decoder
  expects `past_key_values`, which the browser runtime does not provide.

### 3.4 Quantize

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

### 3.5 Runtime integration

Update `chrome/content/models/texlink-model.json` to match the new contract, for
example:

```json
{
  "input": {
    "name": "pixel_values",
    "channels": 3,
    "height": 192,
    "width": 672,
    "mean": [0.5, 0.5, 0.5],
    "std": [0.5, 0.5, 0.5]
  },
  "decoder": {
    "inputIds": "input_ids",
    "encoderHiddenStates": "encoder_hidden_states",
    "logits": "logits",
    "startTokenId": 2,
    "eosTokenId": 2,
    "vocabSize": 0,
    "maxNewTokens": 512
  },
  "tokenizer": { "kind": "sentencepiece" }
}
```

Checks:

- `vocabSize` must equal the last dimension of the decoder logits. Do not copy
  Pix2Text's value.
- UniMERNet's image processor may use different mean/std values and resize
  behavior. The current service resizes directly to the configured width and
  height; if the official processor also pads or crops, implement that in the
  Canvas preprocessing step.
- If the tokenizer is not ByteLevel BPE, extend `TexLinkBPEDecoder` or replace
  it with the appropriate decoder. Validate it token by token against the real
  tokenizer.

The shipped plugin provides an end-to-end guarantee only for the bundled
**Pix2Text-MFR INT8** artifacts. UniMERNet support is a future integration.

---

## 4. Product boundary

- No LLM or VLM: no generative model is called, and TexLink does not
  "auto-correct" or complete formulas.
- The only recognition task is deterministic formula-image-to-LaTeX conversion.
- The default output is a Zotero note, not the clipboard.
- When model output has not been verified, TexLink writes it as-is with the
  source text so a human can check it.
