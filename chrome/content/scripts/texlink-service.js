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
  const PREFS_PANE_ID = "texlink-preferences";

  // Inline the icon as a data URI. XUL `image` attributes and Zotero's
  // preference sidebar both failed to paint chrome:/jar: URLs on some
  // Zotero 10 builds and themes. A data URI needs no chrome-package
  // registration, no resource resolution, and no theme-specific context-fill.
  // It is the same 48px PNG shipped in chrome/content/icons/texlink-48.png,
  // base64-encoded so every entry point renders identically everywhere.
  const ICON_DATA_URI = "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABb0lEQVR4nN1a2w3CMAxMrU5DhgHxTwdhAAaBfwTDJOuAKlEpBNM4r8bOSXxUJOmdfbWTglLCMYQG7E6Pl2oIezuschy4EqcKGbgTDwkBSeQxjl8CJAIkRR/j2kcGdoKiv2Dh3EcGJGOkDjTXffJN9PRUtQBKOKB29FlYSE/PHxE1bVHFQj5hLlmBmMEcRUDuAq1FQOwEzPstRUDKJE4iIHWiuCrE9aGG3AVaixhrLDqLoFjMnO9f1/pyjL7XUOo84EY+RN4n7oMqZD7gF9nM+bZZs1GIPDZmvl4+m+xG/2XgH3l9Of5EnSK0SiemlleXsPmQxazjCsG+h63Ih4gYRAQlC8kCSpRLjdhmzWbFqhBGPqczm8SqNFeh6D5QmrxLMKUvZDeyknsindDIop4BjsdKkEyebCHM9zFVqPl7Ic0k2l2+2BqpA7lmAZRwAOWnTI6wH859ZEBaFqzDtZ8MSMmC9Tj291cDbkKsAFdk4Q2KA6xbTxHo5QAAAABJRU5ErkJggg==";

  // Safety-net template only. The authoritative, user-editable default lives
  // in prefs.js; this copy exists solely so a cleared/corrupt pref still
  // produces a complete, localized block. Every visible string is a
  // placeholder resolved through Fluent at render time - no hardcoded
  // language (0.1.5 shipped an English fallback in preferences.js).
  //
  // data-texlink-id is the STABLE block identity: it equals the annotation key
  // and never changes when the LaTeX is re-recognized. data-texlink-latex
  // stores the escaped source for copy/export without parsing math nodes.
  const DEFAULT_NOTE_TEMPLATE = [
    '<blockquote data-texlink-entry="{{id}}" data-texlink-id="{{stableId}}" data-texlink-annotation="{{annotationKey}}" data-texlink-latex="{{latexRaw}}" data-texlink-confidence="{{confidence}}">',
    '  <h3>{{anchorTitle}}</h3>',
    '  <pre class="math">$${{latexRaw}}$$</pre>',
    '  {{reviewBlock}}',
    '  <p><strong>{{labelPage}}:</strong> {{pageLabel}} | <strong>{{labelExtracted}}:</strong> {{timestamp}}</p>',
    '  <p><strong>{{labelSource}}:</strong> {{sourceTitle}} | <a href="{{pdfLink}}">{{labelOpenPdf}}</a> | <a href="{{itemLink}}">{{labelViewItem}}</a></p>',
    '  {{commentBlock}}',
    '  <p><strong>{{labelLatexSource}}:</strong></p>',
    '  <pre>{{latexRaw}}</pre>',
    '</blockquote>'
  ].join("\n");

  /**
   * Remove cosmetic tokenizer whitespace from a LaTeX string.
   *
   * Pix2Text-MFR's tokenizer emits spaces between many LaTeX tokens, producing
   * source such as "F _ { t } = f _ { \\mathrm { e n c } }". Those spaces are
   * not part of the formula. This pass removes whitespace outside text groups,
   * keeps explicit spacing commands and \text{...} content, and inserts an
   * empty group after a control word when removing the space would otherwise
   * merge it with a following letter ("\alpha x" -> "\alpha{}x").
   *
   * @param {string} text
   * @returns {string}
   */
  function compactLatexSpacing(text) {
    const source = String(text || "");
    let output = "";
    let index = 0;
    let pendingSpace = false;
    let lastWasControlWord = false;
    let lastWasNoBrace = false;
    let textMode = false;
    let textDepth = 0;
    let textCommandPending = false;
    const textCommands = new Set([
      "text", "textrm", "textnormal", "textit", "textbf", "textsf", "texttt",
      "mbox", "hbox", "operatorname"
    ]);
    // For these commands an inserted "{}" is not cosmetic - it changes the
    // meaning or produces invalid LaTeX. "\left{}x" is invalid, and
    // "\operatorname{}a" silently drops the operator name. Keeping the
    // original space is always safer than inventing a group.
    const noBraceCommands = new Set([
      "left", "right", "middle", "big", "Big", "bigg", "Bigg",
      "begin", "end", "operatorname", "quad", "qquad", "displaystyle",
      "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits"
    ]);

    while (index < source.length) {
      const ch = source[index];

      if (/\s/.test(ch)) {
        pendingSpace = true;
        index++;
        continue;
      }

      // A text command only enters text mode if its next non-space token is "{".
      if (textCommandPending && ch !== "{") {
        textCommandPending = false;
      }

      if (ch === "\\") {
        const next = source[index + 1] || "";
        if (/[A-Za-z]/.test(next)) {
          let end = index + 1;
          while (end < source.length && /[A-Za-z]/.test(source[end])) end++;
          const name = source.slice(index + 1, end);
          output += "\\" + name;
          lastWasControlWord = true;
          lastWasNoBrace = noBraceCommands.has(name);
          pendingSpace = false;
          index = end;
          if (textCommands.has(name)) textCommandPending = true;
          continue;
        }

        // Control symbol, including "\ " (an explicit math space).
        output += "\\" + next;
        lastWasControlWord = false;
        lastWasNoBrace = false;
        pendingSpace = false;
        index += 2;
        continue;
      }

      if (ch === "{") {
        output += "{";
        if (textCommandPending) {
          if (textMode) textDepth++;
          else {
            textMode = true;
            textDepth = 1;
          }
          textCommandPending = false;
        }
        else if (textMode) {
          textDepth++;
        }
        lastWasControlWord = false;
        lastWasNoBrace = false;
        pendingSpace = false;
        index++;
        continue;
      }

      if (ch === "}") {
        output += "}";
        if (textMode) {
          textDepth--;
          if (textDepth <= 0) {
            textMode = false;
            textDepth = 0;
          }
        }
        lastWasControlWord = false;
        lastWasNoBrace = false;
        pendingSpace = false;
        index++;
        continue;
      }

      if (textMode) {
        if (pendingSpace) output += " ";
        pendingSpace = false;
        output += ch;
        lastWasControlWord = false;
        lastWasNoBrace = false;
        index++;
        continue;
      }

      if (pendingSpace && lastWasControlWord && /[\p{L}]/u.test(ch)) {
        output += lastWasNoBrace ? " " : "{}";
      }
      pendingSpace = false;
      output += ch;
      lastWasControlWord = false;
      lastWasNoBrace = false;
      index++;
    }

    return output.trim();
  }

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
     * - remove tokenizer-inserted cosmetic whitespace outside text groups;
     * - preserve explicit spacing commands and \text{...} content.
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

      // Remove tokenizer-inserted cosmetic spaces while preserving text groups
      // and explicit spacing commands.
      return compactLatexSpacing(output);
    }
  }

  class Service {
    constructor(options = {}) {
      this.id = options.id || PLUGIN_ID;
      this.version = options.version || "1.0.1";
      this.rootURI = options.rootURI || "";
      this.chromeBase = options.chromeBase || `chrome://${CHROME_NAME}/content/`;
      this._compactLatexSpacing = compactLatexSpacing;

      this._started = false;
      this._destroyed = false;
      this._busy = false;
      this._cancelRequested = false;
      this._workerAborted = false;
      this._fallbackErrorWindow = null;
      this._prefsPaneID = null;
      this._prefsPanePromise = null;
      this._prefsPaneRegistered = false;
      this._l10nInitialized = false;

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

      // Last successful recognition, used by the Tools > TexLink copy commands.
      this._lastResult = null;
    }

    // ===================== Lifecycle =====================

    async startup() {
      if (this._started) return;
      this._started = true;

      this._initLocalization();

      // Wait for Zotero's UI before touching window DOM / AddonManager.
      await Zotero.uiReadyPromise;

      // ---- Settings pane: independent of recognition wiring ----
      // Register in parallel and never await it here. In earlier versions the
      // pane was awaited before the worker/menu/notifier were wired, so any
      // registration hiccup took down BOTH Settings and formula recognition.
      // Fire-and-forget with its own catch: the two features cannot block or
      // fail each other. openPreferences() retries lazily if this fails.
      this.registerPreferencesPane().catch((error) => {
        this._logError("Failed to register preferences pane", error);
      });

      await this._migrateLegacyTemplate();
      this._diag("service-startup", `${this.id} ${this.version}`);

      // ---- Recognition wiring (independent of the settings pane) ----
      if (!this._getPref("enabled", true)) {
        this._log("disabled by preference: skipping recognition wiring");
      }
      else {
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

        // Create only the Worker shell; ORT and ONNX load in _ensureModelLoaded().
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
        // even if an internal event is missed. Recognition only.
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
    }

    async onMainWindowLoad(win) {
      if (this._destroyed || !win || this._windowCleanups.has(win)) {
        return;
      }
      // The master switch must suppress Tools-menu commands and shortcuts too.
      // bootstrap still forwards window callbacks; without this guard the
      // add-on appeared off while still recognizing formulas (0.1.5 bug).
      if (!this._getPref("enabled", true)) {
        this._log("window wiring skipped: TexLink disabled");
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
      if (this._fallbackErrorWindow) {
        try { this._fallbackErrorWindow.close(); } catch (e) { /* noop */ }
        this._fallbackErrorWindow = null;
      }

      if (this._notifierID) {
        try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* noop */ }
        this._notifierID = null;
      }

      if (this._l10nInitialized) {
        try { Zotero.ftl?.removeResourceIds?.(["texlink.ftl"]); } catch (e) { /* noop */ }
        this._l10nInitialized = false;
      }

      if (this._prefsPaneID && Zotero.PreferencePanes?.unregister) {
        try { Zotero.PreferencePanes.unregister(this._prefsPaneID); } catch (e) { /* noop */ }
      }
      this._prefsPaneID = null;
      this._prefsPanePromise = null;
      this._prefsPaneRegistered = false;

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

    // ===================== Preferences =====================

    _initLocalization() {
      try {
        if (!Zotero.ftl?.addResourceIds) return;
        Zotero.ftl.addResourceIds(["texlink.ftl"]);
        this._l10nInitialized = true;
      }
      catch (error) {
        this._logError("Failed to initialize localization", error);
      }
    }

    _t(key, fallback, args) {
      try {
        const value = Zotero.ftl?.formatValueSync?.(key, args || undefined);
        if (value) return value;
      }
      catch (error) {
        // Fall back to the English string below.
      }
      return fallback;
    }

    getDefaultNoteTemplate() {
      return DEFAULT_NOTE_TEMPLATE;
    }

    getDefaultLogNoteTitle() {
      return this._t("texlink-note-title", DEFAULT_LOG_TITLE);
    }

    /**
     * 0.1.5 installed its old note template as a DEFAULT pref. On upgrade that
     * default survives, so new blocks would keep using the old format and miss
     * the stable id / LaTeX attribute / review marker. Migrate only when the
     * user never customized the template; a user-provided template is sacred.
     */
    async _migrateLegacyTemplate() {
      try {
        const key = `${PREF_PREFIX}.noteTemplate`;
        if (Zotero.Prefs.prefHasUserValue(key)) return;
        const current = String(Zotero.Prefs.get(key, true) || "");
        if (!current || current.includes("data-texlink-id")) return;
        if (
          current.includes('data-texlink-entry="{{id}}"') &&
          current.includes('data-texlink-annotation="{{annotationKey}}"')
        ) {
          Zotero.Prefs.set(key, DEFAULT_NOTE_TEMPLATE, true);
          this._log("migrated legacy note template to v1.0.0");
          await this._diag("template-migrated");
        }
      }
      catch (error) {
        this._logError("legacy template migration failed", error);
      }
    }

    /**
     * Register the TexLink pane in Zotero Preferences.
     *
     * Kept deliberately simple and idempotent. Zotero's register() throws if
     * the pane id already exists, so we check the live registry once and
     * reuse an existing pane; concurrent callers share a single in-flight
     * promise. No watchdog, no object-identity bookkeeping: those earlier
     * attempts raced with Zotero's own pane lifecycle and caused the
     * intermittent "Settings disappeared" failures.
     *
     * Zotero unregisters a plugin's panes itself on shutdown, so we do not
     * fight it. openPreferences() re-registers lazily if the pane is gone.
     */
    registerPreferencesPane() {
      if (!Zotero.PreferencePanes?.register) {
        this._log("Zotero.PreferencePanes.register unavailable");
        return Promise.resolve(null);
      }
      if (this._prefsPaneRegistered && this._prefsPaneID) {
        return Promise.resolve(this._prefsPaneID);
      }
      if (this._prefsPanePromise) return this._prefsPanePromise;

      // Reuse a pane Zotero already knows about (e.g. after a hot reload):
      // re-registering the same id would throw "already registered".
      const existing = (Zotero.PreferencePanes.pluginPanes || [])
        .find((pane) => pane.id === PREFS_PANE_ID);
      if (existing) {
        this._prefsPaneID = PREFS_PANE_ID;
        this._prefsPaneRegistered = true;
        return Promise.resolve(PREFS_PANE_ID);
      }

      // AddonManager provides rootURI; using it avoids depending on the
      // dynamic chrome-package registration order.
      const res = (relative) => `${this.rootURI}chrome/content/${relative}`;
      const options = {
        pluginID: this.id,
        id: PREFS_PANE_ID,
        label: "TexLink",
        // Inline PNG renders in the sidebar regardless of theme or URL scheme.
        image: ICON_DATA_URI,
        src: res("preferences/preferences.xhtml"),
        scripts: [res("preferences/preferences.js")],
        stylesheets: [res("preferences/preferences.css")]
      };

      this._prefsPanePromise = Promise.resolve()
        .then(() => Zotero.PreferencePanes.register(options))
        .then((id) => {
          this._prefsPaneID = id || PREFS_PANE_ID;
          this._prefsPaneRegistered = true;
          this._log(`preferences pane registered: ${this._prefsPaneID}`);
          return this._prefsPaneID;
        })
        .catch((error) => {
          // Clear cached state so openPreferences() can retry cleanly.
          this._prefsPaneRegistered = false;
          this._prefsPaneID = null;
          this._logError("Failed to register preferences pane", error);
          return null;
        })
        .finally(() => {
          this._prefsPanePromise = null;
        });
      return this._prefsPanePromise;
    }

    /** Open Zotero Preferences directly on the TexLink pane. */
    async openPreferences() {
      // Lazy retry: if Zotero removed the pane (plugin reload) or the earlier
      // registration failed, create it now. Normally this is a cheap no-op.
      let paneID = await this.registerPreferencesPane();
      if (!paneID) {
        const present = (Zotero.PreferencePanes?.pluginPanes || [])
          .some((pane) => pane.id === PREFS_PANE_ID);
        paneID = present ? PREFS_PANE_ID : null;
      }
      if (!Zotero.Utilities?.Internal?.openPreferences) {
        throw new Error(this._t(
          "texlink-error-preferences-unavailable",
          "This Zotero version cannot open plugin preferences."
        ));
      }
      try {
        Zotero.Utilities.Internal.openPreferences(paneID);
      }
      catch (error) {
        if (!paneID) throw error;
        // Fall back to the plain Preferences window so the command is never
        // a silent no-op.
        Zotero.Utilities.Internal.openPreferences(null);
      }
      return true;
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
        const progress = this._activeProgress;
        this._logError("Worker error", error);
        this._abortWorker(error);
        this._setProgress(
          progress,
          null,
          this._t(
            "texlink-progress-worker-error",
            `Inference Worker error: ${message}`,
            { message }
          ),
          true
        );
      };
      this._worker.onmessageerror = () => {
        const error = new Error("Failed to deserialize Worker message");
        this._logError("Worker message error", error);
        this._abortWorker(error);
      };
      this._workerAborted = false;
      return this._worker;
    }

    /**
     * Terminate the current Worker and reject every pending request. The next
     * recognition attempt creates a fresh Worker and reloads the model.
     */
    _abortWorker(error) {
      this._workerAborted = true;
      this._modelReady = false;
      this._modelInitPromise = null;
      this._modelError = null;
      this._workerBooted = false;
      if (this._worker) {
        try { this._worker.terminate(); } catch (e) { /* noop */ }
        this._worker = null;
      }
      this._rejectAllPending(error || new Error("Inference Worker was reset"));
      this._activeProgress = null;
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
        return Promise.reject(new Error(this._t(
          "texlink-error-worker-init",
          "Inference Worker is not initialized."
        )));
      }
      const requestId = ++this._requestSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this._pending.has(requestId)) return;
          this._abortWorker(new Error(`Worker request timed out: ${type}`));
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
      let text = this._t("texlink-progress-processing", "Processing...");
      if (message.phase === "ort") {
        text = this._t("texlink-progress-ort", "Initializing offline inference engine...");
      }
      else if (message.phase === "encoder") {
        text = this._t("texlink-progress-encoder", "Loading formula model (encoder)...");
      }
      else if (message.phase === "decoder") {
        text = this._t("texlink-progress-decoder", "Loading formula model (decoder)...");
      }
      else if (message.phase === "decode" && message.maxNewTokens) {
        text = this._t(
          "texlink-progress-decoding",
          `Decoding formula (${message.step}/${message.maxNewTokens})...`,
          { step: message.step, max: message.maxNewTokens }
        );
      }
      this._setProgress(this._activeProgress, percent, text);
    }

    /**
     * Ensure the Worker has loaded ORT and both ONNX sessions.
     * Concurrent calls share one promise to avoid loading the 31MB model twice.
     */
    async _ensureModelLoaded(progress) {
      if (this._modelReady) return;
      if (this._modelError) {
        throw new Error(this._t(
          "texlink-error-model-load",
          `Model load failed: ${this._modelError.message || this._modelError}`,
          { message: this._modelError.message || String(this._modelError) }
        ));
      }
      if (!this._modelConfig || !this._tokenizer) {
        throw new Error(this._t(
          "texlink-error-model-config",
          "Model configuration or tokenizer is not loaded yet."
        ));
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
          if (!this._workerAborted) {
            this._modelError = error;
          }
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
              ? this._t("texlink-menu-multiple", "TexLink: Recognize Selected Formulas and Add to Note")
              : this._t("texlink-menu-single", "TexLink: Recognize Formula and Add to Note"),
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

          // v1.0.0: a formula that already exists can be re-recognized from its
          // original screenshot and replaced in place instead of deleted.
          if (items.length === 1 && this._annotationHasEntry(items[0])) {
            append({
              label: this._t(
                "texlink-menu-replace",
                "TexLink: Re-recognize and Replace This Formula"
              ),
              onCommand: () => {
                this._diag("reader-menu-replace", items[0].key);
                setTimeout(() => {
                  this._recognizeAnnotationItems(items, reader, null, { replace: true })
                    .catch((error) => {
                      this._logError("re-recognition failed", error);
                      this._showError(error, reader);
                    });
                }, 0);
              }
            });
          }
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

    /**
     * Whether this screenshot already produced a formula block in any note of
     * its parent item. Synchronous by design: the Reader context-menu API
     * requires append() to be called without awaiting.
     */
    _annotationHasEntry(annotationItem) {
      try {
        const sourceItem = annotationItem?.parentItem?.parentItem;
        if (!sourceItem || typeof sourceItem.getNotes !== "function") return false;
        const key = String(annotationItem.key || "");
        if (!key) return false;
        for (const noteID of sourceItem.getNotes()) {
          const note = Zotero.Items.get(noteID);
          if (!note || note.deleted || !note.isNote()) continue;
          const html = String(note.getNote() || "");
          if (
            html.includes(`data-texlink-annotation="${key}"`) ||
            html.includes(`data-texlink-id="${key}"`)
          ) {
            return true;
          }
        }
      }
      catch (error) {
        this._log(`annotation entry lookup failed: ${error.message}`);
      }
      return false;
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
        this._showError(new Error(this._t("texlink-error-busy", "TexLink is still processing the previous formula; please wait.")), reader);
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
     * Append TexLink commands to the end of Zotero's Tools menu.
     *
     * We operate directly on Zotero's own XUL DOM and remove only the nodes we
     * created on window unload; existing Zotero menu items are never touched.
     * Labels go through Fluent with English fallbacks.
     */
    _installToolsMenu(win, cleanups) {
      const doc = win?.document;
      const popup = doc?.getElementById("menu_ToolsPopup");
      if (!popup) return;

      // Old nodes may remain after a plugin reload; remove them first.
      for (const id of [
        "texlink-tools-separator",
        "texlink-tools-menuitem",
        "texlink-tools-submenu",
        "texlink-tools-separator-2",
        "texlink-tools-replace",
        // Keep removing the legacy Tools -> Settings item so upgrades from
        // earlier builds do not leave a stale menu entry behind. Settings now
        // lives only in Zotero's own Preferences sidebar (TexLink pane).
        "texlink-tools-settings"
      ]) {
        doc.getElementById(id)?.remove();
      }

      const nodes = [];
      const handlers = [];
      const remember = (element, handler) => {
        nodes.push(element);
        if (handler) {
          element.addEventListener("command", handler);
          handlers.push([element, handler]);
        }
        return element;
      };
      // Defer all work until the native menu has closed. Opening a window or
      // touching the clipboard synchronously here was a crash risk on macOS.
      const defer = (fn) => (event) => {
        event?.preventDefault?.();
        setTimeout(() => {
          try {
            Promise.resolve(fn()).catch((error) => {
              this._logError("Tools menu command failed", error);
              this._showError(error, this._getActiveReader());
            });
          }
          catch (error) {
            this._logError("Tools menu command failed", error);
            this._showError(error, this._getActiveReader());
          }
        }, 0);
      };

      const separator = remember(doc.createXULElement("menuseparator"));
      separator.id = "texlink-tools-separator";

      const menuitem = remember(
        doc.createXULElement("menuitem"),
        defer(() => {
          this._diag("tools-menu-command");
          return this.recognizeFromActiveReader();
        })
      );
      menuitem.id = "texlink-tools-menuitem";
      menuitem.setAttribute("class", "menuitem-iconic");
      const iconURL = ICON_DATA_URI;
      menuitem.setAttribute("image", iconURL);
      // The legacy image attribute is not painted consistently by Zotero 10.
      // Apply list-style-image inline; this keeps the native Tools menu intact.
      menuitem.style.setProperty("list-style-image", `url("${iconURL}")`, "important");
      menuitem.setAttribute(
        "label",
        this._t("texlink-menu-tools", "TexLink: Recognize Selected Formula Screenshot")
      );
      menuitem.setAttribute(
        "tooltiptext",
        this._t(
          "texlink-menu-tools-tooltip",
          "First select a formula with the image annotation tool in the PDF, then click here or use the shortcut."
        )
      );

      // Copy / export / review submenu (v1.0.0).
      const submenu = remember(doc.createXULElement("menu"));
      submenu.id = "texlink-tools-submenu";
      submenu.setAttribute("class", "menu-iconic");
      const submenuIcon = ICON_DATA_URI;
      submenu.setAttribute("image", submenuIcon);
      submenu.style.setProperty(
        "list-style-image",
        `url("${submenuIcon}")`,
        "important"
      );
      submenu.setAttribute(
        "label",
        this._t("texlink-menu-submenu", "TexLink: Copy / Export / Review")
      );
      const subpopup = doc.createXULElement("menupopup");
      submenu.appendChild(subpopup);
      const addSubItem = (id, key, fallback, fn) => {
        const item = remember(doc.createXULElement("menuitem"), defer(fn));
        item.id = id;
        item.setAttribute("label", this._t(key, fallback));
        subpopup.appendChild(item);
        return item;
      };
      addSubItem(
        "texlink-tools-copy-latex",
        "texlink-menu-copy-latex",
        "Copy last LaTeX",
        () => this._copyLastResult("latex")
      );
      addSubItem(
        "texlink-tools-copy-markdown",
        "texlink-menu-copy-markdown",
        "Copy last formula as Markdown",
        () => this._copyLastResult("markdown")
      );
      addSubItem(
        "texlink-tools-copy-inline",
        "texlink-menu-copy-inline",
        "Copy last formula as inline math",
        () => this._copyLastResult("inline")
      );
      addSubItem(
        "texlink-tools-copy-all",
        "texlink-menu-copy-all",
        "Copy all formulas in current note (Markdown)",
        () => this._copyAllFormulas()
      );
      addSubItem(
        "texlink-tools-copy-review",
        "texlink-menu-copy-review",
        "Copy low-confidence formulas for review",
        () => this._copyReviewList()
      );

      const separator2 = remember(doc.createXULElement("menuseparator"));
      separator2.id = "texlink-tools-separator-2";

      const replaceItem = remember(
        doc.createXULElement("menuitem"),
        defer(() => this._replaceSelectedFromTools())
      );
      replaceItem.id = "texlink-tools-replace";
      replaceItem.setAttribute("class", "menuitem-iconic");
      const replaceIcon = iconURL;
      replaceItem.setAttribute("image", replaceIcon);
      replaceItem.style.setProperty(
        "list-style-image",
        `url("${replaceIcon}")`,
        "important"
      );
      replaceItem.setAttribute(
        "label",
        this._t("texlink-menu-replace-tools", "TexLink: Re-recognize and Replace Selected Formula")
      );

      // Settings is intentionally NOT in the Tools menu. It lives only in
      // Zotero's own Preferences sidebar (the registered TexLink pane), so
      // there is a single, system-standard place to configure the plugin.

      for (const node of [
        separator, menuitem, submenu, separator2, replaceItem
      ]) {
        popup.appendChild(node);
      }

      cleanups.push(() => {
        for (const [element, handler] of handlers) {
          try { element.removeEventListener("command", handler); } catch (e) { /* noop */ }
        }
        for (const node of nodes) {
          try { node.remove(); } catch (e) { /* noop */ }
        }
      });
    }

    // ===================== User-triggered entry points =====================

    async recognizeFromActiveReader() {
      const reader = this._getActiveReader();
      if (!reader) {
        this._showError(new Error(this._t(
          "texlink-error-open-pdf",
          "Open a PDF and select a formula with the image annotation tool first. TexLink does not read the clipboard or upload images."
        )), null);
        return [];
      }
      return this.recognizeFromReader(reader);
    }

    async recognizeFromReader(reader) {
      if (this._busy) {
        this._showError(new Error(this._t("texlink-error-busy", "TexLink is still processing the previous formula; please wait.")), reader);
        return [];
      }
      const items = this._getSelectedImageAnnotations(reader);
      if (!items.length) {
        this._showError(new Error(this._t(
          "texlink-error-no-annotation",
          "No image annotation is selected. Use the image annotation tool in the Zotero PDF reader to select the formula, then select that screenshot and try again."
        )), reader);
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
     * @param {{auto?: boolean, replace?: boolean}} options
     */
    async _recognizeAnnotationItems(annotationItems, reader, comment = null, options = {}) {
      if (this._destroyed) return [];
      if (!Array.isArray(annotationItems) || !annotationItems.length) return [];
      if (this._busy) {
        if (!options.auto) {
          this._showError(new Error(this._t("texlink-error-busy", "TexLink is still processing the previous formula; please wait.")), reader);
        }
        return [];
      }
      if (!this._modelConfig || !this._tokenizer) {
        this._showError(new Error(this._t(
          "texlink-error-model-missing",
          "Formula model/tokenizer is not loaded, so recognition is unavailable. Reinstall the complete TexLink.xpi."
        )), reader);
        return [];
      }

      this._busy = true;
      this._cancelRequested = false;
      await this._diag("pipeline-start", options.auto ? "auto" : "manual");
      // Let the event source (menu/shortcut/Notifier) finish its current event
      // before any UI update.
      await this._delay(60);
      const progress = this._newProgress(
        this._t("texlink-progress-preparing", "Preparing to recognize formula..."),
        reader,
        {
          cancellable: !options.auto,
          onCancel: () => this._cancelRecognition()
        }
      );
      this._activeProgress = progress;
      const results = [];
      const failures = [];

      try {
        let effectiveComment = comment;
        if (!options.auto && this._getPref("promptForComment", false)) {
          effectiveComment = await this._promptComment();
          if (effectiveComment === null) {
            this._setProgress(progress, 100, this._t("texlink-progress-canceled", "Canceled"));
            this._closeProgress(progress, 1000);
            return [];
          }
        }

        this._setProgress(
          progress,
          12,
          this._t("texlink-progress-loading-model", "Loading offline model...")
        );
        await this._diag("model-load-start");
        await this._ensureModelLoaded(progress);
        await this._diag("model-load-end");

        for (let index = 0; index < annotationItems.length; index++) {
          // A cancel request must stop the whole batch. Previously the loop
          // kept going with a terminated Worker and reported every remaining
          // screenshot as a failure.
          if (this._cancelRequested) break;
          const item = annotationItems[index];
          const prefix = annotationItems.length > 1
            ? `[${index + 1}/${annotationItems.length}] `
            : "";
          try {
            await this._diag("annotation-start", item.key);
            this._setProgress(
              progress,
              60,
              `${prefix}${this._t("texlink-progress-reading", "Reading screenshot and running inference...")}`
            );
            const result = await this._recognizeSingle(
              item,
              reader,
              effectiveComment,
              progress,
              prefix,
              options.replace === true
            );
            await this._diag("annotation-done", item.key);
            results.push(result);
          }
          catch (error) {
            if (this._cancelRequested) break;
            failures.push({ item, error });
            this._logError(`recognition failed for annotation ${item?.key}`, error);
          }
        }

        if (this._cancelRequested) {
          await this._diag("pipeline-canceled-batch");
          this._setProgress(progress, null, this._t("texlink-progress-canceled", "Canceled"), true);
          this._closeProgress(progress, 1500);
          return results;
        }

        if (results.length) {
          const replaced = results.filter((result) => result.replaced).length;
          const duplicates = results.filter(
            (result) => result.duplicate && !result.replaced
          ).length;
          const added = results.length - duplicates - replaced;
          const parts = [];
          if (added) {
            parts.push(this._t(
              "texlink-progress-added",
              `Added ${added} formula records to the Zotero note`,
              { count: added }
            ));
          }
          if (replaced) {
            parts.push(this._t(
              "texlink-progress-replaced",
              `Updated ${replaced} formula records in place`,
              { count: replaced }
            ));
          }
          if (duplicates) {
            parts.push(this._t(
              "texlink-progress-skipped",
              `Skipped ${duplicates} duplicate records`,
              { count: duplicates }
            ));
          }
          if (failures.length) {
            parts.push(this._t(
              "texlink-progress-failed-count",
              `${failures.length} failed; see Zotero debug output`,
              { count: failures.length }
            ));
          }
          this._setProgress(progress, 100, parts.join("; "));
          this._closeProgress(progress, failures.length ? 10000 : 5000);
        }
        else {
          const first = failures[0]?.error;
          this._setProgress(
            progress,
            null,
            this._t(
              "texlink-progress-recognition-failed",
              `Recognition failed: ${first?.message || "Unknown error"}`,
              { message: first?.message || this._t("texlink-error-unknown", "Unknown error") }
            ),
            true
          );
          this._closeProgress(progress, 10000);
        }
        return results;
      }
      catch (error) {
        if (this._cancelRequested) {
          await this._diag("pipeline-canceled");
          this._setProgress(progress, null, this._t("texlink-progress-canceled", "Canceled"), true);
          this._closeProgress(progress, 1500);
          return results;
        }
        await this._diag("pipeline-error", error.message || String(error));
        this._setProgress(
          progress,
          null,
          this._t(
            "texlink-progress-failed",
            `TexLink failed: ${error.message || error}`,
            { message: error.message || String(error) }
          ),
          true
        );
        this._closeProgress(progress, 10000);
        this._logError("recognition pipeline failed", error);
        return results;
      }
      finally {
        this._busy = false;
        this._cancelRequested = false;
        if (this._activeProgress === progress) this._activeProgress = null;
      }
    }

    // ===================== Single-annotation recognition =====================

    async _recognizeSingle(annotationItem, reader, comment, progress, prefix = "", replace = false) {
      await this._diag("single-start", annotationItem.key);
      const source = this._buildSourceContext(annotationItem, reader);
      await this._diag("source-built", source.pageLabel);
      await this._diag("image-read-start");
      const image = await this._getAnnotationImage(annotationItem);
      await this._diag("image-read-done", image.length);

      this._setProgress(
        progress,
        64,
        `${prefix}${this._t("texlink-progress-preprocessing", "Preprocessing image...")}`
      );
      await this._diag("preprocess-start");
      const tensor = await this._preprocessImage(image);
      await this._diag("preprocess-done", tensor.shape.join("x"));

      this._setProgress(
        progress,
        68,
        `${prefix}${this._t("texlink-progress-recognizing", "Recognizing formula offline...")}`
      );
      // _ensureModelLoaded clears _activeProgress when it finishes; reattach it
      // before inference so Worker decode progress updates the same toast.
      this._activeProgress = progress;
      const maxNewTokens = this._maxNewTokens(this._getPref("maxNewTokens", 384));
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
        throw new Error(this._t(
          "texlink-error-empty-formula",
          "The model returned an empty formula; select a clearer formula image and try again"
        ));
      }

      const timestamp = new Date().toISOString();
      const entryId = this._entryIdFor(annotationItem.key, latex);
      const html = this._renderEntryHTML({
        latex,
        timestamp,
        entryId,
        stableId: annotationItem.key,
        source,
        comment: comment ? String(comment).slice(0, Number(this._getPref("maxCommentLength", 2000)) || 2000) : "",
        confidence: workerResult.confidence
      });

      this._setProgress(
        progress,
        92,
        `${prefix}${this._t("texlink-progress-writing", "Writing to Zotero note...")}`
      );
      await this._diag("note-write-start");
      const writeResult = await this._writeEntryToNote({
        html,
        entryId,
        annotationKey: annotationItem.key,
        source,
        timestamp,
        latex,
        replace
      });
      const noteItem = writeResult.noteItem;

      await this._diag(
        "note-write-done",
        `${noteItem?.id || "-"}${writeResult.duplicate ? " duplicate" : ""}${writeResult.replaced ? " replaced" : ""}`
      );
      // "Copy last ..." must reflect THIS recognition, even when it was a
      // duplicate or an in-place replacement. Remember the destination note
      // so copy/export still work after the focus moves away from the note.
      this._lastResult = this._makeClipboardResult(
        latex, source, timestamp, workerResult.confidence
      );
      this._lastResult.noteItem = noteItem;
      if (writeResult.duplicate) {
        return {
          latex,
          noteItem,
          annotationItem,
          source,
          timestamp,
          confidence: workerResult.confidence,
          elapsedMs: workerResult.elapsedMs,
          duplicate: true,
          replaced: false
        };
      }
      if (writeResult.replaced) {
        return {
          latex,
          noteItem,
          annotationItem,
          source,
          timestamp,
          confidence: workerResult.confidence,
          elapsedMs: workerResult.elapsedMs,
          duplicate: false,
          replaced: true
        };
      }
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
        elapsedMs: workerResult.elapsedMs,
        duplicate: false,
        replaced: false
      };
    }

    _maxNewTokens(value) {
      const configured = Number(value);
      return Math.min(
        512,
        Math.max(1, Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : 384)
      );
    }

    /**
     * Stable block ID for one annotation + LaTeX result. Re-running the same
     * recognition produces the same ID and allows duplicate suppression.
     */
    _entryIdFor(annotationKey, latex) {
      let hash = 2166136261;
      const text = String(latex || "");
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `${annotationKey}-${(hash >>> 0).toString(36)}`;
    }

    /**
     * Read the PNG data URL of a native image annotation.
     * Zotero.Annotations.toJSON() encodes the cached annotation image as
     * data:image/png;base64.
     */
    async _getAnnotationImage(annotationItem) {
      if (!annotationItem?.isAnnotationSupportingImage?.()) {
        throw new Error(this._t("texlink-error-no-image", "This annotation is not an image annotation."));
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
        lastError
          ? this._t(
            "texlink-error-cache-detail",
            `Could not read the local cache for this screenshot: ${lastError.message}. Make sure the annotation image is synced/saved locally.`,
            { detail: lastError.message }
          )
          : this._t(
            "texlink-error-cache",
            "Could not read the local cache for this screenshot. Make sure the annotation image is synced/saved locally."
          )
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
      if (!doc) {
        throw new Error(this._t(
          "texlink-error-main-window",
          "Could not obtain the Zotero main window for image preprocessing."
        ));
      }

      const image = await new Promise((resolve, reject) => {
        const img = new win.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(
          this._t("texlink-error-decode-image", "Could not decode the annotation image.")
        ));
        img.src = dataURL;
      });

      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error(this._t(
          "texlink-error-zero-image",
          "Annotation image has zero dimensions."
        ));
      }

      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error(this._t(
          "texlink-error-canvas",
          "Could not create a Canvas 2D context."
        ));
      }

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
        throw new Error(this._t(
          "texlink-error-no-attachment",
          "This annotation has no associated PDF attachment."
        ));
      }
      const regularItem = attachment.parentItem || null;
      if (!regularItem) {
        throw new Error(this._t(
          "texlink-error-no-parent",
          "This PDF has no parent item. Add the PDF as an attachment under a bibliographic item first so TexLink can anchor formulas to that item's note."
        ));
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
      const pageLabel = rawLabel || this._t(
        "texlink-note-page-fallback",
        `PDF page ${pageIndex + 1}`,
        { page: pageIndex + 1 }
      );

      const library = Zotero.Libraries.get(annotationItem.libraryID);
      const isGroup = library?.libraryType === "group";
      const prefix = isGroup ? `groups/${library.groupID}` : "library";
      const pdfLink = `zotero://open-pdf/${prefix}/items/${attachment.key}` +
        `?page=${pageIndex + 1}&annotation=${annotationItem.key}`;
      const itemLink = `zotero://select/${prefix}/items/${regularItem.key}`;
      const sourceTitle =
        regularItem.getField("title") ||
        attachment.getField("title") ||
        this._t("texlink-note-untitled", "Untitled item");

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
    _renderEntryHTML({ latex, timestamp, entryId, stableId, source, comment, confidence }) {
      let template = String(this._getPref("noteTemplate", "") || "").trim();
      if (
        !template ||
        !template.includes("{{latexRaw}}") ||
        !template.includes("{{pageLabel}}") ||
        /<\s*(script|iframe|object|embed|link|meta|style|form|input|button|textarea|select|video|audio|source|img)\b|on[a-z]+\s*=|javascript:|(?:src|href)\s*=\s*["'](?:https?:)?[\\/]{2}/i.test(template)
      ) {
        template = DEFAULT_NOTE_TEMPLATE;
      }

      const escapedLatex = this._escapeHTML(latex);
      const commentLabel = this._escapeHTML(
        this._t("texlink-note-label-comment", "Comment")
      );
      const commentBlock = comment
        ? `<p class="texlink-comment"><strong>${commentLabel}:</strong> ${this._escapeHTML(comment)}</p>`
        : "";

      // Low-confidence review is opt-in: default templates render exactly as
      // in 0.1.5, so existing notes and user templates are not disturbed.
      const hasConfidence = confidence !== "" && confidence !== null && confidence !== undefined;
      const numericConfidence = Number(confidence);
      const needsReview = !!this._getPref("showLowConfidenceHint", false) &&
        hasConfidence &&
        Number.isFinite(numericConfidence) &&
        numericConfidence < this._confidenceThreshold();
      const reviewBlock = needsReview
        ? `<p class="texlink-review" data-texlink-review="low">${this._escapeHTML(
            this._t("texlink-note-review-hint", "Needs review (low confidence)")
          )}</p>`
        : "";

      const values = {
        id: this._escapeHTML(entryId),
        stableId: this._escapeHTML(stableId || source.annotationKey || ""),
        annotationKey: this._escapeHTML(source.annotationKey || ""),
        latexRaw: escapedLatex,
        reviewBlock,
        anchorTitle: this._escapeHTML(
          this._t("texlink-note-anchor-title", "TexLink formula anchor")
        ),
        labelPage: this._escapeHTML(this._t("texlink-note-label-page", "Page")),
        labelExtracted: this._escapeHTML(
          this._t("texlink-note-label-extracted", "Extracted")
        ),
        labelSource: this._escapeHTML(this._t("texlink-note-label-source", "Source")),
        labelOpenPdf: this._escapeHTML(
          this._t("texlink-note-label-open-pdf", "Open in PDF")
        ),
        labelViewItem: this._escapeHTML(
          this._t("texlink-note-label-view-item", "View item")
        ),
        labelLatexSource: this._escapeHTML(
          this._t("texlink-note-label-latex-source", "LaTeX source")
        ),
        pageLabel: this._escapeHTML(source.pageLabel),
        timestamp: this._escapeHTML(timestamp),
        sourceTitle: this._escapeHTML(source.sourceTitle),
        pdfLink: this._escapeHTML(source.pdfLink),
        itemLink: this._escapeHTML(source.itemLink),
        confidence: (() => {
          if (confidence === "" || confidence === null || confidence === undefined) return "";
          const value = Number(confidence);
          return Number.isFinite(value) ? Math.max(0, Math.min(1, value)).toFixed(3) : "";
        })(),
        commentBlock
      };

      return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
      });
    }

    // ---------------- v1.0.0 note / clipboard helpers ----------------

    _confidenceThreshold() {
      const value = Number(this._getPref("confidenceThreshold", 0.7));
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7;
    }

    _confidenceIsLow(confidence) {
      // An absent confidence means "unknown", not zero. Marking it for review
      // would flag every legacy block that predates confidence reporting.
      if (confidence === "" || confidence === null || confidence === undefined) {
        return false;
      }
      const value = Number(confidence);
      return Number.isFinite(value) && value < this._confidenceThreshold();
    }

    _makeClipboardResult(latex, source, timestamp, confidence) {
      const clean = String(latex || "");
      return {
        latex: clean,
        inline: `$${clean}$`,
        block: `$$\n${clean}\n$$`,
        markdown: [
          `$$\n${clean}\n$$`,
          "",
          `> ${source?.sourceTitle || ""} · ${source?.pageLabel || ""}`,
          ""
        ].join("\n"),
        timestamp,
        confidence,
        source
      };
    }

    _unescapeHTML(value) {
      return String(value ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
    }

    _attrFromBlock(block, name) {
      const match = String(block || "").match(
        new RegExp(`${name}="([^"]*)"`, "i")
      );
      return match ? this._unescapeHTML(match[1]) : "";
    }

    /**
     * Read the LaTeX back out of a formula block. New blocks carry an escaped
     * data-texlink-latex attribute; 0.1.5 blocks are read from the KaTeX node
     * or the plain <pre> source, so both generations remain usable.
     */
    _extractLatexFromBlock(block) {
      const attribute = this._attrFromBlock(block, "data-texlink-latex");
      if (attribute) return attribute;
      const math = String(block || "").match(
        /<pre[^>]*class="math"[^>]*>([\s\S]*?)<\/pre>/i
      );
      if (math) {
        let text = this._unescapeHTML(
          math[1].replace(/<[^>]+>/g, "")
        ).trim();
        if (text.startsWith("$$") && text.endsWith("$$")) {
          text = text.slice(2, -2).trim();
        }
        else if (text.startsWith("$") && text.endsWith("$")) {
          text = text.slice(1, -1).trim();
        }
        if (text) return text;
      }
      const pres = String(block || "").match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi) || [];
      if (pres.length) {
        return this._unescapeHTML(
          pres[pres.length - 1].replace(/<[^>]*>/gi, "")
        ).trim();
      }
      return "";
    }

    /**
     * Locate a formula block by its stable annotation key, with fallbacks for
     * 0.1.5 notes (which have no data-texlink-id) and custom templates.
     */
    _findEntryBlockInHTML(html, annotationKey, entryId) {
      const source = String(html || "");
      const markers = [];
      if (annotationKey) {
        const key = this._escapeHTML(annotationKey);
        markers.push(`data-texlink-id="${key}"`);
        markers.push(`data-texlink-annotation="${key}"`);
      }
      if (entryId) markers.push(`data-texlink-entry="${this._escapeHTML(entryId)}"`);
      for (const marker of markers) {
        const at = source.indexOf(marker);
        if (at < 0) continue;
        const start = source.lastIndexOf("<blockquote", at);
        const end = source.indexOf("</blockquote>", at);
        if (start >= 0 && end > at) {
          return source.slice(start, end + "</blockquote>".length);
        }
      }
      return null;
    }

    _replaceEntryInHTML(html, oldBlock, newBlock) {
      const source = String(html || "");
      const at = source.indexOf(oldBlock);
      if (at < 0 || !oldBlock) return null;
      return source.slice(0, at) + newBlock + source.slice(at + oldBlock.length);
    }

    _extractCommentFromBlock(block) {
      const text = String(block || "");
      const match = text.match(
        /<p[^>]*class="texlink-comment"[^>]*>([\s\S]*?)<\/p>/i
      ) || text.match(
        /<p[^>]*>\s*<strong>[^<]*(?:Comment|备注)[^<]*<\/strong>\s*([\s\S]*?)<\/p>/i
      );
      if (!match) return "";
      // Drop the <strong> element INCLUDING its label text; stripping only the
      // tags used to turn "Comment: x" into "Comment: Comment: x" on replace.
      return this._unescapeHTML(
        match[1]
          .replace(/<strong\b[^>]*>[\s\S]*?<\/strong>/gi, "")
          .replace(/<[^>]+>/g, "")
          .trim()
      );
    }

    _collectFormulasFromHTML(html) {
      const blocks = String(html || "").match(
        /<blockquote\b[^>]*data-texlink-(?:id|annotation|entry)[^>]*>[\s\S]*?<\/blockquote>/gi
      ) || [];
      return blocks.map((block) => ({
        block,
        latex: this._extractLatexFromBlock(block),
        confidence: this._attrFromBlock(block, "data-texlink-confidence"),
        stableId:
          this._attrFromBlock(block, "data-texlink-id") ||
          this._attrFromBlock(block, "data-texlink-annotation") ||
          this._attrFromBlock(block, "data-texlink-entry")
      })).filter((entry) => !!entry.latex);
    }

    /**
     * Resolve where the note write should go:
     * - auto: prefer the currently open note belonging to the same item; otherwise the dedicated child note;
     * - active: ONLY the currently open note of this item; report an error when none is open;
     * - dedicated: always the dedicated child note.
     *
     * Auto and active were identical in 0.1.5 despite different labels in the
     * settings pane. They now behave as documented.
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
        if (active && active.noteItem?.isEditable?.()) {
          return { noteItem: active.noteItem, editorInstance: active.editorInstance, active: true };
        }
        if (mode === "active") {
          throw new Error(this._t(
            "texlink-error-no-active-note",
            "No editable open note belongs to this item. Open the item's note first or change the note destination setting."
          ));
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
        throw new Error(this._t(
          "texlink-error-readonly-library",
          "The library containing this item is read-only; cannot create or modify notes."
        ));
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

      let title;
      try {
        const hasCustomTitle = Zotero.Prefs.prefHasUserValue(
          `${PREF_PREFIX}.logNoteTitle`
        );
        title = hasCustomTitle
          ? String(this._getPref("logNoteTitle", DEFAULT_LOG_TITLE) || DEFAULT_LOG_TITLE)
          : this.getDefaultLogNoteTitle();
      }
      catch (error) {
        title = this.getDefaultLogNoteTitle();
      }
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
        `<p>${this._escapeHTML(this._t(
          "texlink-note-intro",
          "This note was created automatically by TexLink. Each formula block contains a local KaTeX preview, LaTeX source, page label, and ISO timestamp."
        ))}</p>` +
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
    async _writeEntryToNote({ html, entryId, annotationKey, source, timestamp, latex, replace = false }) {
      const target = await this._resolveNoteTarget(source.regularItem);
      const noteItem = target.noteItem;
      if (!noteItem?.isEditable?.()) {
        throw new Error(this._t(
          "texlink-error-target-readonly",
          "Target note is not editable (it may be in a read-only library or the trash)."
        ));
      }

      // Stable identity is the annotation key, not the LaTeX hash. A changed
      // recognition result is the SAME formula and must not create a second
      // block. Old 0.1.5 notes are matched by annotation or legacy entry id.
      const noteHTML = String(noteItem.getNote() || "");
      const existingBlock = this._findEntryBlockInHTML(noteHTML, annotationKey, entryId);
      const wantsReplace = replace ||
        String(this._getPref("duplicatePolicy", "skip")) === "replace";

      if (existingBlock && !wantsReplace) {
        this._log(`duplicate entry ${entryId}; skipping`);
        await this._diag("duplicate-skip", entryId);
        return { noteItem, duplicate: true, replaced: false };
      }
      if (existingBlock) {
        return this._replaceEntryBlock({
          noteItem,
          editorInstance: target.editorInstance,
          oldBlock: existingBlock,
          newHTML: html,
          annotationKey,
          entryId
        });
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
          return { noteItem, duplicate: false, replaced: false };
        }
      }

      await this._diag("append-direct-start");
      await this._appendEntryDirectly(noteItem, html);
      await this._diag("append-direct-done");
      return { noteItem, duplicate: false, replaced: false };
    }

    /**
     * Replace an existing block in place. The stable id stays the same, the
     * user's comment is preserved, and an open editor is updated through
     * Zotero's applyIncrementalUpdate() so unsaved typing is not discarded.
     */
    async _replaceEntryBlock({ noteItem, editorInstance, oldBlock, newHTML, annotationKey, entryId }) {
      await this._diag("replace-start", annotationKey);
      const savedComment = this._extractCommentFromBlock(oldBlock);
      let finalHTML = newHTML;
      // When the user supplied a fresh comment during re-recognition, the new
      // block already contains it; do not append the old one a second time.
      if (savedComment && !newHTML.includes('class="texlink-comment"')) {
        const label = this._escapeHTML(
          this._t("texlink-note-label-comment", "Comment")
        );
        const commentHTML =
          `<p class="texlink-comment"><strong>${label}:</strong> ` +
          `${this._escapeHTML(savedComment)}</p>`;
        finalHTML = newHTML.includes("</blockquote>")
          ? newHTML.replace("</blockquote>", `  ${commentHTML}\n</blockquote>`)
          : `${newHTML}${commentHTML}`;
      }

      // Flush any pending editor input before reading the note HTML.
      if (editorInstance && typeof editorInstance.saveSync === "function") {
        try { editorInstance.saveSync(); } catch (e) { /* best effort */ }
        await this._delay(200);
      }

      const current = String(noteItem.getNote() || "");
      // Re-locate after the flush: unsaved edits may have changed the block
      // text while keeping its stable id. Using the pre-flush snippet here
      // made every replacement fail when the note was open with edits.
      const freshBlock =
        this._findEntryBlockInHTML(current, annotationKey, entryId) || oldBlock;
      const next = this._replaceEntryInHTML(current, freshBlock, finalHTML);
      if (next === null) {
        // The note changed between lookup and write. Never overwrite it.
        throw new Error(this._t(
          "texlink-error-replace-stale",
          "The note changed while updating the formula. Please try again."
        ));
      }

      noteItem.setNote(next);
      await noteItem.saveTx({ skipSelect: true });

      if (editorInstance && typeof editorInstance.applyIncrementalUpdate === "function") {
        try {
          editorInstance.applyIncrementalUpdate({ html: next }, true);
        }
        catch (error) {
          this._log("applyIncrementalUpdate failed; reopen the note to see the update");
        }
      }

      await this._diag("replace-done", `${annotationKey || entryId}`);
      return { noteItem, duplicate: false, replaced: true };
    }

    _noteHasEntry(noteItem, entryId, annotationKey) {
      try {
        const html = String(noteItem.getNote() || "");
        if (annotationKey) {
          const key = this._escapeHTML(annotationKey);
          if (html.includes(`data-texlink-id="${key}"`)) return true;
          if (html.includes(`data-texlink-annotation="${key}"`)) return true;
        }
        return html.includes(`data-texlink-entry="${this._escapeHTML(entryId)}"`);
      }
      catch (error) {
        return false;
      }
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
    _newProgress(text, reader, options = {}) {
      try {
        const win = reader?._iframeWindow;
        const doc = win?.document;
        if (!doc?.body) return null;
        let el = doc.getElementById("texlink-toast");
        if (!el || !el.__texlinkText) {
          if (el) el.remove();
          el = doc.createElement("div");
          el.id = "texlink-toast";
          el.setAttribute("role", "status");
          el.style.cssText = [
            "position: fixed",
            "right: 20px",
            "bottom: 20px",
            "z-index: 2147483647",
            "display: flex",
            "align-items: center",
            "gap: 10px",
            "max-width: 460px",
            "padding: 10px 14px",
            "border-radius: 8px",
            "background: rgba(36, 36, 36, 0.94)",
            "color: #fff",
            "font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            "box-shadow: 0 6px 24px rgba(0,0,0,0.35)",
            "pointer-events: none",
            "opacity: 0",
            "transition: opacity 0.15s ease"
          ].join(";");
          const textEl = doc.createElement("span");
          textEl.style.cssText = "flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word;";
          const cancelButton = doc.createElement("button");
          cancelButton.type = "button";
          cancelButton.textContent = this._t("texlink-progress-cancel", "Cancel");
          cancelButton.style.cssText = [
            "pointer-events: auto",
            "border: 1px solid rgba(255,255,255,0.45)",
            "border-radius: 5px",
            "background: transparent",
            "color: #fff",
            "font: inherit",
            "padding: 2px 8px",
            "cursor: pointer",
            "display: none"
          ].join(";");
          el.appendChild(textEl);
          el.appendChild(cancelButton);
          el.__texlinkText = textEl;
          el.__texlinkCancel = cancelButton;
          doc.body.appendChild(el);
        }
        clearTimeout(el.__texlinkTimer);
        el.__texlinkText.textContent = text;
        el.style.background = "rgba(36, 36, 36, 0.94)";
        el.style.opacity = "1";
        const handle = { el, textEl: el.__texlinkText, cancelButton: el.__texlinkCancel };
        if (options.cancellable && typeof options.onCancel === "function") {
          handle.onCancel = options.onCancel;
          handle.cancelButton.style.display = "inline-block";
          handle.cancelButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const callback = handle.onCancel;
            handle.cancelButton.style.display = "none";
            if (callback) callback();
          };
        }
        else {
          handle.cancelButton.style.display = "none";
          handle.cancelButton.onclick = null;
        }
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
        if (text) progress.textEl.textContent = text;
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
        if (progress.cancelButton) progress.cancelButton.style.display = "none";
        clearTimeout(progress.el.__texlinkTimer);
        progress.el.__texlinkTimer = setTimeout(() => {
          try {
            if (progress.cancelButton) progress.cancelButton.style.display = "none";
            progress.el.style.opacity = "0";
          } catch (e) { /* dead doc */ }
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

    _cancelRecognition() {
      if (!this._busy) return;
      this._cancelRequested = true;
      const progress = this._activeProgress;
      const error = new Error("Recognition canceled");
      this._log("recognition canceled by user");
      this._diag("recognition-cancel-requested");
      this._abortWorker(error);
      this._setProgress(progress, null, this._t("texlink-progress-canceled", "Canceled"), true);
      this._closeProgress(progress, 1500);
    }

    _showError(error, reader = null) {
      const message = String(
        error?.message || error || this._t("texlink-error-unknown", "Unknown error")
      );
      this._logError("user-visible error", error);
      this._diag("show-error", message);
      const progress = this._newProgress(message, reader);
      if (progress) {
        this._setProgress(progress, null, message, true);
        this._closeProgress(progress, 10000);
        return;
      }
      this._showFallbackError(message);
    }

    /**
     * No-reader errors cannot use the Reader toast. Show a deferred native
     * progress window from the main Zotero window only; reader context-menu
     * commands always have a reader and continue to use the in-reader toast.
     */
    _showFallbackError(message) {
      setTimeout(() => {
        try {
          if (this._fallbackErrorWindow) {
            try { this._fallbackErrorWindow.close(); } catch (e) { /* noop */ }
            this._fallbackErrorWindow = null;
          }
          const progress = new Zotero.ProgressWindow({ closeOnClick: true });
          progress.changeHeadline("TexLink");
          progress.progress = new progress.ItemProgress("note", message);
          progress.progress.setError();
          progress.show();
          progress.startCloseTimer(10000);
          this._fallbackErrorWindow = progress;
          setTimeout(() => {
            if (this._fallbackErrorWindow === progress) {
              this._fallbackErrorWindow = null;
            }
          }, 11000);
        }
        catch (error) {
          this._logError("Failed to show fallback error window", error);
        }
      }, 0);
    }

    // ===================== Copy / export / review commands =====================

    /** The note currently open in the context pane or a note tab. */
    _getActiveNoteItem() {
      try {
        const win = Zotero.getMainWindow();
        const instance = win?.ZoteroContextPane?.activeEditor?.getCurrentInstance?.();
        if (instance?._item?.isNote?.()) {
          return { noteItem: instance._item, editorInstance: instance };
        }
        for (const editor of Zotero.Notes?._editorInstances || []) {
          if (!editor?._item?.isNote?.()) continue;
          if (
            editor.tabID === win?.Zotero_Tabs?.selectedID ||
            editor._iframeWindow === win?.document?.activeElement?.contentWindow
          ) {
            return { noteItem: editor._item, editorInstance: editor };
          }
        }
      }
      catch (error) {
        this._log(`active note lookup failed: ${error.message}`);
      }
      return null;
    }

    _copyToClipboard(text) {
      const value = String(text ?? "");
      if (!value) {
        throw new Error(this._t("texlink-error-nothing-to-copy", "There is nothing to copy yet."));
      }
      const helper = Components.classes[
        "@mozilla.org/widget/clipboardhelper;1"
      ].getService(Components.interfaces.nsIClipboardHelper);
      helper.copyString(value);
      return value;
    }

    /** Brief success feedback without an extra settings window. */
    _notify(message) {
      const progress = this._newProgress(message, this._getActiveReader());
      if (progress) {
        this._setProgress(progress, null, message);
        this._closeProgress(progress, 2600);
        return;
      }
      setTimeout(() => {
        try {
          const window = new Zotero.ProgressWindow({ closeOnClick: true });
          window.changeHeadline("TexLink");
          window.progress = new window.ItemProgress("note", message);
          window.show();
          window.startCloseTimer(2600);
        }
        catch (error) {
          this._log(`status notification failed: ${error.message}`);
        }
      }, 0);
    }

    _copyLastResult(kind) {
      const last = this._lastResult;
      if (!last) {
        throw new Error(this._t(
          "texlink-error-no-last-result",
          "Recognize a formula first; then you can copy it."
        ));
      }
      let text = last.markdown;
      let key = "texlink-status-copied";
      let fallback = "Copied to clipboard.";
      if (kind === "latex") {
        text = last.latex;
        key = "texlink-status-copied-latex";
        fallback = "LaTeX copied to clipboard.";
      }
      else if (kind === "inline") {
        text = last.inline;
        key = "texlink-status-copied-inline";
        fallback = "Inline formula copied to clipboard.";
      }
      else if (kind === "block") {
        text = last.block;
      }
      this._copyToClipboard(text);
      this._notify(this._t(key, fallback));
    }

    _requireActiveFormulas() {
      let active = this._getActiveNoteItem();
      if (!active) {
        // The most common workflow is: recognize from the PDF, then use Tools
        // without returning focus to the note. Fall back to the note that just
        // received the formula instead of showing a spurious error.
        const noteItem = this._lastResult?.noteItem;
        if (noteItem && typeof noteItem.getNote === "function" && !noteItem.deleted) {
          active = {
            noteItem,
            editorInstance: this._findEditorForNote(noteItem)
          };
        }
      }
      if (!active) {
        throw new Error(this._t(
          "texlink-error-no-note",
          "Open a Zotero note first, then use the copy or export command."
        ));
      }
      const entries = this._collectFormulasFromHTML(
        String(active.noteItem.getNote() || "")
      );
      if (!entries.length) {
        throw new Error(this._t(
          "texlink-error-no-formulas",
          "This note does not contain any TexLink formula blocks yet."
        ));
      }
      return { active, entries };
    }

    _copyAllFormulas() {
      const { entries } = this._requireActiveFormulas();
      const output = entries.map((entry, index) => [
        `## ${index + 1} · ${entry.stableId}`,
        "",
        `$$\n${entry.latex}\n$$`,
        entry.confidence
          ? `_${this._t("texlink-note-label-confidence", "Confidence")}: ${entry.confidence}_`
          : "",
        ""
      ].join("\n")).join("\n");
      this._copyToClipboard(output);
      this._notify(this._t(
        "texlink-status-copied-all",
        `Copied ${entries.length} formulas to clipboard.`,
        { count: entries.length }
      ));
    }

    _copyReviewList() {
      const { entries } = this._requireActiveFormulas();
      const low = entries.filter((entry) => this._confidenceIsLow(entry.confidence));
      if (!low.length) {
        this._notify(this._t(
          "texlink-status-no-review",
          "No low-confidence formulas in this note."
        ));
        return;
      }
      const confidenceLabel = this._t(
        "texlink-note-label-confidence",
        "Confidence"
      );
      const output = low.map((entry, index) => [
        `## ${index + 1} · ${entry.stableId}`,
        `$$\n${entry.latex}\n$$`,
        ` ${confidenceLabel}: ${entry.confidence}`,
        ""
      ].join("\n")).join("\n");
      this._copyToClipboard(output);
      this._notify(this._t(
        "texlink-status-copied-review",
        `Copied ${low.length} formulas that need review.`,
        { count: low.length }
      ));
    }

    async _replaceSelectedFromTools() {
      const reader = this._getActiveReader();
      if (!reader) {
        throw new Error(this._t(
          "texlink-error-open-pdf",
          "Open a PDF and select a formula with the image annotation tool first. TexLink does not read the clipboard or upload images."
        ));
      }
      const items = this._getSelectedImageAnnotations(reader);
      if (items.length !== 1) {
        throw new Error(this._t(
          "texlink-error-select-one",
          "Select exactly one formula screenshot in the PDF to replace."
        ));
      }
      if (!this._annotationHasEntry(items[0])) {
        throw new Error(this._t(
          "texlink-error-no-entry-to-replace",
          "This screenshot has no TexLink formula block yet. Use Recognize Formula and Add to Note first."
        ));
      }
      return this._recognizeAnnotationItems(items, reader, null, { replace: true });
    }

    async _promptComment() {
      try {
        const win = Zotero.getMainWindow();
        if (!win) return "";
        const value = { value: "" };
        const accepted = Services.prompt.prompt(
          win,
          this._t("texlink-prompt-title", "TexLink Comment"),
          this._t(
            "texlink-prompt-message",
            "Optional comment (leave blank to skip; Cancel aborts this recognition):"
          ),
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
