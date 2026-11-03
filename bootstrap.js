/*
 * TexLink — Zotero 10 Bootstrap 插件入口
 *
 * 本文件必须位于 XPI 根目录，由 Zotero.Plugins 通过 Services.scriptloader
 * 加载到插件专属的 Cu.Sandbox 中。它不操作任何 UI 细节，只负责：
 *   1. 注册 chrome:// 资源映射；
 *   2. 把 texlink-service.js 载入插件沙箱；
 *   3. 把 Zotero 的窗口生命周期回调转发给服务对象；
 *   4. 在禁用/卸载时释放资源。
 *
 * 中文说明：
 * - Zotero 10 仍然使用 bootstrapped extension 生命周期，而不是 XUL overlay。
 * - 不能在顶层直接访问 window/document；窗口相关逻辑必须放到 onMainWindowLoad。
 * - `rootURI` 在 XPI 环境中是 jar:file:///... 形式，末尾一定有 "/"。
 * - `chrome://` 映射通过 AddonManager 的 registerChrome() 动态注册，
 *   这是 Zotero 插件访问自身打包资源的常用做法；等价于旧式 chrome.manifest。
 */

"use strict";

var chromeHandle = null;

const TEXLINK_PLUGIN_ID = "zotero-texlink@yuweidong.dev";
const TEXLINK_CHROME_NAME = "zotero-texlink";
const TEXLINK_LOG_PREFIX = "[TexLink]";

function texlinkLog(message) {
  Zotero.debug(`${TEXLINK_LOG_PREFIX} ${message}`);
}

function texlinkError(message, error) {
  Zotero.logError(`[TexLink] ${message}`);
  if (error) {
    Zotero.logError(error);
  }
}

/**
 * extension 安装时调用。V0.1 不写注册表，无需额外操作。
 * 注意：install 在 profile 内执行，可能早于 Zotero 初始化。
 */
function install() {
  texlinkLog("install");
}

/**
 * 插件启用 / Zotero 启动时调用。
 *
 * @param {{id: string, version: string, rootURI: string}} data
 * @param {number} reason Zotero 注入的 APP_STARTUP / ADDON_ENABLE 等常量
 */
async function startup({ id, version, rootURI }, reason) {
  texlinkLog(`startup ${version}`);

  if (id !== TEXLINK_PLUGIN_ID) {
    throw new Error(`Unexpected plugin id: ${id}`);
  }

  // Zotero 的很多服务尚未就绪；先等核心初始化完成。
  await Zotero.initializationPromise;

  /*
   * 动态注册 chrome 包：
   *   chrome://zotero-texlink/content/xxx
   *   -> <XPI>/chrome/content/xxx
   *
   * 这样 Worker、WASM、ONNX、tokenizer 都可以通过内部协议加载，
   * 不需要 file:// 或任何外部 HTTP 服务器。
   */
  try {
    const aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", TEXLINK_CHROME_NAME, rootURI + "chrome/content/"]
    ]);
    texlinkLog("chrome package registered");
  }
  catch (error) {
    // 注册失败无法继续：Worker 和模型都依赖 chrome:// 路径。
    texlinkError("Failed to register chrome package", error);
    throw error;
  }

  /*
   * 插件脚本必须显式加载到当前 sandbox。
   * 这里把少量上下文传进去，服务类会挂到 Zotero.TexLink 上，
   * 后续窗口回调就能从任意 Zotero 上下文访问到同一个实例。
   */
  const context = {
    rootURI,
    pluginID: id,
    pluginVersion: version,
    chromeBase: `chrome://${TEXLINK_CHROME_NAME}/content/`
  };
  context._globalThis = context;

  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/texlink-service.js",
    context
  );

  if (!context.TexLinkService) {
    throw new Error("texlink-service.js did not define TexLinkService");
  }

  // 插件升级/热重载时先关闭旧实例，避免旧 Worker/Notifier 与新实例并存。
  if (Zotero.TexLink) {
    try {
      await Zotero.TexLink.shutdown();
    }
    catch (error) {
      texlinkError("Failed to shut down previous TexLink instance", error);
    }
    delete Zotero.TexLink;
  }

  Zotero.TexLink = new context.TexLinkService({
    id,
    version,
    rootURI,
    chromeBase: context.chromeBase
  });

  try {
    await Zotero.TexLink.startup(reason);
  }
  catch (error) {
    texlinkError("TexLink startup failed", error);
    // 不让异常冒泡到 Zotero 的启动流程，避免影响其它插件；
    // 服务内部会把错误记录到调试输出，并在用户触发时给出提示。
  }
}

/**
 * 主窗口加载完成后调用。Zotero 可能在一次会话中重新打开主窗口，
 * 因此所有窗口级 DOM/事件绑定都必须放在这里，并且可以重复调用。
 */
async function onMainWindowLoad({ window }) {
  try {
    await Zotero.TexLink?.onMainWindowLoad(window);
  }
  catch (error) {
    texlinkError("onMainWindowLoad failed", error);
  }
}

/**
 * 主窗口关闭前调用。必须清理窗口级监听器，避免内存泄漏。
 */
function onMainWindowUnload({ window }) {
  try {
    Zotero.TexLink?.onMainWindowUnload(window);
  }
  catch (error) {
    texlinkError("onMainWindowUnload failed", error);
  }
}

/**
 * 插件禁用 / 卸载 / Zotero 退出时调用。
 *
 * APP_SHUTDOWN 时直接返回是 Zotero 插件的惯用做法：
 * 应用即将退出，XPI 资源马上销毁，没必要再做耗时清理。
 */
async function shutdown({ id, version, rootURI }, reason) {
  texlinkLog(`shutdown ${version}, reason=${reason}`);
  if (reason === APP_SHUTDOWN) {
    return;
  }

  try {
    await Zotero.TexLink?.shutdown();
  }
  catch (error) {
    texlinkError("Error while shutting down TexLink", error);
  }
  finally {
    delete Zotero.TexLink;

    if (chromeHandle) {
      try {
        chromeHandle.destruct();
      }
      catch (error) {
        texlinkError("Failed to unregister chrome package", error);
      }
      chromeHandle = null;
    }
  }
}

/**
 * 卸载时调用。shutdown 已经释放了运行期资源，这里只需记录。
 */
function uninstall() {
  texlinkLog("uninstall");
}
