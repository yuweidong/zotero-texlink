/*
 * TexLink - Zotero 10 bootstrap entry point
 *
 * This file must live at the root of the XPI. Zotero loads it through
 * Services.scriptloader into a plugin-specific Cu.Sandbox. The bootstrap owns
 * only lifecycle and resource wiring:
 *
 *   1. register the plugin's chrome:// package;
 *   2. load texlink-service.js into the plugin sandbox;
 *   3. forward Zotero window lifecycle callbacks to the service;
 *   4. release resources when the plugin is disabled or uninstalled.
 *
 * Notes:
 * - Zotero 10 uses the bootstrapped-extension lifecycle, not XUL overlays.
 * - Never access window/document at the top level; window-specific work must
 *   happen in onMainWindowLoad().
 * - rootURI is a jar:file:///... URL in an installed XPI and always ends with "/".
 * - The chrome:// mapping is registered dynamically with the Addon Manager.
 *   This is the modern equivalent of a static chrome.manifest and keeps the
 *   resource namespace scoped to this plugin.
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
 * Called when the extension is installed. No persistent registry entries are
 * needed. Note that install() runs in the profile and may happen before Zotero
 * has finished initializing.
 */
function install() {
  texlinkLog("install");
}

/**
 * Called when the plugin is enabled or when Zotero starts.
 *
 * @param {{id: string, version: string, rootURI: string}} data
 * @param {number} reason Zotero-provided APP_STARTUP / ADDON_ENABLE constant
 */
async function startup({ id, version, rootURI }, reason) {
  texlinkLog(`startup ${version}`);

  if (id !== TEXLINK_PLUGIN_ID) {
    throw new Error(`Unexpected plugin id: ${id}`);
  }

  // Many Zotero services are not ready yet; wait for core initialization.
  await Zotero.initializationPromise;

  /*
   * Register the chrome package:
   *   chrome://zotero-texlink/content/xxx
   *     -> <XPI>/chrome/content/xxx
   *
   * This lets the Worker, WASM, ONNX models, and tokenizer load through an
   * internal protocol. No file:// URLs or external HTTP servers are involved.
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
    // Without the mapping, the Worker and model cannot be loaded.
    texlinkError("Failed to register chrome package", error);
    throw error;
  }

  /*
   * Load the service implementation into this sandbox. A small context object
   * carries the plugin identity and resource base. The service is exposed as
   * Zotero.TexLink so window callbacks can reach the same instance.
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

  // On upgrade or hot reload, stop the previous instance before replacing it
  // so its Worker, observers, and window bindings do not leak.
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
    // Do not abort Zotero's startup sequence because of this plugin. The
    // service logs the error and reports actionable failures to the user.
  }
}

/**
 * Called after a main window has loaded. Zotero can reopen its main window
 * during a session, so all window-level DOM and event wiring belongs here and
 * must be idempotent.
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
 * Called before a main window closes. Remove window-level listeners to avoid
 * memory leaks.
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
 * Called when the plugin is disabled/uninstalled or when Zotero exits.
 *
 * Returning immediately for APP_SHUTDOWN is the usual Zotero plugin pattern:
 * the application is going away and its resources are destroyed shortly.
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
 * Called on uninstall. shutdown() has already released runtime resources.
 */
function uninstall() {
  texlinkLog("uninstall");
}
