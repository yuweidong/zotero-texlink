/*
 * TexLink Web Worker
 * ==================
 *
 * Responsibilities:
 *   - load onnxruntime-web in a worker thread;
 *   - load the INT8 Pix2Text-MFR encoder and decoder;
 *   - receive a preprocessed [1, 3, 384, 384] float32 tensor from the UI;
 *   - run the encoder and greedy per-token decoding;
 *   - return token ids to the UI, which performs pure-JS BPE decoding.
 *
 * Why a Worker:
 *   Zotero 10's UI runs on Firefox's main thread. Loading a 30 MB model and
 *   running WASM inference there would freeze the reader, text fields, and note
 *   editor. The UI retains only image capture, messaging, and note writing.
 *
 * Offline constraints:
 *   - The worker script itself is loaded from
 *     chrome://zotero-texlink/content/scripts/worker.js, so relative model and
 *     ORT resources stay inside the same XPI.
 *   - There is no code that fetches from an external server. readBinary() may
 *     read only chrome:// resources.
 */

/* global ort */

"use strict";

// Derive the content root from the Worker URL instead of hard-coding a jar: path.
const WORKER_URL = self.location.href;
const CONTENT_BASE = new URL("../", WORKER_URL).href; // chrome://.../content/

let ortReady = false;
let modelReady = false;
let encoderSession = null;
let decoderSession = null;
let modelConfig = null;
let initPromise = null;

/**
 * Read a binary resource from chrome://.
 *
 * XMLHttpRequest is tried first:
 * - fetch can return an opaque response for local chrome:// resources in some
 *   Firefox builds;
 * - XHR is more consistent in a privileged worker.
 * A status code of 0 is normal for local resources without an HTTP status line.
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
      // XHR support for chrome:// varies across Firefox builds; try fetch once.
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        resolve(await response.arrayBuffer());
      }
      catch (error) {
        reject(new Error(`Unable to read internal resource (${xhr.status}): ${url} / ${error.message}`));
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
        reject(new Error(`Failed to read internal resource: ${url} / ${error.message}`));
      }
    };
    xhr.send(null);
  });
}

/** Send a structured message to the UI thread. */
function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

/** Return plain error data so structured clone never has to serialize Error. */
function serializeError(error) {
  return {
    message: String(error?.message || error || "Unknown error"),
    stack: String(error?.stack || "")
  };
}

/**
 * Load ORT, WASM, and the ONNX models.
 *
 * @param {object} message
 *   - config: contents of texlink-model.json
 *   - modelBase: chrome://zotero-texlink/content/models/
 *   - ortBase: chrome://zotero-texlink/content/vendor/ort/
 *   - model: { encoder, decoder } file names
 */
async function initModel(message) {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    modelConfig = message.config;
    const modelBase = message.modelBase;
    const ortBase = message.ortBase;

    post("progress", { phase: "ort", text: "Initializing the offline inference engine..." });

    // importScripts is synchronous in a classic worker; the UMD build exposes global ort.
    importScripts(ortBase + "ort.min.js");
    if (typeof ort === "undefined") {
      throw new Error("onnxruntime-web did not load correctly");
    }

    /*
     * Configuration (onnxruntime-web 1.17.3 is pinned):
     * - numThreads=1: no pthread workers and no SharedArrayBuffer dependency.
     *   Zotero chrome:// workers are not necessarily cross-origin isolated, so
     *   this is safer than relying on runtime thread fallback.
     * - proxy=false: this worker is already a background thread; ORT does not
     *   need another proxy worker.
     * - wasmPaths maps to a Blob URL. The packaged ort-wasm-simd.wasm is read
     *   first and handed to Emscripten, avoiding direct chrome:// fetch
     *   differences across Firefox builds.
     * - This ORT build has no .mjs glue file and needs no dynamic import.
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
      // A few environments disallow Blob URLs in a worker; fall back to the directory path.
      ort.env.wasm.wasmPaths = ortBase;
    }
    wasmBinary = null;

    post("progress", { phase: "encoder", text: "Loading formula model (encoder)..." });
    const encoderBuffer = await readBinary(modelBase + message.model.encoder);

    post("progress", { phase: "decoder", text: "Loading formula model (decoder)..." });
    const decoderBuffer = await readBinary(modelBase + message.model.decoder);

    const sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      logSeverityLevel: 3
    };

    /*
     * InferenceSession.create accepts an ArrayBuffer directly. The model is
     * never converted to Base64 and never leaves this process.
     */
    encoderSession = await ort.InferenceSession.create(encoderBuffer, sessionOptions);
    decoderSession = await ort.InferenceSession.create(decoderBuffer, sessionOptions);

    ortReady = true;
    modelReady = true;
    // wasmObjectURL is intentionally not revoked; ORT may need the module later.
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
 * Warm up with a zero image and a one-token decode. This is not expected to
 * produce a useful result; it compiles WASM, allocates memory, and warms the
 * first kernel lookups.
 */
async function warmup() {
  if (!modelReady) {
    throw new Error("Model is not loaded");
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

/** Get the hidden state from encoder output, tolerating different export names. */
function getEncoderHidden(outputs) {
  const preferred = modelConfig.encoderOutput;
  if (preferred && outputs[preferred]) {
    return outputs[preferred];
  }
  const first = Object.values(outputs)[0];
  if (!first) {
    throw new Error("Encoder returned no output");
  }
  return first;
}

/**
 * Run one decoder step and return the logits tensor.
 *
 * The exported decoder does not use a KV cache (use_cache=False). Each step
 * re-runs the full prefix. This keeps the export simple and deterministic;
 * formulas are usually only tens of tokens long, so the cost is acceptable.
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
    throw new Error("Decoder returned no logits");
  }
  return logits;
}

/**
 * Greedy decoding.
 *
 * No sampling and no beam search:
 * - a task-specific model plus argmax yields the same output for the same input;
 * - no randomness, enforcing the deterministic, no-LLM-hallucination contract.
 */
async function recognize(message) {
  if (!modelReady) {
    throw new Error("Model is not loaded; recognition is unavailable");
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
      `Invalid input tensor length: expected ${expectedLength}, got ${inputArray.length}`
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
    // Select the row that predicts the next token (the last time step).
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

    // Convert the selected logit to a coarse softmax confidence.
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
        text: `Decoding formula (${step}/${maxNewTokens})...`
      });
    }
  }

  // Drop the leading decoder_start_token and a trailing EOS if present.
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
 * Worker message dispatch.
 * Every asynchronous error must be reported or the UI Promise never settles.
 */
/**
 * The browser does not await an async onmessage handler. Chain init, warmup,
 * and recognize through a Promise queue so two inferences never share an ORT
 * session concurrently and messages cannot interleave.
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
        throw new Error(`Unknown worker message type: ${message.type}`);
    }
  }
  catch (error) {
    // Initialization failures are unrecoverable; the UI reports them.
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

// Report unhandled promise rejections so the UI can show an actionable error.
self.addEventListener("unhandledrejection", (event) => {
  post("error", {
    phase: "unhandledrejection",
    error: serializeError(event.reason)
  });
});

// Notify the UI that the worker script is reachable (models are not loaded yet).
post("boot");
