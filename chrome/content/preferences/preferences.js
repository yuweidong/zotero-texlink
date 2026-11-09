/*
 * TexLink preferences pane.
 *
 * This script is loaded into the preferences window by
 * Zotero.PreferencePanes.register(). It reads and writes the same
 * extensions.zotero.texlink.* preferences used by texlink-service.js.
 */
"use strict";

(function () {
  const PREFIX = "extensions.zotero.texlink.";
  const DEFAULTS = Object.freeze({
    enabled: true,
    warmupOnStartup: true,
    maxNewTokens: 384,
    noteTarget: "auto",
    logNoteTag: "texlink-formula-log",
    logNoteTitle: "TexLink Formula Notes",
    openNoteAfterInsert: false,
    promptForComment: false,
    autoProcessNewScreenshots: false,
    shortcut: "accel,shift,L",
    binarize: false,
    maxCommentLength: 2000,
    debug: false,
    diagnosticLog: false
  });

  // Fallback used only if the service has not exposed its template yet.
  // Keep this in sync with DEFAULT_NOTE_TEMPLATE in texlink-service.js.
  const FALLBACK_TEMPLATE = [
    '<blockquote data-texlink-entry="{{id}}" data-texlink-annotation="{{annotationKey}}" data-texlink-confidence="{{confidence}}">',
    '  <h3>TexLink formula anchor</h3>',
    '  <pre class="math">$${{latexRaw}}$$</pre>',
    '  <p><strong>Page:</strong> {{pageLabel}} | <strong>Extracted:</strong> {{timestamp}}</p>',
    '  <p><strong>Source:</strong> {{sourceTitle}} | <a href="{{pdfLink}}">Open in PDF</a> | <a href="{{itemLink}}">View item</a></p>',
    '  {{commentBlock}}',
    '  <p><strong>LaTeX source:</strong></p>',
    '  <pre>{{latexRaw}}</pre>',
    '</blockquote>'
  ].join("\n");

  let root = null;
  let statusTimer = null;
  let statusSeq = 0;

  function byId(id) {
    return root?.querySelector(`#${id}`) || null;
  }

  function getPref(key, fallback) {
    try {
      const value = Zotero.Prefs.get(PREFIX + key, true);
      return value === undefined || value === null ? fallback : value;
    }
    catch (error) {
      return fallback;
    }
  }

  function getDefaultTemplate() {
    try {
      const template = Zotero.TexLink?.getDefaultNoteTemplate?.();
      return template || FALLBACK_TEMPLATE;
    }
    catch (error) {
      return FALLBACK_TEMPLATE;
    }
  }

  function setPref(key, value) {
    Zotero.Prefs.set(PREFIX + key, value, true);
  }

  async function formatLocalized(key, fallback) {
    try {
      const doc = root?.ownerDocument;
      if (doc?.l10n?.formatValue) {
        const value = await doc.l10n.formatValue(key);
        if (value) return value;
      }
    }
    catch (error) {
      // Fall back to the English string below.
    }
    return fallback;
  }

  function showStatus(key, kind = "", fallback = "") {
    const status = byId("texlink-pref-status");
    if (!status) return;
    const seq = ++statusSeq;
    formatLocalized(key, fallback).then((message) => {
      if (seq !== statusSeq || !status.isConnected) return;
      status.textContent = message;
      status.classList.remove("is-error", "is-ok");
      if (kind === "error") status.classList.add("is-error");
      if (kind === "ok") status.classList.add("is-ok");
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        if (status) status.textContent = "";
      }, 6000);
    });
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
  }

  function populate() {
    byId("texlink-pref-enabled").checked = !!getPref("enabled", DEFAULTS.enabled);
    byId("texlink-pref-warmup").checked = !!getPref("warmupOnStartup", DEFAULTS.warmupOnStartup);
    byId("texlink-pref-open-note").checked = !!getPref("openNoteAfterInsert", DEFAULTS.openNoteAfterInsert);
    byId("texlink-pref-prompt-comment").checked = !!getPref("promptForComment", DEFAULTS.promptForComment);
    byId("texlink-pref-auto-process").checked = !!getPref("autoProcessNewScreenshots", DEFAULTS.autoProcessNewScreenshots);
    byId("texlink-pref-binarize").checked = !!getPref("binarize", DEFAULTS.binarize);
    byId("texlink-pref-debug").checked = !!getPref("debug", DEFAULTS.debug);
    byId("texlink-pref-diagnostic").checked = !!getPref("diagnosticLog", DEFAULTS.diagnosticLog);

    byId("texlink-pref-max-tokens").value = String(getPref("maxNewTokens", DEFAULTS.maxNewTokens));
    byId("texlink-pref-max-comment").value = String(getPref("maxCommentLength", DEFAULTS.maxCommentLength));
    byId("texlink-pref-shortcut").value = String(getPref("shortcut", DEFAULTS.shortcut));
    byId("texlink-pref-log-tag").value = String(getPref("logNoteTag", DEFAULTS.logNoteTag));
    let defaultLogTitle = DEFAULTS.logNoteTitle;
    try {
      defaultLogTitle = Zotero.TexLink?.getDefaultLogNoteTitle?.() || defaultLogTitle;
    }
    catch (error) { /* use the English fallback */ }
    let hasCustomLogTitle = false;
    try {
      hasCustomLogTitle = !!Zotero.Prefs.prefHasUserValue(PREFIX + "logNoteTitle");
    }
    catch (error) { /* treat as default */ }
    byId("texlink-pref-log-title").value = hasCustomLogTitle
      ? String(getPref("logNoteTitle", defaultLogTitle))
      : String(defaultLogTitle);
    byId("texlink-pref-note-template").value = String(
      getPref("noteTemplate", getDefaultTemplate())
    );

    const target = String(getPref("noteTarget", DEFAULTS.noteTarget));
    const select = byId("texlink-pref-note-target");
    if ([...select.options].some((option) => option.value === target)) {
      select.value = target;
    }
    else {
      select.value = DEFAULTS.noteTarget;
    }
  }

  function bindCheckbox(id, key, onChange) {
    byId(id).addEventListener("change", (event) => {
      setPref(key, !!event.target.checked);
      if (onChange) onChange();
      else showStatus("texlink-status-saved", "ok", "Saved.");
    });
  }

  function bindText(id, key, options = {}) {
    byId(id).addEventListener("change", (event) => {
      let value = String(event.target.value || "").trim();
      if (!value && options.defaultValue) {
        value = options.defaultValue;
        event.target.value = value;
      }
      if (!value) {
        showStatus("texlink-status-empty", "error", "This value cannot be empty.");
        event.target.value = String(getPref(key, options.defaultValue || ""));
        return;
      }
      if (options.validate && !options.validate(value)) {
        showStatus(
          options.errorKey || "texlink-status-saved",
          "error",
          options.errorFallback || "Invalid value."
        );
        event.target.value = String(getPref(key, options.defaultValue || value));
        return;
      }
      setPref(key, value);
      showStatus("texlink-status-saved", "ok", "Saved.");
    });
  }

  function bindNumber(id, key, min, max, fallback) {
    byId(id).addEventListener("change", (event) => {
      const value = clampInteger(event.target.value, min, max, fallback);
      event.target.value = String(value);
      setPref(key, value);
      showStatus("texlink-status-saved", "ok", "Saved.");
    });
  }

  function bind() {
    bindCheckbox("texlink-pref-enabled", "enabled", () => {
      showStatus(
        "texlink-status-enabled-restart",
        "ok",
        "Saved. Restart Zotero for the master switch change to take effect."
      );
    });
    bindCheckbox("texlink-pref-warmup", "warmupOnStartup", () => {
      showStatus(
        "texlink-status-warmup-restart",
        "ok",
        "Saved. Warmup changes take effect after a restart."
      );
    });
    bindCheckbox("texlink-pref-open-note", "openNoteAfterInsert");
    bindCheckbox("texlink-pref-prompt-comment", "promptForComment");
    bindCheckbox("texlink-pref-auto-process", "autoProcessNewScreenshots");
    bindCheckbox("texlink-pref-binarize", "binarize");
    bindCheckbox("texlink-pref-debug", "debug");
    bindCheckbox("texlink-pref-diagnostic", "diagnosticLog");

    bindNumber("texlink-pref-max-tokens", "maxNewTokens", 1, 512, DEFAULTS.maxNewTokens);
    bindNumber("texlink-pref-max-comment", "maxCommentLength", 1, 10000, DEFAULTS.maxCommentLength);

    bindText("texlink-pref-shortcut", "shortcut", {
      defaultValue: DEFAULTS.shortcut,
      validate: (value) => /^[a-z0-9,+\s-]+$/i.test(value),
      errorKey: "texlink-status-shortcut-invalid",
      errorFallback: "Use comma-separated modifiers and a key, such as accel,shift,L."
    });
    bindText("texlink-pref-log-tag", "logNoteTag", {
      defaultValue: DEFAULTS.logNoteTag
    });
    bindText("texlink-pref-log-title", "logNoteTitle", {
      defaultValue: DEFAULTS.logNoteTitle
    });

    byId("texlink-pref-note-target").addEventListener("change", (event) => {
      setPref("noteTarget", String(event.target.value));
      showStatus("texlink-status-saved", "ok", "Saved.");
    });

    byId("texlink-pref-note-template").addEventListener("change", (event) => {
      const value = String(event.target.value || "");
      if (!value.includes("{{latexRaw}}") || !value.includes("{{pageLabel}}")) {
        showStatus(
          "texlink-status-template-placeholders",
          "error",
          "The template must contain the required LaTeX source and page-label placeholders."
        );
        event.target.value = String(getPref("noteTemplate", getDefaultTemplate()));
        return;
      }
      setPref("noteTemplate", value);
      showStatus("texlink-status-saved", "ok", "Saved.");
    });

    byId("texlink-pref-reset-template").addEventListener("click", () => {
      const value = getDefaultTemplate();
      byId("texlink-pref-note-template").value = value;
      setPref("noteTemplate", value);
      showStatus(
        "texlink-status-template-restored",
        "ok",
        "Default formula template restored."
      );
    });

    byId("texlink-pref-reset-all").addEventListener("click", async () => {
      const message = await formatLocalized(
        "texlink-status-reset-confirm",
        "Reset all TexLink preferences to their defaults?"
      );
      if (!window.confirm(message)) {
        return;
      }
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (key === "logNoteTitle" || key === "noteTemplate") continue;
        setPref(key, value);
      }
      let defaultLogTitle = DEFAULTS.logNoteTitle;
      try {
        defaultLogTitle = Zotero.TexLink?.getDefaultLogNoteTitle?.() || defaultLogTitle;
      }
      catch (error) { /* use the English fallback */ }
      setPref("logNoteTitle", defaultLogTitle);
      setPref("noteTemplate", getDefaultTemplate());
      populate();
      showStatus(
        "texlink-status-reset",
        "ok",
        "All TexLink preferences were reset. Restart Zotero for startup changes."
      );
    });
  }

  function init(win) {
    if (!win || root) return;
    root = win.document.getElementById("texlink-prefpane");
    if (!root || root.__texlinkInitialized) return;
    root.__texlinkInitialized = true;
    populate();
    bind();
  }

  Zotero.TexLinkPrefs = { init };

  function boot() {
    const candidate = window.document.getElementById("texlink-prefpane");
    if (candidate) {
      init(window);
      return;
    }
    setTimeout(boot, 100);
  }

  setTimeout(boot, 0);
})();
