/*
 * TexLink core service
 * ====================
 *
 * bootstrap.js loads this file into the plugin's own Chrome sandbox via
 * Services.scriptloader.loadSubScript. There are no build-time dependencies;
 * all runtime logic runs inside Zotero 10:
 *
 *   Native image annotation (screenshot)
 *        -> Zotero.Annotations.toJSON() reads the local image cache
 *        -> Canvas scaling/normalization (main thread, images are tiny)
 *        -> Web Worker + onnxruntime-web + INT8 ONNX inference
 *        -> Pure-JS BPE decoding to LaTeX
 *        -> Zotero.Item (note) receives an HTML block with page label,
 *           timestamp, source, and a native KaTeX preview
 *
 * Key design notes (see README and docs):
 * 1. Zotero 10 has no Zotero.Notes.create() API. Notes are created with
 *    new Zotero.Item("note") + setNote() + saveTx().
 * 2. The Zotero 10 note editor natively supports KaTeX math nodes:
 *    block formulas use <pre class="math">$$...$$</pre>,
 *    inline formulas use <span class="math">$...$</span>.
 *    Injecting MathJax <script> into notes is unnecessary and undesirable.
 * 3. Input uses Zotero's own "area image annotation" as the screenshot event,
 *    so Zotero supplies the page label, attachment, and annotation key, and we
 *    avoid parsing PDF coordinates ourselves.
 *    A Notifier listener can auto-process new screenshots when enabled.
 * 4. A few Zotero.Reader internals (_readers/_iframeWindow/_primaryView/
 *    _state.selectedAnnotationIDs) are guarded for existence. If a future
 *    Zotero version changes them, the "Recognize Selected Formula Screenshot"
 *    menu item still works, but the annotation must be reselected in the PDF.
 */

"use strict";

var TexLinkService = (function () {
  const PLUGIN_ID = "zotero-texlink@yuweidong.dev";
  const PREF_PREFIX = "extensions.zotero.texlink";
  const CHROME_NAME = "zotero-texlink";
  const LOG_PREFIX = "[TexLink]";
  const WORKER_INIT_TIMEOUT = 180000;
  const WORKER_RECOGNITION_TIMEOUT = 180000;
  const WORKER_WARMUP_TIMEOUT = 120000;
  const NOTE_SCHEMA_VERSION = 9;
  const DEFAULT_LOG_TAG = "texlink-formula-log";
  const DEFAULT_LOG_TITLE = "TexLink Formula Notes";

  // Default template used internally by the service. prefs.js also keeps a
  // user-editable copy; if that copy is cleared or broken, fall back here so
  // essential fields are never lost.
  const DEFAULT_NOTE_TEMPLATE = [
    '<blockquote data-texlink-entry="{{id}}" data-texlink-annotation="{{annotationKey}}">',
    '  <h3>TexLink formula anchor</h3>',
    '  <pre class="math">$${{latexRaw}}$$</pre>',
    '  <p><strong>Page:</strong> {{pageLabel}} | <strong>Extracted:</strong> {{timestamp}}</p>',
    '  <p><strong>Source:</strong> {{sourceTitle}} | <a href="{{pdfLink}}">Open in PDF</a> | <a href="{{itemLink}}">View item</a></p>',
    '  {{commentBlock}}',
    '  <p><strong>LaTeX source:</strong></p>',
    '  <pre>{{latexRaw}}</pre>',
    '</blockquote>'
  ].join("\n");

  /**
   * ByteLevel BPE decoder.
   *
   * Pix2Text-MFR's tokenizer.json uses the HuggingFace tokenizers BPE layout:
   *   model.vocab: token -> id
   *   decoder.type: ByteLevel
   *
   * The point of ByteLevel is not simple token concatenation: GPT-2-style
   * token strings map bytes to printable Unicode (e.g. space -> "Ġ"). The
   * correct approach is:
   *   1. Map every character of every token back to its original byte.
   *   2. Concatenate all bytes into one contiguous Uint8Array.
   *   3. Decode the whole buffer as UTF-8.
   *
   * Never UTF-8 decode individual tokens: a multi-byte character or math
   * symbol may be split across adjacent tokens, and per-token decoding would
   * produce U+FFFD replacement characters.
   */
  class TexLinkBPEDecoder {
    constructor(tokenizerJSON) {
      if (!tokenizerJSON || typeof tokenizerJSON !== "object") {
        throw new Error("Invalid tokenizer.json format");
      }
      this._json = tokenizerJSON;
      this._vocab = tokenizerJSON.model?.vocab || {};
      this._idToToken = new Map();
      for (const [token, id] of Object.entries(this._vocab)) {
        this._idToToken.set(Number(id), token);
      }

      this._added = new Map();
      this._specialIds = new Set();
      for (const added of tokenizerJSON.added_tokens || []) {
        const id = Number(added.id);
        this._added.set(id, String(added.content));
        if (added.special) {
          this._specialIds.add(id);
        }
        if (!this._idToToken.has(id)) {
          this._idToToken.set(id, String(added.content));
        }
      }

      this._byteMap = this._buildByteMap();
      this._decoderType = this._detectDecoderType(tokenizerJSON.decoder);
      this._encoder = new TextEncoder();
      this._decoder = new TextDecoder("utf-8", { fatal: false });
    }

    /** Build the GPT-2 ByteLevel Unicode character -> byte mapping. */
    _buildByteMap() {
      const bytes = [];
      for (let i = 33; i <= 126; i++) bytes.push(i);
      for (let i = 161; i <= 172; i++) bytes.push(i);
      for (let i = 174; i <= 255; i++) bytes.push(i);

      const chars = bytes.slice();
      let next = 0;
      for (let b = 0; b < 256; b++) {
        if (!bytes.includes(b)) {
          bytes.push(b);
          chars.push(256 + next);
          next++;
        }
      }

      const map = new Map();
      for (let i = 0; i < bytes.length; i++) {
        map.set(String.fromCharCode(chars[i]), bytes[i]);
      }
      return map;
    }

    /** Recursively detect whether the decoder chain contains ByteLevel. */
    _detectDecoderType(decoder) {
      if (!decoder) return "bytelevel";
      const type = String(decoder.type || "").toLowerCase();
      if (type === "sequence") {
        const types = (decoder.decoders || [])
          .map((item) => this._detectDecoderType(item))
          .join(",");
        if (types.includes("bytelevel")) return "bytelevel";
        return "sentencepiece";
      }
      if (type.includes("bytelevel")) return "bytelevel";
      if (type.includes("metaspace") || type.includes("wordpiece")) {
        return "sentencepiece";
      }
      return "bytelevel";
    }

    /** Skip special tokens and return the text tokens. */
    _tokenTexts(ids) {
      const texts = [];
      for (const rawId of ids || []) {
        const id = Number(rawId);
        if (!Number.isFinite(id) || this._specialIds.has(id)) continue;
        const token = this._added.has(id)
          ? this._added.get(id)
          : this._idToToken.get(id);
        if (typeof token === "string" && token.length) {
          texts.push(token);
        }
      }
      return texts;
    }

    /**
     * ByteLevel decoding.
     * @param {number[]} ids
     * @returns {string}
     */
    decode(ids) {
      const tokenTexts = this._tokenTexts(ids);
      if (!tokenTexts.length) return "";

      const bytes = [];
      const pushUTF8 = (str) => {
        const encoded = this._encoder.encode(str);
        for (const b of encoded) bytes.push(b);
      };

      if (this._decoderType === "bytelevel") {
        for (const token of tokenTexts) {
          // Handle byte fallback markers such as <0xAB> that may remain in the tokenizer.
          if (/^<0x[0-9a-fA-F]{2}>$/.test(token)) {
            bytes.push(parseInt(token.slice(3, 5), 16));
            continue;
          }
          for (const ch of token) {
            const byte = this._byteMap.get(ch);
            if (byte === undefined) {
              // Rare added token / non-ByteLevel character: write it back as UTF-8.
              pushUTF8(ch);
            }
            else {
              bytes.push(byte);
            }
          }
        }
        return this._postProcess(this._decoder.decode(Uint8Array.from(bytes)));
      }

      // Common cases for SentencePiece / Metaspace / WordPiece:
      // not used by the default model, but kept as an extension point for
      // other tokenizers such as UniMERNet.
      for (const token of tokenTexts) {
        if (/^<0x[0-9a-fA-F]{2}>$/.test(token)) {
          bytes.push(parseInt(token.slice(3, 5), 16));
          continue;
        }
        const normalized = token
          .replace(/\u2581/g, " ")
          .replace(/^##/, "");
        pushUTF8(normalized);
      }
      return this._postProcess(this._decoder.decode(Uint8Array.from(bytes)));
    }

    /**
     * Apply only deterministic cleanup that cannot change LaTeX semantics:
     * - strip BOM/control characters;
     * - strip Markdown code fences the model occasionally emits;
     * - strip outer $ / $$ wrappers (the math node adds its own);
     * - collapse newlines and trim leading/trailing whitespace.
     *
     * No speculative operations such as "auto-close brackets" or
     * "rewrite commands".
     */
    _postProcess(text) {
      let output = String(text || "")
        .replace(/^\uFEFF/, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/\r\n?/g, "\n")
        .trim();

      // Defensive handling: if the model returns ```latex ... ```, strip only the fences.
      output = output
        .replace(/^```(?:latex|tex)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (output.length > 4 && output.startsWith("$$") && output.endsWith("$$")) {
        output = output.slice(2, -2).trim();
      }
      else if (output.length > 2 && output.startsWith("$") && output.endsWith("$")) {
        output = output.slice(1, -1).trim();
      }

      // Collapse consecutive newlines into spaces only; leave ordinary spaces
      // untouched so \text{...} is not corrupted.
      output = output.replace(/\n+/g, " ").trim();
      return output;
    }
  }

  class Service {
    constructor(options = {}) {
      this.id = options.id || PLUGIN_ID;
      this.version = options.version || "0.1.3";
      this.rootURI = options.rootURI || "";
      this.chromeBase = options.chromeBase || `chrome://${CHROME_NAME}/content/`;

      this._started = false;
      this._destroyed = false;
      this._busy = false;

      this._modelConfig = null;
      this._tokenizer = null;
      this._modelError = null;
      this._modelReady = false;
      this._modelInitPromise = null;

      this._worker = null;
      this._workerBooted = false;
      this._pending = new Map();
      this._requestSeq = 0;
      this._activeProgress = null;
      this._toasts = new Set();
      this._diagQueue = Promise.resolve();
      this._diagSeq = 0;

      // Main window -> cleanup callbacks. A Map (not WeakMap) so shutdown can iterate.
      this._windowCleanups = new Map();

      // PDF iframe window -> { reader, handler }
      this._boundReaderWindows = new Map();

      this._readerPollTimer = null;
      this._readerBindTimers = new Set();
      this._readerRetriesScheduled = new WeakSet();
      this._warmupTimer = null;
      this._notifierID = null;
      this._readerContextMenuHandler = null;
      this._autoQueue = Promise.resolve();
    }

    // ===================== Lifecycle =====================

    async startup() {
      if (this._started) return;
      this._started = true;

      // Wait for the main window UI; otherwise Zotero.Reader and ZoteroContextPane may be unavailable.
      await Zotero.uiReadyPromise;

      if (!this._getPref("enabled", true)) {
        this._log("disabled by preference");
        return;
      }
      this._diag("service-startup", `${this.id} ${this.version}`);

      // Load model metadata and the tokenizer first. Even if model resources
      // are damaged, installation/startup is not blocked; a clear error is
      // shown when the user triggers recognition.
      try {
        this._modelConfig = await this._readJSON(
          `${this.chromeBase}models/texlink-model.json`
        );
        const tokenizerJSON = await this._readJSON(
          `${this.chromeBase}models/${this._modelConfig.files.tokenizer}`
        );
        this._tokenizer = new TexLinkBPEDecoder(tokenizerJSON);
        this._log(`model metadata loaded: ${this._modelConfig.displayName}`);
        this._diag("model-metadata-loaded", this._modelConfig.id);
      }
      catch (error) {
        this._modelError = error;
        this._logError("Failed to load model metadata/tokenizer", error);
      }

      // Create only the Worker shell; ORT and ONNX are actually loaded in _ensureModelLoaded().
      try {
        this._createWorker();
      }
      catch (error) {
        this._modelError = this._modelError || error;
        this._logError("Failed to create ONNX Worker", error);
      }

      this._registerReaderContextMenu();
      this._registerNotifier();

      // When the plugin is enabled in an existing window, Zotero may not send
      // onMainWindowLoad again. Iterate proactively once; bootstrap's window
      // callback deduplicates.
      for (const win of Zotero.getMainWindows()) {
        await this.onMainWindowLoad(win);
      }

      // Low-frequency fallback polling: Zotero 10 exposes no public
      // "reader created" callback, so newly opened PDFs still get shortcuts
      // even if an internal event is missed.
      this._readerPollTimer = setInterval(() => {
        if (!this._destroyed) this._bindAllReaders();
      }, 4000);

      // Model warmup. Enabled by default: ORT/ONNX load inside the Worker
      // without blocking the UI.
      if (this._getPref("warmupOnStartup", true)) {
        this._warmupTimer = setTimeout(() => {
          this._warmupTimer = null;
          if (this._destroyed) return;
          this._log("warming up model in background");
          this._ensureModelLoaded(null)
            .then(() => this._workerRequest("warmup", {}, [], WORKER_WARMUP_TIMEOUT))
            .then(() => this._log("model warmup complete"))
            .catch((error) => this._logError("Model warmup failed", error));
        }, 2500);
      }
    }

    async onMainWindowLoad(win) {
      if (this._destroyed || !win || this._windowCleanups.has(win)) {
        return;
      }

      const cleanups = [];
      this._installToolsMenu(win, cleanups);
      this._installMainShortcut(win, cleanups);
      this._windowCleanups.set(win, () => {
        for (const cleanup of cleanups.splice(0)) {
          try { cleanup(); } catch (error) { this._logError("window cleanup failed", error); }
        }
      });

      // Try to bind existing readers whenever a main window appears.
      this._bindAllReaders();
    }

    onMainWindowUnload(win) {
      const cleanup = this._windowCleanups.get(win);
      if (!cleanup) return;
      this._windowCleanups.delete(win);
      try { cleanup(); } catch (error) { this._logError("onMainWindowUnload cleanup failed", error); }
    }

    async shutdown() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._log("shutting down");

      if (this._readerPollTimer) {
        clearInterval(this._readerPollTimer);
        this._readerPollTimer = null;
      }
      if (this._warmupTimer) {
        clearTimeout(this._warmupTimer);
        this._warmupTimer = null;
      }
      for (const timer of this._readerBindTimers) {
        clearTimeout(timer);
      }
      this._readerBindTimers.clear();

      for (const [win, cleanup] of this._windowCleanups) {
        try { cleanup(); } catch (error) { this._logError("shutdown window cleanup failed", error); }
        try { win.removeEventListener?.("unload", cleanup); } catch (e) { /* noop */ }
      }
      this._windowCleanups.clear();

      this._unbindAllReaderWindows();
      this._clearToasts();

      if (this._notifierID) {
        try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* noop */ }
        this._notifierID = null;
      }

      if (this._readerContextMenuHandler && Zotero.Reader?.unregisterEventListener) {
        try {
          Zotero.Reader.unregisterEventListener(
            "createAnnotationContextMenu",
            this._readerContextMenuHandler
          );
        }
        catch (error) {
          this._logError("Failed to unregister reader context menu", error);
        }
        this._readerContextMenuHandler = null;
      }

      // Reject all pending requests before terminating the Worker, so no
      // Promise on the main thread stays pending forever.
      const error = new Error("TexLink has been shut down");
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timer);
        try { pending.reject(error); } catch (e) { /* noop */ }
      }
      this._pending.clear();

      if (this._worker) {
        try { this._worker.terminate(); } catch (e) { /* noop */ }
        this._worker = null;
      }

      this._workerBooted = false;
      this._modelReady = false;
      this._modelInitPromise = null;
      this._activeProgress = null;
    }

    // ===================== Preferences and logging =====================

    _getPref(key, fallback) {
      try {
        const value = Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true);
        return value === undefined || value === null ? fallback : value;
      }
      catch (error) {
        return fallback;
      }
    }

    _log(message) {
      if (this._getPref("debug", false)) {
        Zotero.debug(`${LOG_PREFIX} ${message}`);
      }
    }

    _logError(message, error) {
      Zotero.logError(`${LOG_PREFIX} ${message}`);
      if (error) Zotero.logError(error);
    }

    _delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Diagnostic log (used for crash investigation).
     *
     * When a crash happens in native code, Zotero's debug output often never
     * reaches disk. Key steps are appended to texlink-crash.log in the temp
     * directory for the next startup or developer inspection.
     * Disabled by default; enable with
     * extensions.zotero.texlink.diagnosticLog=true.
     */
    _diag(step, detail = "") {
      if (!this._getPref("diagnosticLog", false)) return Promise.resolve();
      this._diagQueue = this._diagQueue.then(async () => {
        try {
          const tempDir = (typeof PathUtils !== "undefined" && PathUtils.tempDir) || "/tmp";
          const path = (typeof PathUtils !== "undefined" && PathUtils.join)
            ? PathUtils.join(tempDir, "texlink-crash.log")
            : `${tempDir}/texlink-crash.log`;
          let existing = "";
          try {
            existing = await IOUtils.readUTF8(path);
          }
          catch (e) { /* file does not exist */ }
          if (existing.length > 1024 * 1024) {
            existing = existing.slice(-256 * 1024);
          }
          const seq = ++this._diagSeq;
          const line = `${new Date().toISOString()} #${seq} ${step}` +
            (detail ? ` | ${String(detail).slice(0, 500)}` : "") + "\n";
          await IOUtils.writeUTF8(path, existing + line);
        }
        catch (e) {
          // Diagnostics must never affect recognition.
        }
      }).catch(() => {});
      return this._diagQueue;
    }

    // ===================== Internal resource loading =====================

    /**
     * Read an internal chrome:// text resource. Prefer XHR, fall back to fetch.
     * http(s) URLs are rejected: this is TexLink's hard offline constraint.
     */
    async _readText(url) {
      if (!String(url).startsWith("chrome://")) {
        throw new Error(`Refusing to read non-internal resource: ${url}`);
      }
      try {
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.responseType = "text";
          xhr.onload = () => {
            const ok = (xhr.status >= 200 && xhr.status < 300) || xhr.status === 0;
            if (!ok) {
              reject(new Error(`Failed to read ${url} (HTTP ${xhr.status})`));
              return;
            }
            resolve(String(xhr.responseText ?? xhr.response ?? ""));
          };
          xhr.onerror = () => reject(new Error(`XHR read failed: ${url}`));
          xhr.send(null);
        });
      }
      catch (xhrError) {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.text();
        }
        catch (fetchError) {
          throw new Error(
            `Failed to read internal resource ${url}: ${xhrError.message} / ${fetchError.message}`
          );
        }
      }
    }

    async _readJSON(url) {
      const text = await this._readText(url);
      try {
        return JSON.parse(text);
      }
      catch (error) {
        throw new Error(`Failed to parse JSON at ${url}: ${error.message}`);
      }
    }

    // ===================== Web Worker communication =====================

    _createWorker() {
      if (this._worker) return this._worker;
      if (!String(this.chromeBase).startsWith("chrome://")) {
        throw new Error("chrome:// resource mapping is not registered; cannot start the inference Worker");
      }
      const workerURL = `${this.chromeBase}scripts/worker.js`;
      this._worker = new Worker(workerURL);

      this._worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data || {});
      };
      this._worker.onerror = (event) => {
        const message = event?.message || "Worker script execution failed";
        const error = new Error(message);
        this._modelError = this._modelError || error;
        this._modelReady = false;
        this._rejectAllPending(error);
        this._logError("Worker error", error);
        this._setProgress(this._activeProgress, null, `Inference Worker error: ${message}`, true);
      };
      this._worker.onmessageerror = () => {
        const error = new Error("Failed to deserialize Worker message");
        this._rejectAllPending(error);
        this._logError("Worker message error", error);
      };
      return this._worker;
    }

    _rejectAllPending(error) {
      for (const [requestId, pending] of this._pending) {
        clearTimeout(pending.timer);
        try { pending.reject(error); } catch (e) { /* noop */ }
        this._pending.delete(requestId);
      }
    }

    /**
     * Send a request with a requestId to the Worker and await the matching response.
     *
     * The Float32Array's underlying ArrayBuffer is transferred zero-copy to the
     * Worker; the main thread must not access that buffer afterwards.
     */
    _workerRequest(type, payload, transfer, timeoutMs = WORKER_RECOGNITION_TIMEOUT) {
      if (!this._worker) {
        return Promise.reject(new Error("Inference Worker is not initialized"));
      }
      const requestId = ++this._requestSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this._pending.get(requestId);
          if (!pending) return;
          this._pending.delete(requestId);
          reject(new Error(`Worker request timed out: ${type}`));
        }, timeoutMs);

        this._pending.set(requestId, { resolve, reject, timer });
        try {
          this._worker.postMessage({ type, requestId, ...payload }, transfer || []);
        }
        catch (error) {
          clearTimeout(timer);
          this._pending.delete(requestId);
          reject(error);
        }
      });
    }

    _handleWorkerMessage(message) {
      this._log(`worker message: ${message.type}`);
      switch (message.type) {
        case "boot":
          this._workerBooted = true;
          return;

        case "progress":
          this._onWorkerProgress(message);
          return;

        case "ready":
        case "warmup-done":
        case "result": {
          const pending = this._pending.get(message.requestId);
          if (!pending) return;
          this._pending.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
          return;
        }

        case "error": {
          const error = new Error(message.error?.message || "Worker execution failed");
          error.stack = message.error?.stack || error.stack;
          const pending = this._pending.get(message.requestId);
          if (pending) {
            this._pending.delete(message.requestId);
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          else {
            this._logError("Worker error without request", error);
          }
          return;
        }

        default:
          this._log(`ignored unknown worker message: ${message.type}`);
      }
    }

    _onWorkerProgress(message) {
      if (!this._activeProgress) return;
      let percent = 30;
      if (message.phase === "ort") percent = 20;
      if (message.phase === "encoder") percent = 35;
      if (message.phase === "decoder") percent = 50;
      if (message.phase === "decode" && message.maxNewTokens) {
        percent = Math.min(92, 60 + Math.round((message.step / message.maxNewTokens) * 32));
      }
      this._setProgress(this._activeProgress, percent, message.text || "Processing…");
    }

    /**
     * Ensure the Worker has loaded ORT and both ONNX sessions.
     * Concurrent calls share one promise to avoid loading the 31MB model twice.
     */
    async _ensureModelLoaded(progress) {
      if (this._modelReady) return;
      if (this._modelError) {
        throw new Error(`Model load failed: ${this._modelError.message || this._modelError}`);
      }
      if (!this._modelConfig || !this._tokenizer) {
        throw new Error("Model configuration or tokenizer is not loaded yet");
      }
      if (!this._worker) this._createWorker();

      if (!this._modelInitPromise) {
        this._activeProgress = progress || this._activeProgress;
        this._diag("worker-init-start");
        this._modelInitPromise = this._workerRequest(
          "init",
          {
            config: this._modelConfig,
            modelBase: `${this.chromeBase}models/`,
            ortBase: `${this.chromeBase}vendor/ort/`,
            model: {
              encoder: this._modelConfig.files.encoder,
              decoder: this._modelConfig.files.decoder
            }
          },
          [],
          WORKER_INIT_TIMEOUT
        ).then(() => {
          this._modelReady = true;
          this._log("ONNX sessions ready");
          this._diag("worker-init-done");
        }).catch((error) => {
          this._modelError = error;
          this._modelInitPromise = null;
          throw error;
        }).finally(() => {
          this._activeProgress = null;
        });
      }

      await this._modelInitPromise;
    }

    // ===================== Reader menu / shortcut / Notifier =====================

    _registerReaderContextMenu() {
      if (!Zotero.Reader?.registerEventListener) {
        this._log("Zotero.Reader.registerEventListener unavailable");
        return;
      }
      this._readerContextMenuHandler = (event) => {
        try {
          const { reader, params, append } = event;
          const items = this._annotationItemsFromReaderParams(reader, params?.ids || []);
          if (!items.length) return;

          // This API requires append to run synchronously; do not await before append.
          append({
            label: items.length > 1
              ? `TexLink: Recognize ${items.length} Formula Screenshots and Add to Note`
              : "TexLink: Recognize Formula and Add to Note",
            onCommand: () => {
              // Important: do not open a new native progress window inside this
              // native/React menu callback stack. Return control to the menu so
              // it fully closes, then start async recognition.
              this._diag("reader-menu-command", items.map((x) => x.key).join(","));
              setTimeout(() => {
                this._diag("reader-menu-deferred");
                this._recognizeAnnotationItems(items, reader).catch((error) => {
                  this._logError("context menu recognition failed", error);
                  this._showError(error, reader);
                });
              }, 0);
            }
          });
        }
        catch (error) {
          this._logError("createAnnotationContextMenu handler failed", error);
        }
      };
      Zotero.Reader.registerEventListener(
        "createAnnotationContextMenu",
        this._readerContextMenuHandler,
        this.id
      );
      this._log("reader context menu registered");
    }

    /**
     * Resolve annotation items from the Reader's context-menu / selection params.
     * params.ids contains annotation item keys (not database ids).
     */
    _annotationItemsFromReaderParams(reader, ids) {
      const attachment = reader?._item;
      if (!attachment || !Array.isArray(ids)) return [];
      const items = [];
      for (const key of ids) {
        try {
          const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, String(key));
          if (
            item &&
            !item.deleted &&
            item.isAnnotationSupportingImage() &&
            item.parentID === attachment.id
          ) {
            items.push(item);
          }
        }
        catch (error) {
          this._log(`failed to resolve annotation ${key}: ${error.message}`);
        }
      }
      return items;
    }

    /** Get the currently selected image annotations (for the shortcut / Tools menu). */
    _getSelectedImageAnnotations(reader) {
      if (!reader) return [];
      let ids = [];
      try {
        ids = reader._internalReader?._state?.selectedAnnotationIDs || [];
      }
      catch (error) {
        this._log(`could not read selectedAnnotationIDs: ${error.message}`);
      }

      let items = this._annotationItemsFromReaderParams(reader, ids);
      if (items.length) return items;

      // Compatibility: some reader views only expose getSelectedAnnotations().
      try {
        const view = reader._internalReader?._primaryView;
        const selected = view?.getSelectedAnnotations?.();
        if (Array.isArray(selected) && selected.length) {
          const keys = selected.map((a) => a.id || a.key).filter(Boolean);
          items = this._annotationItemsFromReaderParams(reader, keys);
        }
      }
      catch (error) {
        this._log(`getSelectedAnnotations fallback failed: ${error.message}`);
      }
      return items;
    }

    _bindAllReaders() {
      if (this._destroyed) return;
      try {
        const readers = [];
        if (Array.isArray(Zotero.Reader?._readers)) {
          readers.push(...Zotero.Reader._readers);
        }
        else {
          const selectedID = Zotero.getMainWindow()?.Zotero_Tabs?.selectedID;
          const reader = selectedID ? Zotero.Reader?.getByTabID(selectedID) : null;
          if (reader) readers.push(reader);
        }
        for (const reader of readers) {
          this._bindReaderShortcut(reader).catch((error) => {
            this._log(`bind reader shortcut failed: ${error.message}`);
          });
        }
        // Clean up references to destroyed iframes.
        for (const [win, binding] of this._boundReaderWindows) {
          if (!win || win.closed) {
            this._boundReaderWindows.delete(win);
          }
        }
      }
      catch (error) {
        this._log(`_bindAllReaders failed: ${error.message}`);
      }
    }

    /**
     * Attach the shortcut listener to both the reader's outer window and the
     * inner PDF iframe. Two layers are needed because focus usually lives in
     * the PDF.js inner iframe and events do not bubble to the main window.
     */
    async _bindReaderShortcut(reader) {
      if (this._destroyed || !reader) return;
      try {
        if (reader._initPromise) {
          await reader._initPromise;
        }
      }
      catch (error) {
        return;
      }
      if (this._destroyed) return;

      const frames = new Set();
      try {
        frames.add(reader._iframeWindow);
        frames.add(reader._internalReader?._primaryView?._iframeWindow);
        frames.add(reader._internalReader?._secondaryView?._iframeWindow);
        frames.add(reader._internalReader?._primarySDTView?._iframeWindow);
      }
      catch (error) {
        this._log(`reader frames unavailable: ${error.message}`);
      }

      for (const win of frames) {
        if (!win) continue;
        this._bindReaderWindow(win, reader);
      }

      // The PDF view may initialize after the reader shell; retry twice per reader.
      // Note: _bindAllReaders() calls this method every 4 seconds. Without a
      // one-time flag, each retry would schedule two more timers and their
      // count would grow exponentially.
      if (!this._readerRetriesScheduled.has(reader)) {
        this._readerRetriesScheduled.add(reader);
        const retry = (delay) => {
          if (this._destroyed) return;
          const timer = setTimeout(() => {
            this._readerBindTimers.delete(timer);
            if (!this._destroyed) {
              this._bindReaderShortcut(reader).catch((error) => {
                this._log(`reader rebind failed: ${error.message}`);
              });
            }
          }, delay);
          this._readerBindTimers.add(timer);
        };
        retry(800);
        retry(2600);
      }
    }

    _bindReaderWindow(win, reader) {
      if (!win || win.closed || typeof win.addEventListener !== "function") return;
      const existing = this._boundReaderWindows.get(win);
      if (existing && existing.reader === reader) return;
      if (existing) {
        try { win.removeEventListener("keydown", existing.handler, true); } catch (e) { /* noop */ }
      }
      const handler = (event) => this._onReaderKeyDown(event, reader);
      try {
        win.addEventListener("keydown", handler, true);
      }
      catch (error) {
        this._log(`addEventListener failed on reader window: ${error.message}`);
        return;
      }
      this._boundReaderWindows.set(win, { reader, handler });
      this._log("shortcut bound to reader window");
    }

    _unbindAllReaderWindows() {
      for (const [win, binding] of this._boundReaderWindows) {
        try {
          win.removeEventListener("keydown", binding.handler, true);
        }
        catch (error) { /* dead wrapper */ }
      }
      this._boundReaderWindows.clear();
    }

    _installMainShortcut(win, cleanups) {
      const handler = (event) => {
        if (!this._matchesShortcut(event)) return;
        if (this._isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        this.recognizeFromActiveReader().catch((error) => this._showError(error));
      };
      win.addEventListener("keydown", handler, true);
      cleanups.push(() => win.removeEventListener("keydown", handler, true));
    }

    _onReaderKeyDown(event, reader) {
      if (!this._matchesShortcut(event)) return;
      if (this._isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (this._busy) {
        this._showError(new Error("TexLink is still processing the previous formula; please wait."), reader);
        return;
      }
      this.recognizeFromReader(reader).catch((error) => this._showError(error, reader));
    }

    _isEditableTarget(target) {
      try {
        if (!target || typeof target.closest !== "function") return false;
        return !!target.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""], .ProseMirror'
        );
      }
      catch (error) {
        return false;
      }
    }

    /**
     * Parse extensions.zotero.texlink.shortcut.
     * Supports accel / ctrl / control / cmd / command / meta / alt / option / shift,
     * with the final item being the key (e.g. L or KeyL).
     */
    _matchesShortcut(event) {
      if (!event || event.repeat) return false;
      const spec = String(this._getPref("shortcut", "accel,shift,L") || "");
      const parts = spec.split(",").map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return false;
      const keyPart = parts.pop().toLowerCase();

      const expected = { ctrl: false, alt: false, shift: false, meta: false };
      for (const part of parts.map((p) => p.toLowerCase())) {
        if (part === "accel") {
          if (Zotero.isMac) expected.meta = true;
          else expected.ctrl = true;
        }
        else if (part === "ctrl" || part === "control") expected.ctrl = true;
        else if (part === "alt" || part === "option") expected.alt = true;
        else if (part === "shift") expected.shift = true;
        else if (part === "cmd" || part === "command" || part === "meta") expected.meta = true;
      }

      const actual = {
        ctrl: !!event.ctrlKey,
        alt: !!event.altKey,
        shift: !!event.shiftKey,
        meta: !!event.metaKey
      };
      for (const modifier of Object.keys(expected)) {
        if (expected[modifier] !== actual[modifier]) return false;
      }

      const key = String(event.key || "").toLowerCase();
      const code = String(event.code || "").toLowerCase();
      return (
        key === keyPart ||
        code === keyPart ||
        code === `key${keyPart}` ||
        (keyPart.length === 1 && key === keyPart)
      );
    }

    _getActiveReader() {
      try {
        const win = Zotero.getMainWindow();
        const tabs = win?.Zotero_Tabs;
        // Do not hard-depend on selectedType: if the selected tab ID maps to a
        // Reader, assume the user is reading a PDF.
        if (tabs?.selectedID) {
          return Zotero.Reader.getByTabID(tabs.selectedID) || null;
        }
      }
      catch (error) {
        this._log(`getActiveReader failed: ${error.message}`);
      }
      return null;
    }

    _registerNotifier() {
      try {
        this._notifierID = Zotero.Notifier.registerObserver(
          {
            notify: async (event, type, ids) => {
              if (this._destroyed) return;
              if (!this._getPref("autoProcessNewScreenshots", false)) return;
              if (type !== "item" || event !== "add") return;

              const annotations = [];
              for (const id of ids) {
                try {
                  const item = Zotero.Items.get(id);
                  if (
                    item &&
                    !item.deleted &&
                    item.isAnnotationSupportingImage() &&
                    item.annotationType === "image"
                  ) {
                    annotations.push(item);
                  }
                }
                catch (error) {
                  this._log(`notifier annotation lookup failed: ${error.message}`);
                }
              }
              if (!annotations.length) return;

              // Let Zotero finish writing the image cache before reading annotation images.
              this._autoQueue = this._autoQueue
                .then(() => this._delay(600))
                .then(() => this._recognizeAnnotationItems(annotations, null, null, { auto: true }))
                .catch((error) => this._logError("auto screenshot processing failed", error));
            }
          },
          ["item"],
          "texlink-auto-screenshot"
        );
      }
      catch (error) {
        this._logError("Failed to register notifier", error);
      }
    }

    // ===================== Tools menu =====================

    /**
     * Append an item to the end of the Tools menu.
     *
     * Zotero.MenuManager is the more official alternative, but it only accepts
     * l10nID (l10nID -> Fluent .label), while this plugin hardcodes English
     * labels and has zero l10n dependencies. Here we operate directly on
     * Zotero's own XUL DOM and remove only our nodes on window unload, without
     * modifying any existing Zotero nodes.
     */
    _installToolsMenu(win, cleanups) {
      const doc = win?.document;
      const popup = doc?.getElementById("menu_ToolsPopup");
      if (!popup) return;

      // Old nodes may remain after a plugin reload; remove them first.
      doc.getElementById("texlink-tools-separator")?.remove();
      doc.getElementById("texlink-tools-menuitem")?.remove();

      const separator = doc.createXULElement("menuseparator");
      separator.id = "texlink-tools-separator";

      const menuitem = doc.createXULElement("menuitem");
      menuitem.id = "texlink-tools-menuitem";
      menuitem.setAttribute("label", "TexLink: Recognize Selected Formula Screenshot");
      menuitem.setAttribute(
        "tooltiptext",
        "First select a formula with the image annotation tool in the PDF, then click here or use the shortcut."
      );

      const handler = () => {
        this._diag("tools-menu-command");
        setTimeout(() => {
          this._diag("tools-menu-deferred");
          this.recognizeFromActiveReader()
            .catch((error) => this._showError(error, this._getActiveReader()));
        }, 0);
      };
      menuitem.addEventListener("command", handler);
      popup.appendChild(separator);
      popup.appendChild(menuitem);

      cleanups.push(() => {
        try { menuitem.removeEventListener("command", handler); } catch (e) { /* noop */ }
        separator.remove();
        menuitem.remove();
      });
    }

    // ===================== User-triggered entry points =====================

    async recognizeFromActiveReader() {
      const reader = this._getActiveReader();
      if (!reader) {
        this._showError(new Error(
          "Open a PDF and select a formula with the image annotation tool first. TexLink does not read the clipboard or upload images."
        ), null);
        return [];
      }
      return this.recognizeFromReader(reader);
    }

    async recognizeFromReader(reader) {
      if (this._busy) {
        this._showError(new Error("TexLink is still processing the previous formula; please wait."), reader);
        return [];
      }
      const items = this._getSelectedImageAnnotations(reader);
      if (!items.length) {
        this._showError(new Error(
          "No image annotation is selected. Use the image annotation tool in the Zotero PDF reader to select the formula, then select that screenshot and try again."
        ), reader);
        return [];
      }
      return this._recognizeAnnotationItems(items, reader);
    }

    /**
     * Recognize a set of image annotations and write each result as its own blockquote in the note.
     *
     * @param {Zotero.Item[]} annotationItems
     * @param {object|null} reader
     * @param {string|null} comment Optional comment
     * @param {{auto?: boolean}} options
     */
    async _recognizeAnnotationItems(annotationItems, reader, comment = null, options = {}) {
      if (this._destroyed) return [];
      if (!Array.isArray(annotationItems) || !annotationItems.length) return [];
      if (this._busy) {
        if (!options.auto) {
          this._showError(new Error("TexLink is still processing the previous formula; please wait."), reader);
        }
        return [];
      }
      if (!this._modelConfig || !this._tokenizer) {
        this._showError(new Error("Formula model/tokenizer is not loaded, so recognition is unavailable. Reinstall the complete TexLink.xpi."), reader);
        return [];
      }

      this._busy = true;
      await this._diag("pipeline-start", options.auto ? "auto" : "manual");
      // Let the event source (menu/shortcut/Notifier) finish its current event
      // before any UI update.
      await this._delay(60);
      const progress = this._newProgress("Preparing to recognize formula…", reader);
      this._activeProgress = progress;
      const results = [];
      const failures = [];

      try {
        let effectiveComment = comment;
        if (!options.auto && this._getPref("promptForComment", false)) {
          effectiveComment = await this._promptComment();
          if (effectiveComment === null) {
            this._setProgress(progress, 100, "Canceled");
            this._closeProgress(progress, 1000);
            return [];
          }
        }

        this._setProgress(progress, 12, "Loading offline model…");
        await this._diag("model-load-start");
        await this._ensureModelLoaded(progress);
        await this._diag("model-load-end");

        for (let index = 0; index < annotationItems.length; index++) {
          const item = annotationItems[index];
          const prefix = annotationItems.length > 1
            ? `[${index + 1}/${annotationItems.length}] `
            : "";
          try {
            await this._diag("annotation-start", item.key);
            this._setProgress(progress, 60, `${prefix}Reading screenshot and running inference…`);
            const result = await this._recognizeSingle(item, reader, effectiveComment, progress, prefix);
            await this._diag("annotation-done", item.key);
            results.push(result);
          }
          catch (error) {
            failures.push({ item, error });
            this._logError(`recognition failed for annotation ${item?.key}`, error);
          }
        }

        if (results.length) {
          const failureText = failures.length
            ? `, ${failures.length} failed; see Zotero debug output`
            : "";
          this._setProgress(
            progress,
            100,
            `Added ${results.length} formula entries to the Zotero note${failureText}`
          );
          this._closeProgress(progress, failures.length ? 10000 : 5000);
        }
        else {
          const first = failures[0]?.error;
          this._setProgress(
            progress,
            null,
            `Recognition failed: ${first?.message || "unknown error"}`,
            true
          );
          this._closeProgress(progress, 10000);
        }
        return results;
      }
      catch (error) {
        await this._diag("pipeline-error", error.message || String(error));
        this._setProgress(progress, null, `TexLink failed: ${error.message || error}`, true);
        this._closeProgress(progress, 10000);
        this._logError("recognition pipeline failed", error);
        return results;
      }
      finally {
        this._busy = false;
        if (this._activeProgress === progress) this._activeProgress = null;
      }
    }

    // ===================== Single-annotation recognition =====================

    async _recognizeSingle(annotationItem, reader, comment, progress, prefix = "") {
      await this._diag("single-start", annotationItem.key);
      const source = this._buildSourceContext(annotationItem, reader);
      await this._diag("source-built", source.pageLabel);
      await this._diag("image-read-start");
      const image = await this._getAnnotationImage(annotationItem);
      await this._diag("image-read-done", image.length);

      this._setProgress(progress, 64, `${prefix}Preprocessing image…`);
      await this._diag("preprocess-start");
      const tensor = await this._preprocessImage(image);
      await this._diag("preprocess-done", tensor.shape.join("x"));

      this._setProgress(progress, 68, `${prefix}Recognizing formula offline…`);
      // _ensureModelLoaded clears _activeProgress when it finishes; reattach it
      // before inference so Worker decode progress updates the same toast.
      this._activeProgress = progress;
      const maxNewTokens = Number(this._getPref("maxNewTokens", 384)) || 384;
      await this._diag("worker-request-start");
      const workerResult = await this._workerRequest(
        "recognize",
        {
          tensor: tensor.buffer,
          maxNewTokens
        },
        [tensor.buffer],
        WORKER_RECOGNITION_TIMEOUT
      );
      await this._diag("worker-request-done", `${workerResult.steps} steps`);

      const latex = this._tokenizer.decode(workerResult.tokenIds || []);
      if (!latex) {
        throw new Error("The model returned an empty formula; select a clearer formula image and try again");
      }

      const timestamp = new Date().toISOString();
      const entryId = `${annotationItem.key}-${Date.now().toString(36)}`;
      const html = this._renderEntryHTML({
        latex,
        timestamp,
        entryId,
        source,
        comment: comment ? String(comment).slice(0, Number(this._getPref("maxCommentLength", 2000)) || 2000) : "",
        confidence: workerResult.confidence
      });

      this._setProgress(progress, 92, `${prefix}Writing to Zotero note…`);
      await this._diag("note-write-start");
      const noteItem = await this._writeEntryToNote({
        html,
        entryId,
        source,
        timestamp,
        latex
      });

      await this._diag("note-write-done", noteItem.id);
      if (this._getPref("openNoteAfterInsert", false)) {
        try {
          await Zotero.Notes.open(noteItem.id);
        }
        catch (error) {
          this._logError("Failed to open note after insert", error);
        }
      }

      return {
        latex,
        noteItem,
        annotationItem,
        source,
        timestamp,
        confidence: workerResult.confidence,
        elapsedMs: workerResult.elapsedMs
      };
    }

    /**
     * Read the PNG data URL of a native image annotation.
     * Zotero.Annotations.toJSON() encodes the cached annotation image as
     * data:image/png;base64.
     */
    async _getAnnotationImage(annotationItem) {
      if (!annotationItem?.isAnnotationSupportingImage?.()) {
        throw new Error("This annotation is not an image annotation");
      }
      let lastError = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const json = await Zotero.Annotations.toJSON(annotationItem);
          if (json?.image?.startsWith("data:image/")) {
            return json.image;
          }
        }
        catch (error) {
          lastError = error;
        }
        // A new screenshot's cache file may land a few dozen milliseconds after the Notifier event.
        await this._delay(250);
      }
      throw new Error(
        `Could not read the local cache for this screenshot${lastError ? `: ${lastError.message}` : ""}. Make sure the annotation image is synced/saved locally.`
      );
    }

    /**
     * Canvas preprocessing:
     *   - fill transparent backgrounds with white;
     *   - resize to the model's 384 × 384 (matching DeiTImageProcessor resize);
     *   - optional Otsu binarization (off by default);
     *   - RGB normalization: scale to [0,1], then map to [-1,1] with mean=0.5,std=0.5;
     *   - lay out as CHW float32.
     *
     * This runs on the main thread, but it only handles one 384×384 image and
     * takes milliseconds; the real computation happens in the Worker.
     */
    async _preprocessImage(dataURL) {
      const input = this._modelConfig.input;
      const width = Number(input.width) || 384;
      const height = Number(input.height) || 384;
      const channels = Number(input.channels) || 3;
      const mean = Array.isArray(input.mean) ? input.mean : [0.5, 0.5, 0.5];
      const std = Array.isArray(input.std) ? input.std : [0.5, 0.5, 0.5];

      const win = Zotero.getMainWindow() || Services.appShell.hiddenDOMWindow;
      const doc = win?.document;
      if (!doc) throw new Error("Could not obtain the Zotero main window for image preprocessing");

      const image = await new Promise((resolve, reject) => {
        const img = new win.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not decode the annotation image"));
        img.src = dataURL;
      });

      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error("Annotation image has zero dimensions");
      }

      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Could not create a Canvas 2D context");

      // Transparent backgrounds must be filled white; otherwise transparent
      // pixels become [0,0,0] and the model treats blank space as ink.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      try {
        ctx.imageSmoothingQuality = "high";
      }
      catch (error) { /* not supported on some platforms; ignore */ }
      ctx.drawImage(image, 0, 0, width, height);

      const imageData = ctx.getImageData(0, 0, width, height).data;
      const binarize = !!this._getPref("binarize", false);
      if (binarize) {
        this._otsuBinarizeInPlace(imageData);
      }

      const tensor = new Float32Array(channels * height * width);
      const pixelCount = width * height;
      for (let p = 0, offset = 0; p < pixelCount; p++, offset += 4) {
        const r = imageData[offset] / 255;
        const g = imageData[offset + 1] / 255;
        const b = imageData[offset + 2] / 255;
        if (channels === 1) {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          tensor[p] = (gray - mean[0]) / std[0];
        }
        else {
          tensor[p] = (r - mean[0]) / std[0];
          tensor[p + pixelCount] = (g - mean[1]) / std[1];
          tensor[p + 2 * pixelCount] = (b - mean[2]) / std[2];
        }
      }

      return { buffer: tensor.buffer, shape: [1, channels, height, width] };
    }

    /**
     * Pure-JS Otsu threshold binarization (disabled by default).
     * Pixels whose grayscale is at or below the threshold become black; all
     * others become white. Alpha is set to 255.
     */
    _otsuBinarizeInPlace(rgba) {
      const histogram = new Array(256).fill(0);
      const pixelCount = rgba.length / 4;
      for (let i = 0; i < rgba.length; i += 4) {
        const gray = Math.round(
          0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
        );
        histogram[gray]++;
      }

      let total = pixelCount;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * histogram[i];

      let sumB = 0;
      let weightB = 0;
      let maxVariance = -1;
      let threshold = 127;
      for (let t = 0; t < 256; t++) {
        weightB += histogram[t];
        if (!weightB) continue;
        const weightF = total - weightB;
        if (!weightF) break;
        sumB += t * histogram[t];
        const meanB = sumB / weightB;
        const meanF = (sum - sumB) / weightF;
        const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
        if (variance > maxVariance) {
          maxVariance = variance;
          threshold = t;
        }
      }

      for (let i = 0; i < rgba.length; i += 4) {
        const gray = Math.round(
          0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
        );
        const value = gray <= threshold ? 0 : 255;
        rgba[i] = value;
        rgba[i + 1] = value;
        rgba[i + 2] = value;
        rgba[i + 3] = 255;
      }
    }

    // ===================== Note target and writes =====================

    /**
     * Derive the item/attachment/page label/clickable links from an annotation.
     * Prefer annotationPageLabel (which may display as "iv" or "12" in the PDF);
     * if empty, fall back to position.pageIndex + 1 (physical PDF page number).
     */
    _buildSourceContext(annotationItem, reader) {
      const attachment = annotationItem?.parentItem || reader?._item;
      if (!attachment) {
        throw new Error("This annotation has no associated PDF attachment");
      }
      const regularItem = attachment.parentItem || null;
      if (!regularItem) {
        throw new Error(
          "This PDF has no parent item. Add the PDF as an attachment under a bibliographic item first so TexLink can anchor formulas to that item's note."
        );
      }

      let position = {};
      try {
        const rawPosition = annotationItem.annotationPosition;
        position = typeof rawPosition === "string"
          ? JSON.parse(rawPosition || "{}")
          : (rawPosition || {});
      }
      catch (error) {
        position = {};
      }
      const pageIndex = Number.isFinite(Number(position.pageIndex))
        ? Number(position.pageIndex)
        : 0;
      const rawLabel = String(annotationItem.annotationPageLabel || "").trim();
      const pageLabel = rawLabel || `PDF page ${pageIndex + 1}`;

      const library = Zotero.Libraries.get(annotationItem.libraryID);
      const isGroup = library?.libraryType === "group";
      const prefix = isGroup ? `groups/${library.groupID}` : "library";
      const pdfLink = `zotero://open-pdf/${prefix}/items/${attachment.key}` +
        `?page=${pageIndex + 1}&annotation=${annotationItem.key}`;
      const itemLink = `zotero://select/${prefix}/items/${regularItem.key}`;
      const sourceTitle = regularItem.getField("title") || attachment.getField("title") || "Untitled item";

      return {
        attachment,
        regularItem,
        pageIndex,
        pageLabel,
        pdfLink,
        itemLink,
        sourceTitle,
        annotationKey: annotationItem.key
      };
    }

    _escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch]));
    }

    /**
     * Render one standalone formula block.
     * Note that <pre class="math"> is the native math-node syntax of the
     * Zotero 10 note editor and is rendered by its built-in KaTeX; the same
     * LaTeX is also placed in a plain <pre> below as searchable source.
     */
    _renderEntryHTML({ latex, timestamp, entryId, source, comment }) {
      let template = String(this._getPref("noteTemplate", "") || "").trim();
      if (
        !template ||
        !template.includes("{{latexRaw}}") ||
        !template.includes("{{pageLabel}}") ||
        /<\s*(script|iframe|object|embed|link|meta)\b|on[a-z]+\s*=|javascript:/i.test(template)
      ) {
        template = DEFAULT_NOTE_TEMPLATE;
      }

      const escapedLatex = this._escapeHTML(latex);
      const commentBlock = comment
        ? `<p><strong>Comment:</strong> ${this._escapeHTML(comment)}</p>`
        : "";

      const values = {
        id: this._escapeHTML(entryId),
        annotationKey: this._escapeHTML(source.annotationKey || ""),
        latexRaw: escapedLatex,
        pageLabel: this._escapeHTML(source.pageLabel),
        timestamp: this._escapeHTML(timestamp),
        sourceTitle: this._escapeHTML(source.sourceTitle),
        pdfLink: this._escapeHTML(source.pdfLink),
        itemLink: this._escapeHTML(source.itemLink),
        commentBlock
      };

      return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
      });
    }

    /**
     * Resolve where the note write should go:
     * - auto: prefer the currently open note belonging to the same item; otherwise the dedicated child note;
     * - active: same as auto, but fall back to the dedicated child note if no note for this item is open;
     * - dedicated: always the dedicated child note.
     *
     * Also determine whether the target note is already open in a note editor.
     * If it is, do not overwrite it with item.setNote (that would lose unsaved
     * editor input); insert through the editor's internal insertHTML action
     * instead.
     */
    async _resolveNoteTarget(sourceItem, preferredNote) {
      const mode = String(this._getPref("noteTarget", "auto"));
      if (mode !== "dedicated" && !preferredNote) {
        const active = this._findActiveEditorForSource(sourceItem);
        // Read-only notes (e.g. synced read-only notes in group libraries)
        // cannot be written; fall back automatically to the dedicated child note.
        if (active && active.noteItem?.isEditable?.()) {
          return { noteItem: active.noteItem, editorInstance: active.editorInstance, active: true };
        }
      }

      const noteItem = preferredNote || await this._findOrCreateLogNote(sourceItem);
      const editorInstance = this._findEditorForNote(noteItem);
      return { noteItem, editorInstance, active: false };
    }

    _findActiveEditorForSource(sourceItem) {
      try {
        const win = Zotero.getMainWindow();
        if (!win) return null;

        // 1) The current note editor in the right-side context pane
        const contextNoteEditor = win.ZoteroContextPane?.activeEditor;
        const contextInstance = contextNoteEditor?.getCurrentInstance?.();
        if (this._isNoteOfItem(contextInstance, sourceItem)) {
          return {
            editorInstance: contextInstance,
            noteItem: contextInstance._item
          };
        }

        // 2) Note tabs / standalone note windows. Zotero.Notes._editorInstances
        //    is an internal array; read it defensively, and if it is renamed in
        //    a future version, fall back to dedicated mode automatically.
        const instances = Zotero.Notes?._editorInstances || [];
        for (const instance of instances) {
          if (!this._isNoteOfItem(instance, sourceItem)) continue;
          if (
            instance.tabID === win.Zotero_Tabs?.selectedID ||
            instance._iframeWindow === win.document.activeElement?.contentWindow
          ) {
            return { editorInstance: instance, noteItem: instance._item };
          }
        }
      }
      catch (error) {
        this._log(`find active editor failed: ${error.message}`);
      }
      return null;
    }

    _findEditorForNote(noteItem) {
      try {
        const instances = Zotero.Notes?._editorInstances || [];
        for (const instance of instances) {
          if (instance?._item?.id === noteItem.id && instance._iframeWindow) {
            return instance;
          }
        }
      }
      catch (error) {
        this._log(`find editor for note failed: ${error.message}`);
      }
      return null;
    }

    _isNoteOfItem(editorInstance, sourceItem) {
      const item = editorInstance?._item;
      return !!(
        item &&
        item.isNote?.() &&
        item.parentID === sourceItem.id &&
        !item.deleted
      );
    }

    /**
     * Find or create the dedicated "TexLink Formula Notes" child note for this item.
     * Locate it by tag rather than by title, which the user may change.
     */
    async _findOrCreateLogNote(sourceItem) {
      const library = Zotero.Libraries.get(sourceItem.libraryID);
      if (!library?.editable) {
        throw new Error("The library containing this item is read-only; cannot create or modify notes");
      }

      const tag = String(this._getPref("logNoteTag", DEFAULT_LOG_TAG) || DEFAULT_LOG_TAG);
      const noteIDs = sourceItem.getNotes();
      if (noteIDs.length) {
        const notes = await Zotero.Items.getAsync(noteIDs);
        for (const note of notes) {
          if (!note || note.deleted || !note.isNote()) continue;
          const hasTag = note.getTags().some((itemTag) => itemTag.tag === tag);
          if (hasTag) return note;
        }
      }

      const title = String(this._getPref("logNoteTitle", DEFAULT_LOG_TITLE) || DEFAULT_LOG_TITLE);
      const note = new Zotero.Item("note");
      note.libraryID = sourceItem.libraryID;
      note.parentID = sourceItem.id;
      /*
       * Use Zotero 10's internal schema container directly.
       * Block math nodes use <pre class="math">$$...$$</pre>.
       * No <script> and no external styles; the Zotero note editor parses it natively.
       */
      note.setNote(
        `<div data-schema-version="${NOTE_SCHEMA_VERSION}">` +
        `<h2>${this._escapeHTML(title)}</h2>` +
        `<p>This note was created automatically by TexLink. Each formula block contains a local KaTeX preview, LaTeX source, page label, and ISO timestamp.</p>` +
        `</div>`
      );
      note.setTags([{ tag }]);
      await note.saveTx({ skipSelect: true });
      this._log(`created log note ${note.id} for item ${sourceItem.id}`);
      return note;
    }

    /**
     * Write one formula block.
     *
     * Two paths:
     * A. The note is already open in an editor: insert through the editor's
     *    internal insertHTML message so unsaved edits are not overwritten. The
     *    editor saves the change itself about one second later.
     * B. The note is not open: call item.setNote + saveTx directly.
     */
    async _writeEntryToNote({ html, entryId, source, timestamp, latex }) {
      const target = await this._resolveNoteTarget(source.regularItem);
      const noteItem = target.noteItem;
      if (!noteItem?.isEditable?.()) {
        throw new Error("Target note is not editable (it may be in a read-only library or the trash)");
      }

      await this._diag("write-target", target.editorInstance ? "live-editor" : "item-save");
      if (target.editorInstance && !target.editorInstance._readOnly) {
        const inserted = this._insertIntoOpenEditor(target.editorInstance, html);
        if (inserted) {
          // The editor autosaves after about 1s. Wait up to 4s for this
          // timestamp to appear in the note item.
          const saved = await this._waitForNoteText(noteItem, timestamp, 4000);
          if (!saved) {
            this._log("note editor did not persist within timeout; forcing saveSync");
            try { target.editorInstance.saveSync(); } catch (e) { /* noop */ }
            await this._waitForNoteText(noteItem, timestamp, 1500);
          }
          return noteItem;
        }
      }

      await this._diag("append-direct-start");
      await this._appendEntryDirectly(noteItem, html);
      await this._diag("append-direct-done");
      return noteItem;
    }

    _insertIntoOpenEditor(editorInstance, html) {
      try {
        if (!editorInstance?._postMessage || !editorInstance._iframeWindow) return false;
        // Matches the protocol used internally by Zotero.EditorInstance.insertAnnotations():
        // ProseMirror parses the insertHTML action and merges it into the document.
        editorInstance._postMessage({
          action: "insertHTML",
          pos: null,
          html
        });
        return true;
      }
      catch (error) {
        this._logError("insertIntoOpenEditor failed; falling back to item save", error);
        return false;
      }
    }

    async _waitForNoteText(noteItem, text, timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          if (String(noteItem.getNote()).includes(text)) return true;
        }
        catch (error) { /* note might be reloading */ }
        await this._delay(100);
      }
      return false;
    }

    async _appendEntryDirectly(noteItem, html) {
      const current = String(noteItem.getNote() || "");
      const doc = new DOMParser().parseFromString(current, "text/html");
      const noteRoot = doc.body.querySelector(".zotero-note");
      const contentRoot =
        (noteRoot || doc.body).querySelector("div[data-schema-version]") ||
        noteRoot ||
        doc.body;

      // insertAdjacentHTML parses blockquote/pre.math per HTML rules; no manual node building needed.
      contentRoot.insertAdjacentHTML("beforeend", html);

      const next = noteRoot ? noteRoot.outerHTML : doc.body.innerHTML;
      noteItem.setNote(next);
      await noteItem.saveTx({ skipSelect: true });
    }

    // ===================== Reader toast (no new windows) =====================

    /**
     * Show a lightweight toast in the Reader's outer HTML document.
     *
     * This deliberately avoids opening a native Zotero progress window from PDF
     * area context-menu commands: on macOS, "native/React menu callback ->
     * immediate openDialog" has a window-reentrancy risk that was observed as a
     * SIGSEGV in the main Zotero process after choosing a menu item. The toast
     * is just a fixed div in the Reader document and never opens a native window.
     */
    _newProgress(text, reader) {
      try {
        const win = reader?._iframeWindow;
        const doc = win?.document;
        if (!doc?.body) return null;
        let el = doc.getElementById("texlink-toast");
        if (!el) {
          el = doc.createElement("div");
          el.id = "texlink-toast";
          el.setAttribute("role", "status");
          el.style.cssText = [
            "position: fixed",
            "right: 20px",
            "bottom: 20px",
            "z-index: 2147483647",
            "max-width: 420px",
            "padding: 10px 14px",
            "border-radius: 8px",
            "background: rgba(36, 36, 36, 0.94)",
            "color: #fff",
            "font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            "box-shadow: 0 6px 24px rgba(0,0,0,0.35)",
            "white-space: pre-wrap",
            "word-break: break-word",
            "pointer-events: none",
            "opacity: 0",
            "transition: opacity 0.15s ease"
          ].join(";");
          doc.body.appendChild(el);
        }
        clearTimeout(el.__texlinkTimer);
        el.textContent = text;
        el.style.background = "rgba(36, 36, 36, 0.94)";
        el.style.opacity = "1";
        const handle = { el };
        this._toasts.add(handle);
        return handle;
      }
      catch (error) {
        this._logError("Failed to create reader toast", error);
        return null;
      }
    }

    _setProgress(progress, percent, text, isError = false) {
      if (!progress?.el) return;
      try {
        if (text) progress.el.textContent = text;
        progress.el.style.background = isError
          ? "rgba(150, 30, 30, 0.96)"
          : "rgba(36, 36, 36, 0.94)";
        progress.el.style.opacity = "1";
      }
      catch (error) {
        this._log(`toast update failed: ${error.message}`);
      }
    }

    _closeProgress(progress, delayMs = 5000) {
      if (!progress?.el) return;
      try {
        clearTimeout(progress.el.__texlinkTimer);
        progress.el.__texlinkTimer = setTimeout(() => {
          try { progress.el.style.opacity = "0"; } catch (e) { /* dead doc */ }
          this._toasts.delete(progress);
        }, delayMs);
      }
      catch (error) {
        this._toasts.delete(progress);
      }
    }

    _clearToasts() {
      for (const handle of this._toasts) {
        try {
          clearTimeout(handle.el.__texlinkTimer);
          handle.el.remove();
        }
        catch (e) { /* reader may be closed */ }
      }
      this._toasts.clear();
    }

    _showError(error, reader = null) {
      const message = String(error?.message || error || "Unknown error");
      this._logError("user-visible error", error);
      this._diag("show-error", message);
      const progress = this._newProgress(message, reader);
      this._setProgress(progress, null, message, true);
      this._closeProgress(progress, 10000);
    }

    async _promptComment() {
      try {
        const win = Zotero.getMainWindow();
        if (!win) return "";
        const value = { value: "" };
        const accepted = Services.prompt.prompt(
          win,
          "TexLink Comment",
          "Optional comment (leave blank to skip; Cancel aborts this recognition):",
          value,
          null,
          {}
        );
        if (!accepted) return null;
        return String(value.value || "").trim();
      }
      catch (error) {
        this._logError("comment prompt failed", error);
        return "";
      }
    }
  }

  // Exposed for build-time/debug-time tests; runtime logic does not depend on it.
  Service.BPEDecoder = TexLinkBPEDecoder;

  return Service;
})();
