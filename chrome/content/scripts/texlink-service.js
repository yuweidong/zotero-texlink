/*
 * TexLink 核心服务
 * ================
 *
 * 这个文件由 bootstrap.js 通过 Services.scriptloader.loadSubScript 载入
 * 插件专属的 Chrome 沙箱。它不直接依赖任何构建工具，所有运行期逻辑都在
 * Zotero 10 内完成：
 *
 *   原生图片注释（截图）
 *        -> Zotero.Annotations.toJSON() 读取本地图片缓存
 *        -> Canvas 缩放/归一化（主线程，图像很小）
 *        -> Web Worker + onnxruntime-web + INT8 ONNX 推理
 *        -> 纯 JS BPE 解码 LaTeX
 *        -> Zotero.Item（note）写入带页码/时间戳/源码/原生 KaTeX 预览的 HTML 块
 *
 * 重要设计说明（详见 README 与 docs）：
 * 1. Zotero 10 没有 Zotero.Notes.create() 这个 API。新建笔记使用
 *    new Zotero.Item("note") + setNote() + saveTx()。
 * 2. Zotero 10 的笔记编辑器原生支持 KaTeX 数学节点：
 *    块级公式写成 <pre class="math">$$...$$</pre>，
 *    行内公式写成 <span class="math">$...$</span>。
 *    因此不需要也不应该把 MathJax 的 <script> 塞进笔记。
 * 3. 输入使用 Zotero 自己的“区域图像注释”作为截图事件，
 *    这样页码、附件、注释 key 都由 Zotero 保证，避免自己解析 PDF 坐标。
 *    同时监听 Notifier，可在用户开启时自动处理新截图。
 * 4. 对 Zotero.Reader 的少数内部字段（_readers/_iframeWindow/_primaryView/
 *    _state.selectedAnnotationIDs）做了存在性保护；如果未来 Zotero 版本改变，
 *    菜单里的“识别选中的公式截图”仍能工作，只是不得不在 PDF 中重新选中注释。
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
  const DEFAULT_LOG_TITLE = "TexLink 公式摘录";

  // 服务内部默认模板。prefs.js 中还有一份供用户修改的副本；
  // 若用户模板被清空/破坏，回退到这里，确保核心字段不丢。
  const DEFAULT_NOTE_TEMPLATE = [
    '<blockquote data-texlink-entry="{{id}}" data-texlink-annotation="{{annotationKey}}">',
    '  <h3>TexLink 公式锚点</h3>',
    '  <pre class="math">$${{latexRaw}}$$</pre>',
    '  <p><strong>页码：</strong>{{pageLabel}}　<strong>提取时间：</strong>{{timestamp}}</p>',
    '  <p><strong>来源：</strong>{{sourceTitle}} · <a href="{{pdfLink}}">在 PDF 中定位</a> · <a href="{{itemLink}}">查看文献条目</a></p>',
    '  {{commentBlock}}',
    '  <p><strong>LaTeX 源码：</strong></p>',
    '  <pre>{{latexRaw}}</pre>',
    '</blockquote>'
  ].join("\n");

  /**
   * ByteLevel BPE 解码器。
   *
   * Pix2Text-MFR 的 tokenizer.json 是 HuggingFace tokenizers 的 BPE 结构：
   *   model.vocab: token -> id
   *   decoder.type: ByteLevel
   *
   * ByteLevel 的关键不是简单的 token 拼接：GPT-2 风格的 token 字符串把字节
   * 映射成了可打印 Unicode（例如空格 -> "Ġ"）。正确做法是：
   *   1. 把每个 token 的每个字符映射回原始字节；
   *   2. 把所有字节拼成一个连续 Uint8Array；
   *   3. 最后整体做 UTF-8 解码。
   *
   * 不能对单个 token 分别做 UTF-8 解码：一个中文字符/数学符号可能被拆到
   * 相邻 token 中，分别解码会产生替换字符 U+FFFD。
   */
  class TexLinkBPEDecoder {
    constructor(tokenizerJSON) {
      if (!tokenizerJSON || typeof tokenizerJSON !== "object") {
        throw new Error("tokenizer.json 格式无效");
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

    /** 构造 GPT-2 ByteLevel 的 Unicode 字符 -> 字节映射。 */
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

    /** 递归识别 decoder 链中是否包含 ByteLevel。 */
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

    /** 跳过特殊 token 并取出文本 token。 */
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
     * ByteLevel 解码。
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
          // 兼容 tokenizer 中可能保留的字节回退标记 <0xAB>。
          if (/^<0x[0-9a-fA-F]{2}>$/.test(token)) {
            bytes.push(parseInt(token.slice(3, 5), 16));
            continue;
          }
          for (const ch of token) {
            const byte = this._byteMap.get(ch);
            if (byte === undefined) {
              // 极少数 added token / 非 ByteLevel 字符：按 UTF-8 原样写回。
              pushUTF8(ch);
            }
            else {
              bytes.push(byte);
            }
          }
        }
        return this._postProcess(this._decoder.decode(Uint8Array.from(bytes)));
      }

      // SentencePiece / Metaspace / WordPiece 的常见情况：
      // 目前不用于默认模型，但保留给 UniMERNet 等其它 tokenizer 作为扩展点。
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
     * 只做确定性的、不会改变 LaTeX 语义的清理：
     * - 去掉 BOM/控制字符；
     * - 去掉模型偶尔输出的 Markdown 代码围栏；
     * - 去掉整体包裹的 $ / $$（math 节点会自己加）；
     * - 折叠换行与首尾空白。
     *
     * 不做“自动补全括号”“改写命令”等任何猜测性操作。
     */
    _postProcess(text) {
      let output = String(text || "")
        .replace(/^\uFEFF/, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/\r\n?/g, "\n")
        .trim();

      // 防御性兼容：模型若返回 ```latex ... ```，只剥掉围栏。
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

      // 仅把连续换行压缩成空格；不压缩普通空格，避免破坏 \text{...}。
      output = output.replace(/\n+/g, " ").trim();
      return output;
    }
  }

  class Service {
    constructor(options = {}) {
      this.id = options.id || PLUGIN_ID;
      this.version = options.version || "0.1.1";
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

      // 主窗口 -> 清理函数集合。用 Map 而不是 WeakMap，便于 shutdown 时遍历。
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

    // ===================== 生命周期 =====================

    async startup() {
      if (this._started) return;
      this._started = true;

      // 等待主窗口 UI 就绪；不等待会拿不到 Zotero.Reader、ZoteroContextPane。
      await Zotero.uiReadyPromise;

      if (!this._getPref("enabled", true)) {
        this._log("disabled by preference");
        return;
      }

      // 先加载模型元数据和 tokenizer。即使模型资源损坏，也不阻断安装/启动；
      // 用户触发识别时再给出明确错误。
      try {
        this._modelConfig = await this._readJSON(
          `${this.chromeBase}models/texlink-model.json`
        );
        const tokenizerJSON = await this._readJSON(
          `${this.chromeBase}models/${this._modelConfig.files.tokenizer}`
        );
        this._tokenizer = new TexLinkBPEDecoder(tokenizerJSON);
        this._log(`model metadata loaded: ${this._modelConfig.displayName}`);
      }
      catch (error) {
        this._modelError = error;
        this._logError("Failed to load model metadata/tokenizer", error);
      }

      // 只创建 Worker 壳子；真正的 ORT 和 ONNX 加载在 _ensureModelLoaded()。
      try {
        this._createWorker();
      }
      catch (error) {
        this._modelError = this._modelError || error;
        this._logError("Failed to create ONNX Worker", error);
      }

      this._registerReaderContextMenu();
      this._registerNotifier();

      // 插件在已有窗口中启用时，Zotero 不一定会补发 onMainWindowLoad，
      // 因此主动遍历一次；bootstrap 的窗口回调会去重。
      for (const win of Zotero.getMainWindows()) {
        await this.onMainWindowLoad(win);
      }

      // 低频兜底轮询：Zotero 10 没有公开的“reader 创建”回调，
      // 这样即使没有触发某个内部事件，新打开的 PDF 也能绑定快捷键。
      this._readerPollTimer = setInterval(() => {
        if (!this._destroyed) this._bindAllReaders();
      }, 4000);

      // 模型预热。默认开启：Worker 内加载 ORT/ONNX，不阻塞 UI。
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

      // 每次主窗口出现时尝试绑定一次已存在的 reader。
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

      // 拒绝所有挂起请求，再终止 Worker，避免主线程有永远 pending 的 Promise。
      const error = new Error("TexLink 已关闭");
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

    // ===================== 首选项与日志 =====================

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

    // ===================== 内部资源读取 =====================

    /**
     * 读取 chrome:// 内部文本资源。优先 XHR，失败时回退 fetch。
     * 不允许传入 http(s) URL —— 这是 TexLink 的离线硬约束。
     */
    async _readText(url) {
      if (!String(url).startsWith("chrome://")) {
        throw new Error(`拒绝读取非内部资源：${url}`);
      }
      try {
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.responseType = "text";
          xhr.onload = () => {
            const ok = (xhr.status >= 200 && xhr.status < 300) || xhr.status === 0;
            if (!ok) {
              reject(new Error(`无法读取 ${url}（HTTP ${xhr.status}）`));
              return;
            }
            resolve(String(xhr.responseText ?? xhr.response ?? ""));
          };
          xhr.onerror = () => reject(new Error(`XHR 读取失败：${url}`));
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
            `无法读取内部资源 ${url}：${xhrError.message} / ${fetchError.message}`
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
        throw new Error(`JSON 解析失败 ${url}：${error.message}`);
      }
    }

    // ===================== Web Worker 通信 =====================

    _createWorker() {
      if (this._worker) return this._worker;
      if (!String(this.chromeBase).startsWith("chrome://")) {
        throw new Error("chrome:// 资源映射未注册，无法启动推理 Worker");
      }
      const workerURL = `${this.chromeBase}scripts/worker.js`;
      this._worker = new Worker(workerURL);

      this._worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data || {});
      };
      this._worker.onerror = (event) => {
        const message = event?.message || "Worker 脚本执行失败";
        const error = new Error(message);
        this._modelError = this._modelError || error;
        this._modelReady = false;
        this._rejectAllPending(error);
        this._logError("Worker error", error);
        this._setProgress(this._activeProgress, null, `推理线程错误：${message}`, true);
      };
      this._worker.onmessageerror = () => {
        const error = new Error("Worker 消息反序列化失败");
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
     * 向 Worker 发一条带 requestId 的请求并等待对应响应。
     *
     * 通过 Transferable 把 Float32Array 的底层 ArrayBuffer 零拷贝转给 Worker；
     * 主线程随后不应再访问该 buffer。
     */
    _workerRequest(type, payload, transfer, timeoutMs = WORKER_RECOGNITION_TIMEOUT) {
      if (!this._worker) {
        return Promise.reject(new Error("推理 Worker 未初始化"));
      }
      const requestId = ++this._requestSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this._pending.get(requestId);
          if (!pending) return;
          this._pending.delete(requestId);
          reject(new Error(`Worker 请求超时：${type}`));
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
          const error = new Error(message.error?.message || "Worker 执行失败");
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
      this._setProgress(this._activeProgress, percent, message.text || "正在处理…");
    }

    /**
     * 确保 Worker 已加载 ORT 和两个 ONNX Session。
     * 多次调用共享同一个 promise，避免重复加载 31MB 模型。
     */
    async _ensureModelLoaded(progress) {
      if (this._modelReady) return;
      if (this._modelError) {
        throw new Error(`模型加载失败：${this._modelError.message || this._modelError}`);
      }
      if (!this._modelConfig || !this._tokenizer) {
        throw new Error("模型配置或 tokenizer 尚未加载");
      }
      if (!this._worker) this._createWorker();

      if (!this._modelInitPromise) {
        this._activeProgress = progress || this._activeProgress;
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

    // ===================== 阅读器菜单 / 快捷键 / Notifier =====================

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

          // 该 API 要求 append 同步执行；不要在 append 前 await。
          append({
            label: items.length > 1
              ? `TexLink：识别 ${items.length} 个公式截图并写入笔记`
              : "TexLink：识别公式并写入笔记",
            onCommand: () => {
              this._recognizeAnnotationItems(items, reader).catch((error) => {
                this._logError("context menu recognition failed", error);
                this._showError(error);
              });
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
     * 从 Reader 的 context menu / selection 参数中解析出注释 item。
     * params.ids 是 annotation item key（不是数据库 id）。
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

    /** 获取当前选中的图片注释（用于快捷键 / Tools 菜单）。 */
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

      // 兼容：部分 reader 视图只暴露 getSelectedAnnotations()。
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
        // 清理已经销毁的 iframe 引用。
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
     * 把快捷键监听器挂到 reader 外层窗口和 PDF 内部 iframe。
     * 之所以要挂两层：焦点通常在 PDF.js 的内层 iframe，事件不会冒泡到主窗口。
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

      // PDF 视图可能比 reader 外壳晚初始化；仅对每个 reader 补两次。
      // 注意：_bindAllReaders() 每 4 秒会调用本方法；如果不做一次性标记，
      // 每次补绑都会再安排两个定时器，最终造成定时器数量指数增长。
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
        this._showError(new Error("TexLink 正在处理上一条公式，请稍候。"));
        return;
      }
      this.recognizeFromReader(reader).catch((error) => this._showError(error));
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
     * 解析 extensions.zotero.texlink.shortcut。
     * 支持 accel / ctrl / control / cmd / command / meta / alt / option / shift，
     * 最后一项为按键（例如 L 或 KeyL）。
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
        // 不硬依赖 selectedType：只要选中的 tab ID 能映射到 Reader，
        // 就认为用户正在阅读 PDF。
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

              // 让 Zotero 先完成图片缓存落盘，再读取注释图片。
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

    // ===================== 工具菜单 =====================

    /**
     * 在 Tools 菜单末尾加一项。
     *
     * Zotero.MenuManager 是更“官方”的替代方案，但它只接受 l10nID（
     * l10nID -> Fluent .label），而本 V0.1 采用中文硬编码、零 l10n 依赖。
     * 这里直接操作 Zotero 自己的 XUL DOM，并在窗口卸载时精确移除，
     * 不修改任何 Zotero 原有节点。
     */
    _installToolsMenu(win, cleanups) {
      const doc = win?.document;
      const popup = doc?.getElementById("menu_ToolsPopup");
      if (!popup) return;

      // 插件重载时可能残留旧节点，先移除。
      doc.getElementById("texlink-tools-separator")?.remove();
      doc.getElementById("texlink-tools-menuitem")?.remove();

      const separator = doc.createXULElement("menuseparator");
      separator.id = "texlink-tools-separator";

      const menuitem = doc.createXULElement("menuitem");
      menuitem.id = "texlink-tools-menuitem";
      menuitem.setAttribute("label", "TexLink：识别选中的公式截图");
      menuitem.setAttribute(
        "tooltiptext",
        "先在 PDF 中用图像注释框选公式并选中，再点击这里或按快捷键。"
      );

      const handler = () => {
        this.recognizeFromActiveReader()
          .catch((error) => this._showError(error));
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

    // ===================== 用户触发入口 =====================

    async recognizeFromActiveReader() {
      const reader = this._getActiveReader();
      if (!reader) {
        this._showError(new Error(
          "请先打开一篇 PDF，并用图像注释工具框选公式。TexLink 不会读取剪贴板，也不会上传图片。"
        ));
        return [];
      }
      return this.recognizeFromReader(reader);
    }

    async recognizeFromReader(reader) {
      if (this._busy) {
        this._showError(new Error("TexLink 正在处理上一条公式，请稍候。"));
        return [];
      }
      const items = this._getSelectedImageAnnotations(reader);
      if (!items.length) {
        this._showError(new Error(
          "没有检测到选中的图像注释。请在 Zotero PDF 阅读器中选择“区域图像”工具，框选公式，再选中该截图后重试。"
        ));
        return [];
      }
      return this._recognizeAnnotationItems(items, reader);
    }

    /**
     * 识别一组图片注释，并把每条结果作为独立 blockquote 写入笔记。
     *
     * @param {Zotero.Item[]} annotationItems
     * @param {object|null} reader
     * @param {string|null} comment 可选备注
     * @param {{auto?: boolean}} options
     */
    async _recognizeAnnotationItems(annotationItems, reader, comment = null, options = {}) {
      if (this._destroyed) return [];
      if (!Array.isArray(annotationItems) || !annotationItems.length) return [];
      if (this._busy) {
        if (!options.auto) {
          this._showError(new Error("TexLink 正在处理上一条公式，请稍候。"));
        }
        return [];
      }
      if (!this._modelConfig || !this._tokenizer) {
        this._showError(new Error("公式模型/tokenizer 未加载，无法识别。请重新安装完整的 TexLink.xpi。"));
        return [];
      }

      this._busy = true;
      const progress = this._newProgress("准备识别公式…");
      this._activeProgress = progress;
      const results = [];
      const failures = [];

      try {
        let effectiveComment = comment;
        if (!options.auto && this._getPref("promptForComment", false)) {
          effectiveComment = await this._promptComment();
          if (effectiveComment === null) {
            this._setProgress(progress, 100, "已取消");
            this._closeProgress(progress, 1000);
            return [];
          }
        }

        this._setProgress(progress, 12, "正在加载离线模型…");
        await this._ensureModelLoaded(progress);

        for (let index = 0; index < annotationItems.length; index++) {
          const item = annotationItems[index];
          const prefix = annotationItems.length > 1
            ? `[${index + 1}/${annotationItems.length}] `
            : "";
          try {
            this._setProgress(progress, 60, `${prefix}正在读取截图并推理…`);
            const result = await this._recognizeSingle(item, reader, effectiveComment, progress, prefix);
            results.push(result);
          }
          catch (error) {
            failures.push({ item, error });
            this._logError(`recognition failed for annotation ${item?.key}`, error);
          }
        }

        if (results.length) {
          const failureText = failures.length
            ? `，${failures.length} 条失败，详见 Zotero 调试输出`
            : "";
          this._setProgress(
            progress,
            100,
            `已写入 ${results.length} 条公式到 Zotero 笔记${failureText}`
          );
          this._closeProgress(progress, failures.length ? 10000 : 5000);
        }
        else {
          const first = failures[0]?.error;
          this._setProgress(
            progress,
            null,
            `识别失败：${first?.message || "未知错误"}`,
            true
          );
          this._closeProgress(progress, 10000);
        }
        return results;
      }
      catch (error) {
        this._setProgress(progress, null, `TexLink 失败：${error.message || error}`, true);
        this._closeProgress(progress, 10000);
        this._logError("recognition pipeline failed", error);
        return results;
      }
      finally {
        this._busy = false;
        if (this._activeProgress === progress) this._activeProgress = null;
      }
    }

    // ===================== 单条识别 =====================

    async _recognizeSingle(annotationItem, reader, comment, progress, prefix = "") {
      const source = this._buildSourceContext(annotationItem, reader);
      const image = await this._getAnnotationImage(annotationItem);

      this._setProgress(progress, 64, `${prefix}正在预处理图像…`);
      const tensor = await this._preprocessImage(image);

      this._setProgress(progress, 68, `${prefix}正在离线识别公式…`);
      // _ensureModelLoaded 结束时会把 _activeProgress 置空；开始推理前重新挂上，
      // 这样 Worker 的解码进度才能继续更新同一个进度窗口。
      this._activeProgress = progress;
      const maxNewTokens = Number(this._getPref("maxNewTokens", 384)) || 384;
      const workerResult = await this._workerRequest(
        "recognize",
        {
          tensor: tensor.buffer,
          maxNewTokens
        },
        [tensor.buffer],
        WORKER_RECOGNITION_TIMEOUT
      );

      const latex = this._tokenizer.decode(workerResult.tokenIds || []);
      if (!latex) {
        throw new Error("模型返回了空公式，请重新框选更清晰的公式图片");
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

      this._setProgress(progress, 92, `${prefix}正在写入 Zotero 笔记…`);
      const noteItem = await this._writeEntryToNote({
        html,
        entryId,
        source,
        timestamp,
        latex
      });

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
     * 读取原生图片注释的 PNG data URL。
     * Zotero.Annotations.toJSON() 会把注释缓存图片编码为 data:image/png;base64。
     */
    async _getAnnotationImage(annotationItem) {
      if (!annotationItem?.isAnnotationSupportingImage?.()) {
        throw new Error("该注释不是图像注释");
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
        // 新截图的缓存文件可能比 Notifier 事件晚几十毫秒落盘。
        await this._delay(250);
      }
      throw new Error(
        `无法读取该截图的本地缓存${lastError ? `：${lastError.message}` : ""}。请确认注释图片已同步/保存到本地。`
      );
    }

    /**
     * Canvas 预处理：
     *   - 透明背景铺白；
     *   - 缩放到模型要求的 384 × 384（与 DeiTImageProcessor 的 resize 对齐）；
     *   - 可选 Otsu 二值化（默认关闭）；
     *   - RGB 归一化：[0,1] 后用 mean=0.5,std=0.5 转为 [-1,1]；
     *   - 排成 CHW float32。
     *
     * 该函数在主线程执行，但只处理一张 384×384 小图，耗时毫秒级；
     * 真正的重计算在 Worker 内。
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
      if (!doc) throw new Error("无法获得 Zotero 主窗口用于图像预处理");

      const image = await new Promise((resolve, reject) => {
        const img = new win.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("无法解码注释图片"));
        img.src = dataURL;
      });

      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error("注释图片尺寸为 0");
      }

      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("无法创建 Canvas 2D 上下文");

      // 透明背景必须铺白，否则透明像素会变成 [0,0,0]，模型会把空白当成墨迹。
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      try {
        ctx.imageSmoothingQuality = "high";
      }
      catch (error) { /* 某些平台不支持，忽略 */ }
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
     * 纯 JS Otsu 阈值二值化（默认不启用）。
     * 只把灰度低于阈值的像素涂黑，其余涂白；alpha 设为 255。
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

    // ===================== 笔记目标与写入 =====================

    /**
     * 从注释推导文献/附件/页码/可点击链接。
     * 页码优先使用 annotationPageLabel（PDF 中可能显示为 "iv" 或 "12"）；
     * 若为空，则回退到 position.pageIndex + 1（PDF 物理页码）。
     */
    _buildSourceContext(annotationItem, reader) {
      const attachment = annotationItem?.parentItem || reader?._item;
      if (!attachment) {
        throw new Error("该注释没有关联的 PDF 附件");
      }
      const regularItem = attachment.parentItem || null;
      if (!regularItem) {
        throw new Error(
          "该 PDF 没有父级文献条目。请先把 PDF 作为附件添加到文献条目下，TexLink 才能把公式锚定到文献笔记。"
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
      const pageLabel = rawLabel || `PDF 第 ${pageIndex + 1} 页`;

      const library = Zotero.Libraries.get(annotationItem.libraryID);
      const isGroup = library?.libraryType === "group";
      const prefix = isGroup ? `groups/${library.groupID}` : "library";
      const pdfLink = `zotero://open-pdf/${prefix}/items/${attachment.key}` +
        `?page=${pageIndex + 1}&annotation=${annotationItem.key}`;
      const itemLink = `zotero://select/${prefix}/items/${regularItem.key}`;
      const sourceTitle = regularItem.getField("title") || attachment.getField("title") || "未命名文献";

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
     * 渲染一条独立公式块。
     * 注意 <pre class="math"> 是 Zotero 10 笔记编辑器的原生数学节点语法，
     * 会由内置 KaTeX 渲染；下面相同 LaTeX 又放入普通 <pre> 作为可搜索源码。
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
        ? `<p><strong>备注：</strong>${this._escapeHTML(comment)}</p>`
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
     * 解析笔记落点：
     * - auto: 当前打开的、属于同一文献的笔记优先；否则专用子笔记；
     * - active: 同 auto，但若当前没有同一文献的笔记，回退专用子笔记；
     * - dedicated: 总是专用子笔记。
     *
     * 同时找出目标笔记是否已在某个 note editor 中打开。若已打开，
     * 不能直接用 item.setNote 覆盖（会丢掉编辑器里尚未保存的输入），
     * 而应该通过编辑器内部 insertHTML 动作插入。
     */
    async _resolveNoteTarget(sourceItem, preferredNote) {
      const mode = String(this._getPref("noteTarget", "auto"));
      if (mode !== "dedicated" && !preferredNote) {
        const active = this._findActiveEditorForSource(sourceItem);
        // 只读笔记（例如组库同步的只读笔记）不能写；自动回退到专用子笔记。
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

        // 1) 右侧上下文面板中的当前笔记编辑器
        const contextNoteEditor = win.ZoteroContextPane?.activeEditor;
        const contextInstance = contextNoteEditor?.getCurrentInstance?.();
        if (this._isNoteOfItem(contextInstance, sourceItem)) {
          return {
            editorInstance: contextInstance,
            noteItem: contextInstance._item
          };
        }

        // 2) 笔记标签页 / 独立笔记窗口。Zotero.Notes._editorInstances 是内部数组，
        //    这里只读且做完整保护；若未来重命名，自动退回 dedicated 模式。
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
     * 查找或创建本条目专属的“TexLink 公式摘录”子笔记。
     * 用标签定位，而不是依赖用户可能修改的标题。
     */
    async _findOrCreateLogNote(sourceItem) {
      const library = Zotero.Libraries.get(sourceItem.libraryID);
      if (!library?.editable) {
        throw new Error("当前文献所在库为只读库，无法创建或修改笔记");
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
       * 这里直接采用 Zotero 10 的内部 schema 容器。
       * 块级数学节点语法是 <pre class="math">$$...$$</pre>。
       * 不写 <script>、不依赖外部样式，Zotero 笔记编辑器会原生解析。
       */
      note.setNote(
        `<div data-schema-version="${NOTE_SCHEMA_VERSION}">` +
        `<h2>${this._escapeHTML(title)}</h2>` +
        `<p>本笔记由 TexLink 自动创建。每个公式块都包含本地 KaTeX 预览、LaTeX 源码、页码与 ISO 时间戳。</p>` +
        `</div>`
      );
      note.setTags([{ tag }]);
      await note.saveTx({ skipSelect: true });
      this._log(`created log note ${note.id} for item ${sourceItem.id}`);
      return note;
    }

    /**
     * 写入一条公式块。
     *
     * 两种路径：
     * A. 笔记已在编辑器中打开：通过编辑器内部消息 insertHTML 插入，避免
     *    覆盖尚未落盘的编辑内容。改动作会由编辑器自身在约 1 秒后保存。
     * B. 笔记未打开：直接 item.setNote + saveTx。
     */
    async _writeEntryToNote({ html, entryId, source, timestamp, latex }) {
      const target = await this._resolveNoteTarget(source.regularItem);
      const noteItem = target.noteItem;
      if (!noteItem?.isEditable?.()) {
        throw new Error("目标笔记不可编辑（可能位于只读库或回收站）");
      }

      if (target.editorInstance && !target.editorInstance._readOnly) {
        const inserted = this._insertIntoOpenEditor(target.editorInstance, html);
        if (inserted) {
          // 编辑器约 1 秒自动保存。最多等 4 秒，确认笔记条目中出现了本次时间戳。
          const saved = await this._waitForNoteText(noteItem, timestamp, 4000);
          if (!saved) {
            this._log("note editor did not persist within timeout; forcing saveSync");
            try { target.editorInstance.saveSync(); } catch (e) { /* noop */ }
            await this._waitForNoteText(noteItem, timestamp, 1500);
          }
          return noteItem;
        }
      }

      await this._appendEntryDirectly(noteItem, html);
      return noteItem;
    }

    _insertIntoOpenEditor(editorInstance, html) {
      try {
        if (!editorInstance?._postMessage || !editorInstance._iframeWindow) return false;
        // 与 Zotero.EditorInstance.insertAnnotations() 内部使用的协议一致：
        // insertHTML 会由 ProseMirror 解析并合入当前文档。
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

      // insertAdjacentHTML 会按 HTML 规则解析 blockquote/pre.math；不需手动构建节点。
      contentRoot.insertAdjacentHTML("beforeend", html);

      const next = noteRoot ? noteRoot.outerHTML : doc.body.innerHTML;
      noteItem.setNote(next);
      await noteItem.saveTx({ skipSelect: true });
    }

    // ===================== 进度窗口与提示 =====================

    _newProgress(text) {
      try {
        const progress = new Zotero.ProgressWindow({ closeOnClick: true });
        progress.changeHeadline("TexLink");
        progress.progress = new progress.ItemProgress("note", text);
        progress.progress.setProgress(5);
        progress.show();
        return progress;
      }
      catch (error) {
        this._logError("Failed to create progress window", error);
        return null;
      }
    }

    _setProgress(progress, percent, text, isError = false) {
      if (!progress?.progress) return;
      try {
        if (text) progress.progress.setText(text);
        if (Number.isFinite(percent)) progress.progress.setProgress(percent);
        if (isError) progress.progress.setError();
      }
      catch (error) {
        this._log(`progress update failed: ${error.message}`);
      }
    }

    _closeProgress(progress, delayMs = 5000) {
      if (!progress) return;
      try {
        progress.startCloseTimer(delayMs);
      }
      catch (error) { /* noop */ }
    }

    _showError(error) {
      const message = String(error?.message || error || "未知错误");
      this._logError("user-visible error", error);
      const progress = this._newProgress(message);
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
          "TexLink 备注",
          "可选备注（留空则不写入；点击取消将放弃本次识别）：",
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

  // 暴露给构建期/调试期测试使用；运行期逻辑不依赖该属性。
  Service.BPEDecoder = TexLinkBPEDecoder;

  return Service;
})();
