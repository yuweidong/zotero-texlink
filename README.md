# TexLink

**Zotero 10 原生的结构化公式知识锚定器。**

TexLink 不是“又一个公式 OCR”。它把公式截图识别成 LaTeX 之后，默认并且只把
结果写进当前文献的 Zotero 笔记，同时附带：

- Zotero 笔记编辑器原生 KaTeX 预览（块级数学节点）
- 可直接复制/编译的 LaTeX 源码（同时支持 Zotero 原生全文搜索）
- 精确页码（优先 PDF `pageLabel`，回退物理页码）
- ISO 8601 提取时间戳
- 文献标题、PDF 附件 key、可点击的 Zotero 内部链接
- 可选备注

整个识别过程在 Zotero 内部完成：**无 Python 后端、无云 API、无外部网络请求**。
交付物是单个 `.xpi`；模型、WASM、tokenizer 全部随包携带。

> 当前版本：V0.1.2。目标 Zotero：10.0 – 10.999。已在 Zotero 10.0.7 的源码/API
> 基础上适配，并使用打包的同版本 ONNX 模型在 Python ONNX Runtime 中完成端到端
> 数值验证。详见文末“验证状态”。

---

## 1. 快速安装

1. 打开 Zotero 10。
2. `工具` → `插件` → 右上角齿轮 → `从文件安装插件…`
3. 选择 `dist/zotero-texlink-0.1.2.xpi`。
4. 重启 Zotero（或禁用再启用 TexLink）。

> **如果安装时出现“可能无法与该版本的 Zotero 兼容”**：
> 这是 Zotero 对插件安装失败给出的通用提示。0.1.0 的清单缺少 Zotero 10
> 强制要求的 `applications.zotero.update_url`，因此会被判为无效插件；
> 这与 `10.0.7` 的版本范围无关。0.1.2 已修复，并在 Zotero 10.0.7 中
> 验证为 active=true、appDisabled=false。若仍看到旧提示，请确认选中的是
> `0.1.2`，必要时先在插件管理器中删除旧的失败记录再安装。

安装包约 25 MiB，首次加载会在后台编译 WASM、初始化 ONNX Session；
模型预热在 Web Worker 中完成，不阻塞 Zotero UI。

> **0.1.2 针对“选择右键菜单后 Zotero 崩溃”的诊断性修复**
> 0.1.2 不再在右键菜单回调栈内打开 `Zotero.ProgressWindow`，而是：
> 1. 用 `setTimeout(0)` 把识别推迟到菜单完全关闭后；
> 2. 用 Reader 文档内的轻量浮层显示进度/错误，不再创建原生窗口；
> 3. 把关键步骤追加到系统临时目录的 `texlink-crash.log`，用于定位如果是
>    更深层的原生崩溃。
>
> 请先安装 0.1.2 再试一次。如果仍然崩溃，请把
> `$TMPDIR/texlink-crash.log`（或 `/tmp/texlink-crash.log`）发给我；
> 日志中的最后一条记录会指出崩溃发生在读取图片、推理还是写笔记阶段。

### 第一次使用

1. 在 Zotero PDF 阅读器中打开论文。
2. 在阅读器工具栏选择 **区域图像/Image** 注释工具，框选公式。
3. 选中刚生成的图片注释，右键 → **TexLink：识别公式并写入笔记**。
   也可以直接按 `Cmd/Ctrl + Shift + L`。
4. 第一次会加载模型；之后几十个 token 的公式通常数秒内完成。
5. 结果写入：
   - 若当前打开着同一篇文献的笔记，则插入当前笔记；
   - 否则写入该文献下自动创建的 **“TexLink 公式摘录”** 子笔记。

默认写入后不自动切走当前阅读标签。可以随时在条目下的“笔记”面板找到
“TexLink 公式摘录”。

> TexLink 把 Zotero 的原生“区域图像注释”作为截图事件。这样无需自己解析
> PDF 坐标，也不会绕过 Zotero 的图片缓存、同步和撤销体系。

---

## 2. 核心设计

```
┌──────────────────────────── Zotero 10 主线程 ────────────────────────────┐
│                                                                          │
│  PDF 区域图像注释                                                        │
│        │ Zotero.Annotations.toJSON()                                     │
│        ▼                                                                 │
│  Canvas 384×384 resize + 归一化（小图，毫秒级）                           │
│        │ transferable ArrayBuffer                                        │
│        ▼                                                                 │
│  texlink-service.js ──── postMessage ────┐                               │
│        │                                  │                              │
│        │ Zotero.Item('note') / 编辑器插入  │                              │
│        ▼                                  │                              │
│  Zotero 笔记（KaTeX + 源码 + 页码 + 时间） │                              │
└───────────────────────────────────────────┼──────────────────────────────┘
                                            │
┌────────────────────────────── Web Worker ──▼──────────────────────────────┐
│  onnxruntime-web 1.17.3（WASM，单线程、无线程依赖）                       │
│  Pix2Text-MFR INT8 encoder                                              │
│  Pix2Text-MFR INT8 decoder（贪心解码，确定性输出）                        │
│  → token ids                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

> **为什么 Worker 接收 Float32Array 而不是图片 Base64？**
> 截图 data URL 在主线程通过 Canvas 完成解码、缩放和归一化后，以可转移
> 的 `Float32Array`（零拷贝）发送给 Worker。这样避免 Base64 约 33% 的
> 体积膨胀，也避免把 1.8 MB 的字符串再复制给推理线程；主线程只做“图像捕获”
> 级的轻量处理，模型加载、ORT 初始化、全部矩阵推理仍在 Worker 中完成。

### 为什么是 Pix2Text-MFR，而不是 UniMERNet？

两者都在产品允许范围内。V0.1 选择 **Pix2Text-MFR**，原因：

1. 官方仓库直接提供 ONNX 格式的 encoder/decoder 与 tokenizer，便于验证和
   量化；
2. 模型是 TrOCR/VisionEncoderDecoder 架构，输出确定，适合离线公式识别；
3. 量化后编码器约 22 MiB、解码器约 7.6 MiB，整体 XPI 约 25 MiB（压缩后）；
4. UniMERNet 官方权重/ONNX 导出链路更重，且不存在稳定的官方 ONNX 发布物。
   本文档仍提供了 UniMERNet 的构建期导出模板，但 V0.1 运行包不默认携带；
5. 固定使用 onnxruntime-web 1.17.3 的非线程 WASM 构建，避免在 chrome:// Worker
   中依赖 COOP/COEP 或 SharedArrayBuffer；WASM 以 Blob URL 交给 Emscripten，
   不直接请求 chrome:// 路径。

### 关于 MathJax 的说明

Zotero 10 的笔记编辑器**原生使用 KaTeX** 渲染数学节点，并在笔记 HTML 中
约定：

- 块级：`<pre class="math">$$...$$</pre>`
- 行内：`<span class="math">$...$</span>`

因此 TexLink 不向笔记注入 MathJax `<script>`（注入脚本既不是 Zotero 官方
笔记格式，也会破坏同步/搜索）。我们生成 Zotero 原生数学节点，由 Zotero
内置 KaTeX 渲染预览；同一块的普通 `<pre>` 中保留 LaTeX 源文本，保证：

- 预览和源码同时存在；
- Zotero 原生搜索可以搜索源码；
- 笔记在 Zotero 10 中被再次编辑、同步时不会被当成未知 HTML 丢弃。

---

## 3. 目录结构

```text
zotero-texlink/
├── manifest.json                     # Zotero 10 bootstrap 插件清单
├── bootstrap.js                     # 生命周期 + chrome:// 注册 + 服务加载
├── prefs.js                         # 默认首选项，包括笔记模板
├── chrome/content/
│   ├── scripts/
│   │   ├── texlink-service.js       # 核心服务：截图 -> Worker -> 笔记
│   │   └── worker.js                # ONNX Runtime + INT8 推理
│   ├── models/
│   │   ├── texlink-model.json       # 模型契约、输入输出名、Hashes
│   │   ├── encoder_model_int8.onnx  # INT8 encoder（22 MiB）
│   │   ├── decoder_model_int8.onnx  # INT8 decoder（7.6 MiB）
│   │   ├── tokenizer.json           # BPE/ByteLevel tokenizer
│   │   └── pix2text-mfr-*.json      # 上游模型配置，供审计
│   ├── vendor/ort/
│   │   ├── ort.min.js
│   │   └── ort-wasm-simd.wasm
│   └── icons/
├── docs/
│   ├── MODEL_CONVERSION.md          # Pix2Text / UniMERNet 转换指南
│   └── PACKAGING.md                 # XPI 目录结构和打包说明
├── tools/
│   ├── verify_assets.py
│   ├── smoke_test_onnx.py
│   └── build_xpi.py
├── third_party/                     # 第三方许可证
└── dist/                            # 构建产物
```

---

## 4. 首选项

所有首选项前缀：`extensions.zotero.texlink.`。V0.1 没有专门的首选项面板，
可通过 Zotero 的高级配置编辑器修改（`编辑 → 设置 → 高级 → 配置编辑器`）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；修改后需重启 Zotero |
| `warmupOnStartup` | `true` | 启动后在 Worker 中预热模型 |
| `maxNewTokens` | `384` | 解码上限，最大 512 |
| `noteTarget` | `auto` | `auto` / `active` / `dedicated` |
| `logNoteTag` | `texlink-formula-log` | 专用笔记标签，用于稳定定位 |
| `logNoteTitle` | `TexLink 公式摘录` | 新建专用笔记的标题 |
| `openNoteAfterInsert` | `false` | 写入后打开笔记标签页 |
| `promptForComment` | `false` | 识别前弹出可选备注输入框 |
| `autoProcessNewScreenshots` | `false` | 监听新图像注释并自动识别 |
| `shortcut` | `accel,shift,L` | 快捷键，`accel` = Cmd/Ctrl |
| `binarize` | `false` | 是否做 Otsu 二值化 |
| `maxCommentLength` | `2000` | 备注最大长度 |
| `noteTemplate` | 见 `prefs.js` | 公式块 HTML 模板 |

### 笔记落点模式

- `auto`：优先写入**当前已打开的、属于同一文献的笔记**；如果没有，则使用
  该文献下带 `logNoteTag` 标签的专用子笔记（不存在则创建）。
- `active`：与 `auto` 类似，但强调当前笔记；找不到时回退专用子笔记。
- `dedicated`：永远写入专用子笔记，适合把公式和正文笔记分开管理。

### 自定义模板占位符

`noteTemplate` 支持：

`{{id}}`、`{{annotationKey}}`、`{{latexRaw}}`、`{{pageLabel}}`、
`{{timestamp}}`、`{{sourceTitle}}`、`{{pdfLink}}`、`{{itemLink}}`、
`{{commentBlock}}`

其中 `{{latexRaw}}` 会被 HTML 转义，可同时放进 `<pre class="math">` 和
普通 `<pre>`。若模板缺少 `{{latexRaw}}` / `{{pageLabel}}`，或包含
`<script>` 等危险标签，会自动回退到内置模板。

---

## 5. Zotero 10 API 适配说明

### 5.1 新建笔记

**不存在** `Zotero.Notes.create()`。Zotero.Notes 负责打开/注册编辑器实例，
不负责创建笔记条目。V0.1 使用 Zotero 10 实际存在的 API：

```js
const note = new Zotero.Item("note");
note.libraryID = parentItem.libraryID;
note.parentID = parentItem.id;
note.setNote(html);
await note.saveTx({ skipSelect: true });
```

`Zotero.Notes.open(noteID)` 用于打开现有笔记，这在本插件中是可用的。

### 5.2 当前笔记与实时编辑

- 当前上下文面板的编辑器：`ZoteroContextPane.activeEditor` +
  `getCurrentInstance()`；
- 已打开的笔记标签页：受保护的 `Zotero.Notes._editorInstances` 只读遍历；
- 若目标笔记正在编辑器内，使用与 Zotero 自身 `insertAnnotations()` 相同的
  `insertHTML` 消息插入，避免 `setNote()` 覆盖尚未落盘的输入；
- 若笔记未打开，直接 `item.setNote()` + `saveTx()`，由 Zotero Notifier
  刷新其它已打开的编辑器。

### 5.3 Reader 事件与快捷键

- 官方事件：`Zotero.Reader.registerEventListener("createAnnotationContextMenu", ...)`。
  这是 Zotero 10 reader.js 中实际派发的事件之一。
- `renderToolbar` 等旧事件在 Zotero 10.0.7 的 reader 实现中不再稳定派发，
  因此本插件不依赖工具栏注入，而是提供右键菜单 + Tools 菜单 + 快捷键。
- 为了识别焦点位于 PDF 内层 iframe 时的快捷键，插件会读取
  `reader._iframeWindow` / `_internalReader._primaryView._iframeWindow`，
  并在存在性检查后绑定 keydown。它们不是公开稳定 API，所以：
  - 失败时不影响右键菜单路径；
  - 代码里全部做了 optional chaining 和 try/catch。
- 当前选中注释 key 来自 `reader._internalReader._state.selectedAnnotationIDs`，
  并提供了 `getSelectedAnnotations()` 的兼容回退。

### 5.4 `update_url`：Zotero 10 的清单硬性要求

Zotero 10 的 ExtensionData 校验会要求插件清单包含
`applications.zotero.update_url`；如果缺失，安装会以通用“不兼容”错误失败。
此外，AddonManager 的 `checkUpdateSecurity` 要求该 URL 以 `https:` 开头，
否则 addon 会被标记为 `appDisabled`（即使手动装上也处于禁用状态）。

因此 0.1.2 的清单使用：

```json
"update_url": "https://zotero-texlink.invalid/updates.json"
```

`.invalid` 是保留的不可解析域名，用于明确表示 V0.1 没有更新服务器；
TexLink 的**运行时代码**不会访问这个 URL，插件自身也没有任何外部网络请求。
如果开启 Zotero 的插件自动更新检查，Zotero 可能会自行尝试访问该地址并失败；
正式分发时应把它替换成真实的 HTTPS 更新清单地址，或在测试机禁用自动更新。

### 5.5 权限与资源路径

Zotero Bootstrap 插件的 `manifest.json` **没有 WebExtension `permissions` 字段**，
也不应该伪造。插件所需资源随 XPI 携带，并在 `bootstrap.js` 中通过
`amIAddonManagerStartup.registerChrome()` 注册：

```text
chrome://zotero-texlink/content/scripts/worker.js
chrome://zotero-texlink/content/models/...
chrome://zotero-texlink/content/vendor/ort/...
```

Worker、模型、WASM、tokenizer 全部走这个内部协议；代码中没有外部
`fetch`/XHR。`tools/verify_assets.py` 会扫描运行时代码中的外部 URL。

### 5.6 页码

`annotationPageLabel` 是 Zotero 对 PDF 页码标签的精确值（可能是 `iv`、`12`
等）；若为空，使用 `annotationPosition.pageIndex + 1` 作为 PDF 物理页码，
并在文本中明确标为 `PDF 第 N 页`，避免伪装成印刷页码。

---

## 6. 构建、校验、打包

要求：Python 3.10+。构建/测试依赖只用于开发，不进入 XPI。

```bash
# 1) 资源完整性、模型哈希、离线 URL 检查
python3 tools/verify_assets.py

# 2) （可选）模型数值烟测。需要：pip install onnxruntime numpy pillow
python3 tools/smoke_test_onnx.py

# 3) 生成 XPI
python3 tools/build_xpi.py
```

产物：

```text
dist/zotero-texlink-0.1.2.xpi          (24.8 MiB)
dist/zotero-texlink-0.1.2.xpi.sha256
```

当前构建的 SHA256：

```text
d83190f15c8ffa174142c49a20ec2fbcb5a37dc3ebeeb24ff20e07571e633fa9
```

打包细节见 [docs/PACKAGING.md](docs/PACKAGING.md)。模型如何从 Hugging Face
得到、如何量化，见 [docs/MODEL_CONVERSION.md](docs/MODEL_CONVERSION.md)。

---

## 7. 调试

1. Zotero 帮助 → 调试输出日志 → 查看输出。
2. 执行以下命令打开详细日志：

   ```js
   Zotero.Prefs.set("extensions.zotero.texlink.debug", true);
   Zotero.Prefs.set("extensions.zotero.texlink.warmupOnStartup", true);
   ```

3. 卸载/重装或重启 Zotero，检索 `[TexLink]`。
4. 若模型加载失败，常见原因：
   - XPI 未完整下载（检查 `dist` 的 SHA256）；
   - 从解压后的目录直接加载，而不是安装 XPI（chrome 包映射可能不完整）；
   - Zotero 版本不在 `10.0 – 10.999` 范围。

---

## 8. 已验证 / 未验证

### 已验证

- 在 Zotero 10.0.7 的源码中核对了：
  - bootstrap 生命周期签名；
  - `Zotero.Reader.registerEventListener("createAnnotationContextMenu")`；
  - `Zotero.Item("note")` / `setNote()` / `saveTx()`；
  - 笔记编辑器数学节点 `<pre class="math">` 的解析/序列化；
  - `Zotero.Annotations.toJSON()` 返回图片 data URL；
  - `Zotero.ProgressWindow` 的基本用法。
- 模型侧：用打包的 INT8 encoder/decoder + tokenizer 在 ONNX Runtime
  Python 1.19 与 1.17.3 上分别跑通端到端贪心解码，输出：
  `\int _ { 0 } ^ { \infty } \! e ^ { - x ^ { 2 } } \, d x \! = \! \frac { \sqrt \pi } 2`
- 纯 JS ByteLevel BPE 解码器与 Python tokenizer 解码结果逐字符一致。
- XPI 资源结构、模型 SHA256、外部 URL 检查通过。
- **在 Zotero 10.0.7（macOS，headless 测试 profile）中，通过
  `AddonManager.getInstallForFile()` 的实际安装路径安装成功**：
  `0.1.2`、`active=true`、`appDisabled=false`、`userDisabled=false`；
  bootstrap startup、chrome 包注册、Reader 右键菜单注册、Worker 启动、
  ORT WASM/两个 ONNX Session 加载和模型预热（warmup）全部完成；调试日志
  可见 `model warmup complete`。
- **打开真实 Zotero Reader，使用 PDF 图像注释的 end-to-end 测试通过**：
  用户截图 → Canvas 预处理 → Worker INT8 推理 → LaTeX → 写入文献笔记，
  Reader 内 toast 显示成功；实际运行约 7 秒（含首次加载会话）。
- 0.1.2 的 `_diag` 已覆盖从 pipeline、图像、预处理、Worker 到写笔记的全部
  阶段；正常运行时可在临时目录看到步骤记录。
- 安装失败的实际根因已定位：清单缺少 `applications.zotero.update_url`；
  另一并修复了 bootstrap startup 中 `reason` 未定义导致服务未启动的问题。

### 未验证 / 已知限制

- 尚未在完整 GUI 中完成“右键菜单点击”的自动化回归；Reader 打开状态下的
  服务链路（截图→推理→笔记）已 headless 实测通过。0.1.2 的菜单延迟和
  无窗口提示正是为规避 macOS 菜单回调重入问题。
- `update_url` 必须使用 HTTPS（Zotero 安装校验的硬要求）；当前是
  `.invalid` 占位地址，不指向实际更新服务器。
- 首次加载 ORT WASM + 两个 ONNX Session 在低端机器上可能需要数秒到十几秒。
- 只处理**有父级文献条目的 PDF 附件**；独立 PDF 暂不支持（会给出明确错误）。
- 输入只接受 Zotero 原生图像/ink 注释，不读取系统剪贴板；这是刻意的离线、
  可溯源设计。
- 不支持公式手写笔迹的专业优化；ink 注释会走同一图像路径。
- V0.1 无首选项面板；使用配置编辑器。
- 识别质量由 Pix2Text-MFR 决定；不包含 LLM 纠错，这是“无幻觉”约束的代价。
- 如果 Zotero 未来版本修改笔记 schema/Reader 内部字段，实时插入和选中注释
  读取可能需要更新；专用笔记 + 右键菜单路径受影响较小。

---

## 9. 许可

- 本插件代码：MIT（`LICENSE`）。
- Pix2Text-MFR 模型与 tokenizer：MIT。
- onnxruntime-web 1.17.3：MIT。

完整第三方声明见 `THIRD_PARTY_NOTICES.md`。
