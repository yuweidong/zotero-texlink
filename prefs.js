/*
 * TexLink 默认首选项。
 *
 * Zotero 在插件启动时会把本文件当作脚本执行，并提供全局 `pref(name, value)`。
 * 这里写入的都是“默认值”：用户或其它插件通过 Zotero.Prefs.set() 写入的值优先。
 * 所有运行期代码都通过 extensions.zotero.texlink.* 读取这些配置。
 */

// 公式笔记记录的默认 HTML 模板。占位符由 texlink-service.js 替换。
// 注意：
// 1. Zotero 10 的笔记编辑器原生使用 KaTeX 渲染数学节点；
//    块级公式约定为 <pre class="math">$$...$$</pre>，行内为 <span class="math">$...$</span>。
// 2. 不要把 {{latexRaw}} 放进 HTML 属性；它会被 HTML 转义后写入 math 节点。
// 3. 高级用户可修改；若模板缺少 {{latexRaw}}，插件会回退到内置模板。
const TEXLINK_DEFAULT_NOTE_TEMPLATE = [
  '<blockquote data-texlink-entry="{{id}}" data-texlink-annotation="{{annotationKey}}">',
  '  <h3>TexLink 公式锚点</h3>',
  '  <pre class="math">$${{latexRaw}}$$</pre>',
  '  <p><strong>页码：</strong>{{pageLabel}}　<strong>提取时间：</strong>{{timestamp}}</p>',
  '  <p><strong>来源：</strong>{{sourceTitle}} · <a href="{{pdfLink}}">在 PDF 中定位</a> · <a href="{{itemLink}}">查看文献条目</a></p>',
  '  {{commentBlock}}',
  '  <p><strong>LaTeX 源码：</strong></p>',
  '  <pre>{{latexRaw}}</pre>',
  '</blockquote>'
].join('\n');

// 总开关。关闭后仍保留已写入的笔记，但不再注册菜单/快捷键/自动监听。
pref('extensions.zotero.texlink.enabled', true);

// 是否在 Zotero 启动后后台加载并预热 ONNX 模型。
// 预热在 Web Worker 中进行，不阻塞主线程；关闭后第一次识别会多花几秒。
pref('extensions.zotero.texlink.warmupOnStartup', true);

// 解码阶段最多生成多少个 token。Pix2Text-MFR 的模型上限是 512，V0.1 默认 384。
pref('extensions.zotero.texlink.maxNewTokens', 384);

// 笔记落点：
//   auto      = 若当前打开的笔记属于同一文献则追加；否则使用“TexLink 公式摘录”专用子笔记
//   active    = 只尝试当前打开的笔记，找不到时回退到专用子笔记
//   dedicated = 总是写入该文献的专用子笔记
pref('extensions.zotero.texlink.noteTarget', 'auto');

// 专用子笔记的标签。用于在多次提取之间稳定找到同一篇笔记；用户不要随意删除该标签。
pref('extensions.zotero.texlink.logNoteTag', 'texlink-formula-log');

// 专用子笔记的标题（写入 HTML 的第一个 h2，并由 Zotero 自动生成笔记标题）。
pref('extensions.zotero.texlink.logNoteTitle', 'TexLink 公式摘录');

// 写入后是否自动在新标签页打开笔记。默认 false，避免打断阅读。
pref('extensions.zotero.texlink.openNoteAfterInsert', false);

// 识别后是否弹出一个可选的备注输入框（使用 Zotero 主窗口的 nsIPromptService）。
pref('extensions.zotero.texlink.promptForComment', false);

// 是否监听新创建的原生图片注释（截图），并自动识别。默认关闭，避免把示意图误当公式。
pref('extensions.zotero.texlink.autoProcessNewScreenshots', false);

// 快捷键。逗号分隔，accel = macOS 的 Cmd / 其它平台 Ctrl。
pref('extensions.zotero.texlink.shortcut', 'accel,shift,L');

// 是否在预处理时对图像做 Otsu 二值化。默认关闭：
// Pix2Text-MFR 使用 DeiT 图像处理器，在自然灰度图上训练，强行二值化通常反而降低准确率。
pref('extensions.zotero.texlink.binarize', false);

// 记录在公式块中的备注最大长度。
pref('extensions.zotero.texlink.maxCommentLength', 2000);

// 调试日志。开启后会向 Zotero 调试输出写入更详细的 Worker 往返信息。
pref('extensions.zotero.texlink.debug', false);

// 公式笔记 HTML 模板（见文件顶部说明）。
pref('extensions.zotero.texlink.noteTemplate', TEXLINK_DEFAULT_NOTE_TEMPLATE);
