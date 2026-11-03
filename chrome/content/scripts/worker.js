/*
 * TexLink Web Worker
 * =================
 *
 * 职责：
 *   - 在 Worker 线程中加载 onnxruntime-web；
 *   - 加载 INT8 量化后的 Pix2Text-MFR 编码器 / 解码器；
 *   - 接收主线程预处理好的 [1,3,384,384] float32 张量；
 *   - 执行编码器前向 + 逐 token 的贪心解码；
 *   - 把 token ids 返回主线程（LaTeX 文本在主线程由纯 JS BPE 解码器生成）。
 *
 * 为什么必须放在 Worker：
 *   Zotero 10 的 UI 运行在 Firefox 主线程。WASM 推理和 30MB 模型的初始化
 *   如果放在主线程会冻结阅读器、输入框和笔记编辑器；放到 Worker 后，
 *   主线程只负责图像捕获、消息通信与笔记写入。
 *
 * 重要约束：
 *   - Worker 的脚本地址是 chrome://zotero-texlink/content/scripts/worker.js，
 *     因此相对路径的模型与 ORT 文件都从同一个 XPI 内部读取，全程离线。
 *   - 不包含任何 fetch/XHR 到外部服务器的代码。readBinary() 只允许读取
 *     chrome:// 内部资源。
 */

/* global ort */

"use strict";

// 从 Worker 自身 URL 推导资源根目录，避免把 XPI 的 jar: 路径硬编码。
const WORKER_URL = self.location.href;
const CONTENT_BASE = new URL("../", WORKER_URL).href; // chrome://.../content/

let ortReady = false;
let modelReady = false;
let encoderSession = null;
let decoderSession = null;
let modelConfig = null;
let initPromise = null;

/**
 * 从 chrome:// 读取二进制。
 *
 * 这里优先使用 XMLHttpRequest 而不是 fetch：
 * - Firefox 对 chrome:// 这类本地协议在 fetch 中有时会返回 opaque response；
 * - XHR 在特权 Worker 中读取 chrome:// 的兼容性更稳定。
 * 状态码 0 对本地资源是正常的（没有 HTTP 状态行）。
 */
function readBinary(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = async () => {
      const ok = (xhr.status >= 200 && xhr.status < 300) || xhr.status === 0;
      if (ok && xhr.response && xhr.response.byteLength) {
        resolve(xhr.response);
        return;
      }
      // 某些 Firefox 构建中 XHR 对 chrome:// 支持不一致，再尝试一次 fetch。
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        resolve(await response.arrayBuffer());
      }
      catch (error) {
        reject(new Error(`无法读取内部资源（${xhr.status}）：${url} / ${error.message}`));
      }
    };
    xhr.onerror = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        resolve(await response.arrayBuffer());
      }
      catch (error) {
        reject(new Error(`读取内部资源失败：${url} / ${error.message}`));
      }
    };
    xhr.send(null);
  });
}

/** 统一向主线程发送消息。 */
function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

/** 只把安全的错误字符串回传，避免 structured clone 序列化 Error 失败。 */
function serializeError(error) {
  return {
    message: String(error?.message || error || "未知错误"),
    stack: String(error?.stack || "")
  };
}

/**
 * 加载 ORT、WASM 与 ONNX 模型。
 *
 * @param {object} message
 *   - config: texlink-model.json 的内容
 *   - modelBase: chrome://zotero-texlink/content/models/
 *   - ortBase: chrome://zotero-texlink/content/vendor/ort/
 *   - model: { encoder, decoder } 文件名
 */
async function initModel(message) {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    modelConfig = message.config;
    const modelBase = message.modelBase;
    const ortBase = message.ortBase;

    post("progress", { phase: "ort", text: "正在初始化离线推理引擎…" });

    // 经典 Worker 中 importScripts 是同步的；UMD 版本会挂载全局 ort。
    importScripts(ortBase + "ort.min.js");
    if (typeof ort === "undefined") {
      throw new Error("onnxruntime-web 未正确加载");
    }

    /*
     * 关键配置（这里固定使用 onnxruntime-web 1.17.3）：
     * - numThreads=1：单线程，不创建 pthread worker，也不需要 SharedArrayBuffer。
     *   Zotero 的 chrome:// Worker 不一定处于 cross-origin isolated 环境，
     *   这是比“多线程后退化为单线程”更稳妥的选择。
     * - proxy=false：当前 Worker 本身就是后台线程，不需要 ORT 再开代理 Worker。
     * - wasmPaths 用对象映射到 Blob URL：我们先读取打包的
     *   ort-wasm-simd.wasm，再交给 Emscripten 加载，避免直接 fetch chrome://
     *   在不同 Firefox 构建上的兼容性差异。
     * - 本版本不包含 .mjs 胶水文件，也不需要动态 import。
     */
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = "error";

    let wasmBinary = await readBinary(ortBase + "ort-wasm-simd.wasm");
    let wasmObjectURL = null;
    try {
      wasmObjectURL = URL.createObjectURL(
        new Blob([wasmBinary], { type: "application/wasm" })
      );
      ort.env.wasm.wasmPaths = {
        "ort-wasm-simd.wasm": wasmObjectURL
      };
    }
    catch (error) {
      // 极少数环境不允许 Worker 内创建 Blob URL；退回同目录路径。
      ort.env.wasm.wasmPaths = ortBase;
    }
    wasmBinary = null;

    post("progress", { phase: "encoder", text: "正在加载公式识别模型（编码器）…" });
    const encoderBuffer = await readBinary(modelBase + message.model.encoder);

    post("progress", { phase: "decoder", text: "正在加载公式识别模型（解码器）…" });
    const decoderBuffer = await readBinary(modelBase + message.model.decoder);

    const sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      logSeverityLevel: 3
    };

    /*
     * 注意：InferenceSession.create 接受 ArrayBuffer，不需要把模型转成 Base64，
     * 也不会把模型内容发到任何服务器。
     */
    encoderSession = await ort.InferenceSession.create(encoderBuffer, sessionOptions);
    decoderSession = await ort.InferenceSession.create(decoderBuffer, sessionOptions);

    ortReady = true;
    modelReady = true;
    // wasmObjectURL 故意不 revoke：Session 在后续推理中仍可能按需读取模块。
    void wasmObjectURL;
    post("ready", {
      requestId: message.requestId,
      model: modelConfig.id,
      input: modelConfig.input,
      vocabSize: modelConfig.decoder.vocabSize
    });
  })();

  try {
    await initPromise;
  }
  catch (error) {
    initPromise = null;
    ortReady = false;
    modelReady = false;
    throw error;
  }
}

/**
 * 预热：用全零图像跑一次编码器和一次解码。
 * 目的不是产生有用结果，而是让 WASM 完成编译、内存分配和首轮内核查找。
 */
async function warmup() {
  if (!modelReady) {
    throw new Error("模型尚未加载");
  }
  const input = modelConfig.input;
  const size = input.channels * input.height * input.width;
  const zeros = new Float32Array(size);
  const tensor = new ort.Tensor("float32", zeros, [
    1,
    input.channels,
    input.height,
    input.width
  ]);
  const feeds = {};
  feeds[input.name] = tensor;
  const encoderOutputs = await encoderSession.run(feeds);
  const hidden = getEncoderHidden(encoderOutputs);
  await runDecoderStep(hidden, [modelConfig.decoder.startTokenId]);
}

/** 从编码器输出对象中取 hidden state，兼容不同的导出命名。 */
function getEncoderHidden(outputs) {
  const preferred = modelConfig.encoderOutput;
  if (preferred && outputs[preferred]) {
    return outputs[preferred];
  }
  const first = Object.values(outputs)[0];
  if (!first) {
    throw new Error("编码器没有返回输出");
  }
  return first;
}

/**
 * 执行一步解码，返回 logits 张量。
 *
 * 当前导出的是不带 KV cache 的 decoder（use_cache=False）。
 * 每一步都把完整 prefix 重新送进 decoder；V0.1 优先保证导出简单、
 * 结果确定，公式通常只有几十个 token，浏览器端仍可接受。
 */
async function runDecoderStep(hidden, ids) {
  const idsArray = BigInt64Array.from(ids.map((id) => BigInt(id)));
  const inputIds = new ort.Tensor("int64", idsArray, [1, ids.length]);
  const feeds = {};
  feeds[modelConfig.decoder.inputIds] = inputIds;
  feeds[modelConfig.decoder.encoderHiddenStates] = hidden;
  const outputs = await decoderSession.run(feeds);
  const logitsName = modelConfig.decoder.logits;
  const logits = logitsName && outputs[logitsName]
    ? outputs[logitsName]
    : Object.values(outputs)[0];
  if (!logits) {
    throw new Error("解码器没有返回 logits");
  }
  return logits;
}

/**
 * 贪心解码。
 *
 * 不使用采样/beam search：
 * - 专用小模型 + 贪心解码保证同样输入得到同样输出；
 * - 无随机性，符合“无 LLM 幻觉、结果确定”的产品约束。
 */
async function recognize(message) {
  if (!modelReady) {
    throw new Error("模型尚未加载，无法识别");
  }

  const decoderCfg = modelConfig.decoder;
  const maxNewTokens = Math.max(
    1,
    Math.min(
      Number(message.maxNewTokens) || decoderCfg.maxNewTokens || 384,
      Number(decoderCfg.maxNewTokens) || 512,
      512
    )
  );

  const startedAt = Date.now();
  const input = modelConfig.input;
  const inputArray = new Float32Array(message.tensor);
  const expectedLength = input.channels * input.height * input.width;
  if (inputArray.length !== expectedLength) {
    throw new Error(
      `输入张量长度错误：期望 ${expectedLength}，实际 ${inputArray.length}`
    );
  }

  const tensor = new ort.Tensor("float32", inputArray, [
    1,
    input.channels,
    input.height,
    input.width
  ]);
  const encoderFeeds = {};
  encoderFeeds[input.name] = tensor;
  const encoderOutputs = await encoderSession.run(encoderFeeds);
  const hidden = getEncoderHidden(encoderOutputs);

  const ids = [decoderCfg.startTokenId];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let ended = false;

  for (let step = 0; step < maxNewTokens; step++) {
    const logits = await runDecoderStep(hidden, ids);
    const dims = logits.dims || [];
    const vocabSize = dims[dims.length - 1] || decoderCfg.vocabSize;
    const data = logits.data;
    // 取“预测下一个 token”的那一行 logits（最后一个时间步）。
    const offset = (ids.length - 1) * vocabSize;

    let bestId = 0;
    let bestScore = -Infinity;
    for (let v = 0; v < vocabSize; v++) {
      const score = data[offset + v];
      if (score > bestScore) {
        bestScore = score;
        bestId = v;
      }
    }

    // softmax 后取选中 token 的概率，作为粗糙的置信度提示。
    let expSum = 0;
    for (let v = 0; v < vocabSize; v++) {
      expSum += Math.exp(data[offset + v] - bestScore);
    }
    if (expSum > 0) {
      confidenceSum += 1 / expSum;
      confidenceCount++;
    }

    ids.push(bestId);

    if (bestId === decoderCfg.eosTokenId) {
      ended = true;
      break;
    }

    if (step > 0 && step % 8 === 0) {
      post("progress", {
        requestId: message.requestId,
        phase: "decode",
        step,
        maxNewTokens,
        text: `正在解码公式（${step}/${maxNewTokens}）…`
      });
    }
  }

  // 去掉开头的 decoder_start_token；若以 eos 结束，也去掉结尾 eos。
  let outputIds = ids.slice(1);
  if (ended && outputIds[outputIds.length - 1] === decoderCfg.eosTokenId) {
    outputIds = outputIds.slice(0, -1);
  }

  post("result", {
    requestId: message.requestId,
    tokenIds: outputIds,
    steps: outputIds.length,
    ended,
    confidence: confidenceCount ? confidenceSum / confidenceCount : 0,
    elapsedMs: Date.now() - startedAt
  });
}

/**
 * Worker 消息分发。
 * 所有异步异常都必须回传，否则主线程的 Promise 会一直等待。
 */
/**
 * Worker 消息即使处理函数是 async，浏览器也不会自动串行等待。
 * 用一个 Promise 链把 init / warmup / recognize 串起来，避免两个推理
 * 同时使用同一个 ORT Session，导致内存峰值或消息交错。
 */
let workChain = Promise.resolve();

async function handleMessage(message) {
  try {
    switch (message.type) {
      case "init":
        await initModel(message);
        break;

      case "warmup":
        await warmup();
        post("warmup-done", { requestId: message.requestId });
        break;

      case "recognize":
        await recognize(message);
        break;

      default:
        throw new Error(`未知的 Worker 消息类型：${message.type}`);
    }
  }
  catch (error) {
    // 初始化失败也属于“不可恢复”状态；主线程会提示用户。
    post("error", {
      requestId: message.requestId,
      phase: message.type,
      error: serializeError(error)
    });
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  workChain = workChain.then(() => handleMessage(message));
};

// 未捕获的 Promise 拒绝也回传，便于主线程显示可操作的错误。
self.addEventListener("unhandledrejection", (event) => {
  post("error", {
    phase: "unhandledrejection",
    error: serializeError(event.reason)
  });
});

// 启动后立即告诉主线程 Worker 脚本已经可通信（模型仍未加载）。
post("boot");
