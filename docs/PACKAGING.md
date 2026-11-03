# XPI 打包说明

Zotero 10 的 Bootstrap 插件本质是一个 ZIP 文件，只是扩展名改成 `.xpi`。
`manifest.json`、`bootstrap.js`、`prefs.js` 必须位于 ZIP 根目录，不能多套一层
目录。

## 1. 最终 XPI 结构

```text
zotero-texlink-0.1.2.xpi
├── manifest.json
├── bootstrap.js
├── prefs.js
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── third_party/
│   ├── LICENSE-onnxruntime.txt
│   └── LICENSE-pix2text.txt
└── chrome/
    └── content/
        ├── scripts/
        │   ├── texlink-service.js
        │   └── worker.js
        ├── models/
        │   ├── texlink-model.json
        │   ├── encoder_model_int8.onnx
        │   ├── decoder_model_int8.onnx
        │   ├── tokenizer.json
        │   ├── pix2text-mfr-config.json
        │   └── pix2text-mfr-preprocessor.json
        ├── vendor/
        │   └── ort/
        │       ├── ort.min.js
        │       └── ort-wasm-simd.wasm
        └── icons/
            ├── texlink-48.png
            └── texlink-96.png
```

**不要**把 `README.md`、`docs/`、`tools/`、`tests/`、`.venv` 打进运行包；
构建脚本会自动排除它们。

## 2. 资源路径映射

`bootstrap.js` 在启动时执行：

```js
const aomStartup = Components.classes[
  "@mozilla.org/addons/addon-manager-startup;1"
].getService(Components.interfaces.amIAddonManagerStartup);
const manifestURI = Services.io.newURI(rootURI + "manifest.json");
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "zotero-texlink", rootURI + "chrome/content/"]
]);
```

因此 Zip 内：

```text
chrome/content/scripts/worker.js
```

对应的运行期 URL 是：

```text
chrome://zotero-texlink/content/scripts/worker.js
```

模型、tokenizer、ORT 的 `.wasm` 都通过同一前缀访问：
`chrome://zotero-texlink/content/{models,vendor/ort}/...`。

V0.1 固定使用 onnxruntime-web 1.17.3 的单线程 WASM 资产
（`ort-wasm-simd.wasm`）。Worker 先读取该文件，再通过 Blob URL 交给
Emscripten；这样不会依赖 `SharedArrayBuffer`，也绕开了 chrome:// 的资源
fetch 差异。

这比把 `file:///...` 绝对路径写死更安全，也不会因为 Windows/macOS 路径
分隔符不同而出错。

### 为什么没有 `chrome.manifest`？

可以在 XPI 根放一个 `chrome.manifest`，但 Zotero 10 的现代插件普遍在
`bootstrap.js` 中动态注册（本项目也一样），这样：

- 不依赖应用启动时扫描 XPI 内的旧式 manifest；
- 卸载时可以用 `chromeHandle.destruct()` 精确释放；
- 不会与其它插件的内容包名冲突。

## 3. 构建命令

```bash
python3 tools/verify_assets.py
python3 tools/build_xpi.py
```

产物：

```text
dist/zotero-texlink-0.1.2.xpi
dist/zotero-texlink-0.1.2.xpi.sha256
```

构建脚本会：

1. 校验清单（含 `update_url` 必须以 `https://` 开头）、模型 SHA256、
   tokenizer 词表大小、ORT 文件；
2. 扫描运行期 JS，拒绝出现外部 HTTP URL；
3. 把 runtime 文件以 deflate 压缩进 XPI；
4. 计算 XPI 的 SHA256。

## 4. 手动检查

```bash
unzip -l dist/zotero-texlink-0.1.2.xpi | sed -n '1,80p'
unzip -p dist/zotero-texlink-0.1.2.xpi manifest.json | python3 -m json.tool
```

应满足：

- `manifest.json` 在第一层；
- `chrome/content/models/encoder_model_int8.onnx` 存在；
- `chrome/content/vendor/ort/ort-wasm-simd.wasm` 存在；
- 不存在 `__MACOSX/`、`.DS_Store`；
- XPI 大小约 25 MiB（未压缩约 43 MiB；模型 ~31 MiB，WASM ~10 MiB，其余很小）。

## 5. 安装与开发

### 正常安装

Zotero 10 → 工具 → 插件 → 齿轮 → 从文件安装插件 → 选择 XPI。
未签名插件会显示 Zotero 的警告，这是 Zotero 侧的正常流程。

### 开发期

不建议把 `chrome/` 目录直接作为插件安装：`chrome://` 映射依赖 XPI 安装后
的 `rootURI`。应该每次重新构建 XPI 并安装，或在 Zotero 的配置文件中指向
真实 XPI 路径进行调试。

### 更新时

- `manifest.json` 里的 `version` 必须递增；
- 不要修改插件 ID `zotero-texlink@yuweidong.dev`，否则会被当成另一个插件；
- 若模型文件变化，同步更新 `texlink-model.json` 中的 SHA256；
- 升级后完全退出并重启 Zotero，避免旧 Worker 仍持有旧模型。

## 6. 关于“权限声明”

Zotero 10 的插件 `manifest.json` 沿用 Zotero 7 的字段子集：
`manifest_version`、`name`、`version`、`description`、`author`、`icons`、
`applications.zotero` 等。它**不是**普通 Firefox WebExtension，也没有
`permissions` 字段可声明 `webRequest`/`storage` 等权限。

`applications.zotero` 中 `id`、`update_url`、`strict_max_version` 是
Zotero 10 安装校验的硬性字段。`update_url` 还必须是 `https:` 开头，否则
AddonManager 的 `checkUpdateSecurity` 会把插件标为 `appDisabled`。
V0.1.2 使用 `https://zotero-texlink.invalid/updates.json` 作为不带真实
服务器的占位地址；插件运行时代码不会请求它。正式分发时应替换为真实的
HTTPS 更新清单 URL。

本插件的“能力边界”由代码本身保证：

- 只访问 `chrome://zotero-texlink/` 内部资源；
- 只调用 Zotero 对象模型和内部 Reader 的只读 UI 字段；
- 不发起外部网络请求；
- 不调用外部进程；
- 模型、WASM、tokenizer 全量随包。

因此清单中没有 `permissions`，这是正确做法，不是遗漏。

## 7. 签名与分发

Zotero 插件默认不需要 Mozilla 签名。公开分发时建议：

1. 发布 `.xpi` 和对应的 `.sha256`；
2. 在 README 中说明模型来源与 MIT 许可；
3. 如果通过 Zotero 插件市场或组织内部审核，按审核方的签名/供应链要求
   处理；不要伪造 Mozilla 签名。
