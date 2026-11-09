texlink-pref-title = TexLink
texlink-pref-tagline = 面向 Zotero 的结构化公式锚定器
texlink-pref-intro = TexLink 将 PDF 中的原生图像注释转换为可追溯的公式块，并写入 Zotero 文献笔记。识别在 Web Worker 中本地完成，不使用外部 OCR 服务或大语言模型。
texlink-pref-restart-note = 更改会立即保存。总开关和启动预热将在下次重启 Zotero 后生效。

texlink-pref-general = 常规
texlink-pref-enable = 启用 TexLink
texlink-pref-enable-hint = 关闭后，TexLink 将在下次重启 Zotero 后注销。
texlink-pref-warmup = 启动时加载并预热模型
texlink-pref-warmup-hint = 预热在 Worker 中进行，可让首次识别更快。
texlink-pref-open-note = 写入后打开目标笔记
texlink-pref-prompt-comment = 识别前询问可选备注
texlink-pref-auto-process = 自动处理新的图像注释
texlink-pref-auto-process-hint = 默认关闭，因为示意图等非公式图像也可能被创建为注释。

texlink-pref-recognition = 识别
texlink-pref-max-tokens = 最大生成 token 数
texlink-pref-max-tokens-hint = Pix2Text-MFR 最多支持 512 个 token；过长的公式可能被截断。
texlink-pref-binarize = 推理前应用 Otsu 二值化
texlink-pref-binarize-hint = 通常保持关闭。模型使用自然灰度图像训练，二值化可能降低准确率。
texlink-pref-shortcut = 键盘快捷键
texlink-pref-shortcut-hint = 使用英文逗号分隔；accel 在 macOS 表示 Cmd，在其他平台表示 Ctrl。例如：accel,shift,L

texlink-pref-note-destination = 笔记写入位置
texlink-pref-note-target = 公式块写入位置
texlink-pref-note-target-auto = 自动：优先使用当前文献的笔记，否则使用专用笔记
texlink-pref-note-target-active = 活动笔记：优先使用已打开的笔记，否则使用专用笔记
texlink-pref-note-target-dedicated = 专用笔记：始终使用专用笔记
texlink-pref-log-tag = 专用笔记标签
texlink-pref-log-tag-hint = 用于在多次提取之间找到同一笔记；请勿从笔记中删除该标签。
texlink-pref-log-title = 专用笔记标题
texlink-pref-max-comment = 备注最大长度

texlink-pref-template = 公式块模板
texlink-pref-template-hint = 模板必须包含 LaTeX 源码和页码占位符。公式块使用 Zotero 原生数学节点；请勿添加脚本、远程图片或事件处理器，不安全的模板会回退到内置模板。
texlink-pref-restore-template = 恢复默认模板

texlink-pref-advanced = 高级
texlink-pref-debug = 将详细 Worker 消息写入 Zotero 调试输出
texlink-pref-diagnostic = 将识别阶段日志写入 texlink-crash.log
texlink-pref-diagnostic-hint = 日志写入系统临时目录；仅在排查崩溃时开启。
texlink-pref-reset-all = 重置所有 TexLink 首选项

texlink-status-saved = 已保存。
texlink-status-enabled-restart = 已保存。请重启 Zotero 使总开关更改生效。
texlink-status-warmup-restart = 已保存。预热更改将在重启后生效。
texlink-status-empty = 该项不能为空。
texlink-status-shortcut-invalid = 请使用逗号分隔的修饰键和一个按键，例如 accel,shift,L。
texlink-status-template-placeholders = 模板必须包含 LaTeX 源码和页码占位符。
texlink-status-template-restored = 已恢复默认公式模板。
texlink-status-reset = 已重置所有 TexLink 首选项。启动相关的更改需要重启 Zotero。
texlink-status-reset-confirm = 要将所有 TexLink 首选项恢复为默认值吗？

texlink-menu-single = TexLink：识别公式并写入笔记
texlink-menu-multiple = TexLink：识别选中的多个公式并写入笔记
texlink-menu-tools = TexLink：识别选中的公式截图
texlink-menu-tools-tooltip = 先在 PDF 中用图像注释框选公式，再点击这里或使用快捷键。

texlink-progress-preparing = 正在准备识别公式……
texlink-progress-loading-model = 正在加载离线模型……
texlink-progress-reading = 正在读取截图并推理……
texlink-progress-preprocessing = 正在预处理图像……
texlink-progress-recognizing = 正在离线识别公式……
texlink-progress-writing = 正在写入 Zotero 笔记……
texlink-progress-cancel = 取消
texlink-progress-canceled = 已取消
texlink-progress-added = 已向 Zotero 笔记写入 { $count } 条公式记录
texlink-progress-skipped = 已跳过 { $count } 条重复记录
texlink-progress-failed-count = { $count } 条失败；详见 Zotero 调试输出
texlink-progress-recognition-failed = 识别失败：{ $message }
texlink-progress-failed = TexLink 失败：{ $message }
texlink-progress-worker-error = 推理线程错误：{ $message }
texlink-progress-processing = 正在处理……
texlink-progress-ort = 正在初始化离线推理引擎……
texlink-progress-encoder = 正在加载公式模型（编码器）……
texlink-progress-decoder = 正在加载公式模型（解码器）……
texlink-progress-decoding = 正在解码公式（{ $step }/{ $max }）……

texlink-error-busy = TexLink 正在处理上一条公式，请稍候。
texlink-error-open-pdf = 请先打开一篇 PDF，并用图像注释工具框选公式。TexLink 不会读取剪贴板，也不会上传图片。
texlink-error-no-annotation = 没有检测到选中的图像注释。请在 Zotero PDF 阅读器中选择图像注释工具，框选公式，再选中该截图后重试。
texlink-error-model-missing = 公式模型/tokenizer 未加载，无法识别。请重新安装完整的 TexLink.xpi。
texlink-error-empty-formula = 模型返回了空公式；请重新框选更清晰的公式图片后重试。
texlink-error-no-attachment = 该注释没有关联的 PDF 附件。
texlink-error-no-parent = 该 PDF 没有父级文献条目。请先把 PDF 作为附件添加到文献条目下，TexLink 才能把公式锚定到文献笔记。
texlink-error-no-image = 该注释不是图像注释。
texlink-error-cache = 无法读取该截图的本地缓存。请确认注释图片已同步或保存到本地。
texlink-error-cache-detail = 无法读取该截图的本地缓存：{ $detail }。请确认注释图片已同步或保存到本地。
texlink-error-readonly-library = 当前文献所在库为只读库，无法创建或修改笔记。
texlink-error-target-readonly = 目标笔记不可编辑（可能位于只读库或回收站）。
texlink-error-model-load = 模型加载失败：{ $message }
texlink-error-model-config = 模型配置或 tokenizer 尚未加载。
texlink-error-worker-init = 推理 Worker 尚未初始化。
texlink-error-unknown = 未知错误

texlink-prompt-title = TexLink 备注
texlink-prompt-message = 可选备注（留空则不写入；点击取消将放弃本次识别）：

texlink-note-anchor-title = TexLink 公式锚点
texlink-note-label-page = 页码
texlink-note-label-extracted = 提取时间
texlink-note-label-source = 来源
texlink-note-label-open-pdf = 在 PDF 中定位
texlink-note-label-view-item = 查看文献条目
texlink-note-label-latex-source = LaTeX 源码
texlink-note-label-comment = 备注
texlink-note-title = TexLink 公式摘录
texlink-note-intro = 本笔记由 TexLink 自动创建。每个公式块都包含本地 KaTeX 预览、LaTeX 源码、页码和 ISO 时间戳。
texlink-note-page-fallback = PDF 第 { $page } 页
texlink-note-untitled = 未命名文献

texlink-error-main-window = 无法获得 Zotero 主窗口用于图像预处理。
texlink-error-decode-image = 无法解码注释图片。
texlink-error-zero-image = 注释图片尺寸为 0。
texlink-error-canvas = 无法创建 Canvas 2D 上下文。
texlink-error-worker-error = 推理线程错误：{ $message }
