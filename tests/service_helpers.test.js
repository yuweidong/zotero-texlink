#!/usr/bin/env node
/*
 * Unit tests for deterministic service helpers that do not need Zotero.
 *
 * Usage:
 *   node tests/service_helpers.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const prefs = {
  "extensions.zotero.texlink.noteTemplate": null,
  "extensions.zotero.texlink.maxNewTokens": 384
};
const context = {
  Zotero: {
    Prefs: {
      get(key) {
        return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null;
      }
    },
    debug() {},
    logError() {}
  },
  Services: {},
  Components: {},
  ChromeUtils: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextDecoder,
  TextEncoder,
  DOMParser: class {},
  Worker: class {},
  XMLHttpRequest: class {},
  fetch: async () => {}
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(root, "chrome/content/scripts/texlink-service.js"), "utf8"),
  context
);

const service = new context.TexLinkService({
  id: "zotero-texlink@yuweidong.dev",
  version: "0.1.5",
  rootURI: "file:///test/"
});
const source = {
  annotationKey: "ABCD1234",
  pageLabel: "12",
  sourceTitle: "Paper",
  pdfLink: "zotero://open-pdf/library/items/PDFKEY?page=12&annotation=ABCD1234",
  itemLink: "zotero://select/library/items/ITEMKEY"
};

const noisyLatex =
  "F _ { t } = f _ { \\mathrm { e n c } } ( I _ { t } ) , \\quad " +
  "[ z _ { t } ^ { \\prime } , F _ { t } ^ { \\prime } ] , " +
  "s _ { t } = f _ { \\mathrm { d e c } } ( [ z , F _ { t } ] , s _ { t - 1 } )";
const compactLatex =
  "F_{t}=f_{\\mathrm{enc}}(I_{t}),\\quad" +
  "[z_{t}^{\\prime},F_{t}^{\\prime}],s_{t}=f_{\\mathrm{dec}}([z,F_{t}],s_{t-1})";
assert.strictEqual(service._compactLatexSpacing(noisyLatex), compactLatex);
assert.strictEqual(service._compactLatexSpacing("\\alpha x"), "\\alpha{}x");
assert.strictEqual(service._compactLatexSpacing("\\text{a b} + c"), "\\text{a b}+c");
assert.strictEqual(service._compactLatexSpacing("a \\, b"), "a\\,b");
assert.strictEqual(service._compactLatexSpacing("\\frac { 1 } { 2 }"), "\\frac{1}{2}");

assert.strictEqual(service._entryIdFor("ABCD1234", "x+y"), service._entryIdFor("ABCD1234", "x+y"));
assert.notStrictEqual(service._entryIdFor("ABCD1234", "x+y"), service._entryIdFor("ABCD1234", "x-y"));
assert.strictEqual(
  service._escapeHTML('<a href="x">A&B</a>'),
  "&lt;a href=&quot;x&quot;&gt;A&amp;B&lt;/a&gt;"
);
assert.strictEqual(service._maxNewTokens(900), 512);
assert.strictEqual(service._maxNewTokens(0), 384);

const html = service._renderEntryHTML({
  latex: "\\frac{1}{2}",
  timestamp: "2026-11-06T00:00:00.000Z",
  entryId: "ABCD1234-test",
  source,
  comment: "note",
  confidence: 0.875
});
assert.match(html, /data-texlink-confidence="0\.875"/);
assert.match(html, /\\frac\{1\}\{2\}/);
assert.match(html, /data-texlink-entry="ABCD1234-test"/);

const unsafeTemplate =
  '<blockquote data-texlink-entry="{{id}}">' +
  '<script>alert(1)</script>{{latexRaw}}{{pageLabel}}' +
  "</blockquote>";
prefs["extensions.zotero.texlink.noteTemplate"] = unsafeTemplate;
const safeHtml = service._renderEntryHTML({
  latex: "x",
  timestamp: "2026-11-06T00:00:00.000Z",
  entryId: "ABCD1234-test",
  source,
  confidence: 0.5
});
assert.ok(!safeHtml.includes("<script>"));
assert.match(safeHtml, /data-texlink-confidence="0\.500"/);

prefs["extensions.zotero.texlink.noteTemplate"] =
  '<blockquote data-texlink-entry="{{id}}">' +
  '<img src="https://example.com/tracker.png">' +
  "{{latexRaw}}{{pageLabel}}</blockquote>";
const remoteSafeHtml = service._renderEntryHTML({
  latex: "x",
  timestamp: "2026-11-06T00:00:00.000Z",
  entryId: "ABCD1234-test",
  source,
  confidence: 0.5
});
assert.ok(!remoteSafeHtml.includes("example.com"));
assert.match(remoteSafeHtml, /data-texlink-confidence="0\.500"/);

// ---------------------------------------------------------------------------
// v1.0.0 regressions
// ---------------------------------------------------------------------------

// Spacing must never invent an empty group after a command that requires a
// following delimiter/argument, and must keep spaces inside operator names.
assert.strictEqual(service._compactLatexSpacing("\\left x + \\right y"), "\\left x+\\right y");
assert.strictEqual(service._compactLatexSpacing("\\operatorname{a b}"), "\\operatorname{a b}");
assert.strictEqual(
  service._compactLatexSpacing("\\begin {equation} x \\end {equation}"),
  "\\begin{equation}x\\end{equation}"
);
assert.strictEqual(service._compactLatexSpacing("\\alpha x"), "\\alpha{}x");
assert.strictEqual(service._compactLatexSpacing("\\text{a b} + c"), "\\text{a b}+c");
assert.strictEqual(service._compactLatexSpacing("a \\, b"), "a\\,b");

const note = {
  getNote() {
    return '<blockquote data-texlink-entry="ABCD1234-test"></blockquote>';
  }
};
assert.strictEqual(service._noteHasEntry(note, "ABCD1234-test"), true);
assert.strictEqual(service._noteHasEntry(note, "other"), false);
assert.strictEqual(
  service._noteHasEntry({ getNote: () => '<blockquote data-texlink-id="ABCD1234"></blockquote>' }, "x", "ABCD1234"),
  true
);

// A 0.1.5 note has only the legacy entry id; v1.0.0 must still find and
// replace that block instead of appending a duplicate.
const legacyBlock = [
  '<blockquote data-texlink-entry="ABCD1234-abc" data-texlink-annotation="ABCD1234" data-texlink-confidence="0.420">',
  '  <h3>TexLink formula anchor</h3>',
  '  <pre class="math">$$x^2 + y^2 = z^2$$</pre>',
  '  <p><strong>Page:</strong> 12</p>',
  '  <p><strong>Comment:</strong> keep this note</p>',
  '  <pre>x^2 + y^2 = z^2</pre>',
  '</blockquote>'
].join("\n");
const legacyNote = `<div data-schema-version="9">${legacyBlock}</div>`;
assert.strictEqual(
  service._findEntryBlockInHTML(legacyNote, "ABCD1234", "ABCD1234-abc"),
  legacyBlock
);
assert.strictEqual(
  service._extractLatexFromBlock(legacyBlock),
  "x^2 + y^2 = z^2"
);
assert.strictEqual(
  service._extractCommentFromBlock(legacyBlock),
  "keep this note"
);

const newBlock = service._renderEntryHTML({
  latex: "a+b",
  timestamp: "2026-11-25T00:00:00.000Z",
  entryId: "ABCD1234-new",
  stableId: "ABCD1234",
  source,
  comment: "keep this note",
  confidence: 0.91
});
assert.match(newBlock, /data-texlink-id="ABCD1234"/);
assert.match(newBlock, /data-texlink-latex="a\+b"/);
// v1.0.0 blocks include the <strong> label inside the comment paragraph;
// extraction must not leak it into the next replacement.
assert.strictEqual(service._extractCommentFromBlock(newBlock), "keep this note");
const replacedNote = service._replaceEntryInHTML(legacyNote, legacyBlock, newBlock);
assert.ok(replacedNote.includes('data-texlink-id="ABCD1234"'));
assert.ok(!replacedNote.includes("x^2 + y^2 = z^2"));
assert.strictEqual(service._replaceEntryInHTML(legacyNote, "missing", newBlock), null);

const collected = service._collectFormulasFromHTML(replacedNote);
assert.strictEqual(collected.length, 1);
assert.strictEqual(collected[0].latex, "a+b");
assert.strictEqual(collected[0].stableId, "ABCD1234");

// Review markers are opt-in and must not appear in the default template.
prefs["extensions.zotero.texlink.noteTemplate"] = null;
const plain = service._renderEntryHTML({
  latex: "x", timestamp: "t", entryId: "K-1", stableId: "K", source, confidence: 0.2
});
assert.ok(!plain.includes("texlink-review"));
prefs["extensions.zotero.texlink.showLowConfidenceHint"] = true;
const flagged = service._renderEntryHTML({
  latex: "x", timestamp: "t", entryId: "K-1", stableId: "K", source, confidence: 0.2
});
assert.ok(flagged.includes('data-texlink-review="low"'));
const confident = service._renderEntryHTML({
  latex: "x", timestamp: "t", entryId: "K-1", stableId: "K", source, confidence: 0.95
});
assert.ok(!confident.includes("texlink-review"));
delete prefs["extensions.zotero.texlink.showLowConfidenceHint"];

assert.strictEqual(service._confidenceThreshold(), 0.7);
assert.strictEqual(service._confidenceIsLow(0.69), true);
assert.strictEqual(service._confidenceIsLow(0.7), false);
assert.strictEqual(service._confidenceIsLow(""), false);

const clip = service._makeClipboardResult("x+y", source, "t", 0.9);
assert.strictEqual(clip.latex, "x+y");
assert.strictEqual(clip.inline, "$x+y$");
assert.ok(clip.markdown.includes("$$\nx+y\n$$"));

(async () => {
  // `active` must no longer silently fall back to the dedicated note.
  const originalFind = service._findActiveEditorForSource;
  const originalLog = service._findOrCreateLogNote;
  service._findActiveEditorForSource = () => null;
  service._findOrCreateLogNote = async () => {
    throw new Error("active mode must not create a dedicated note");
  };
  prefs["extensions.zotero.texlink.noteTarget"] = "active";
  await assert.rejects(
    () => service._resolveNoteTarget({ id: 1 }),
    /No editable open note/
  );
  prefs["extensions.zotero.texlink.noteTarget"] = "auto";
  service._findActiveEditorForSource = originalFind;
  service._findOrCreateLogNote = originalLog;

  // Settings must register once, from the add-on root URI (not chrome://,
  // whose dynamic registration order caused "Settings does not open"), must
  // be idempotent, and must always open a Preferences window.
  const registered = [];
  context.Zotero.PreferencePanes = {
    pluginPanes: [],
    async register(options) {
      registered.push(options);
      this.pluginPanes.push({ ...options });
      return options.id;
    },
    unregister(id) {
      this.pluginPanes = this.pluginPanes.filter((pane) => pane.id !== id);
    }
  };
  context.Zotero.Utilities = {
    Internal: {
      opened: [],
      openPreferences(paneID) { this.opened.push(paneID); }
    }
  };
  service._prefsPaneRegistered = false;
  service._prefsPanePromise = null;
  const paneID = await service.registerPreferencesPane();
  assert.strictEqual(paneID, "texlink-preferences");
  assert.strictEqual(registered.length, 1);
  assert.strictEqual(
    registered[0].src,
    "file:///test/chrome/content/preferences/preferences.xhtml"
  );
  // Icons use an inline data URI so no chrome:/jar: URL resolution or theme
  // context-fill can make them disappear.
  assert.ok(registered[0].image.startsWith("data:image/png;base64,"));
  // Idempotent: repeated calls reuse the registered pane, no duplicate.
  await service.registerPreferencesPane();
  assert.strictEqual(registered.length, 1);
  await service.openPreferences();
  assert.deepStrictEqual(
    context.Zotero.Utilities.Internal.opened,
    ["texlink-preferences"]
  );

  // Zotero already holding a pane with our id (e.g. hot reload) must be
  // reused rather than re-registered, which would throw "already registered".
  service._prefsPaneRegistered = false;
  service._prefsPaneID = null;
  service._prefsPanePromise = null;
  const hotPanes = [{ id: "texlink-preferences", pluginID: service.id }];
  context.Zotero.PreferencePanes.pluginPanes = hotPanes;
  const beforeHot = registered.length;
  assert.strictEqual(await service.registerPreferencesPane(), "texlink-preferences");
  assert.strictEqual(registered.length, beforeHot, "existing pane reused, not re-registered");

  // openPreferences() lazily retries when Zotero removed the pane, and always
  // opens a Preferences window rather than failing silently.
  service._prefsPaneRegistered = false;
  service._prefsPaneID = null;
  service._prefsPanePromise = null;
  context.Zotero.PreferencePanes.pluginPanes = [];
  context.Zotero.Utilities.Internal.opened.length = 0;
  await service.openPreferences();
  assert.deepStrictEqual(context.Zotero.Utilities.Internal.opened, ["texlink-preferences"]);

  // Core regression: a settings-pane registration failure must NOT disable
  // recognition. The old code awaited registration inside startup() before
  // wiring the worker/menu/notifier, so a pane error took down both features.
  const failingPanes = {
    pluginPanes: [],
    register() { return Promise.reject(new Error("boom")); }
  };
  context.Zotero.PreferencePanes = failingPanes;
  const failingService = new context.TexLinkService({
    id: "zotero-texlink@yuweidong.dev",
    version: "1.0.0",
    rootURI: "file:///test/",
    chromeBase: "chrome://zotero-texlink/content/"
  });
  // Stub every recognition-side effect startup() performs after the pane
  // step. If any of these is skipped, the assertion below fails.
  const touched = [];
  failingService._initLocalization = () => touched.push("l10n");
  failingService._migrateLegacyTemplate = async () => touched.push("migrate");
  failingService._readJSON = async () => ({ displayName: "m", files: { tokenizer: "t.json" } });
  failingService._createWorker = () => touched.push("worker");
  failingService._registerReaderContextMenu = () => touched.push("contextMenu");
  failingService._registerNotifier = () => touched.push("notifier");
  failingService._bindAllReaders = () => {};
  failingService.onMainWindowLoad = async () => {};
  context.Zotero.uiReadyPromise = Promise.resolve();
  context.Zotero.getMainWindows = () => [];
  const originalBPEDecoder = context.TexLinkBPEDecoder;
  context.TexLinkBPEDecoder = function () { touched.push("tokenizer"); };
  context.Zotero.Prefs = {
    get(key, global) { return undefined; },
    hasUserValue() { return false; }
  };
  // Timers are no-ops here so the test process exits; shutdown() would need
  // Zotero APIs beyond this minimal context.
  const originalSetInterval = context.setInterval;
  const originalSetTimeout = context.setTimeout;
  context.setInterval = () => 0;
  context.setTimeout = () => 0;
  await failingService.startup();
  context.TexLinkBPEDecoder = originalBPEDecoder;
  context.setInterval = originalSetInterval;
  context.setTimeout = originalSetTimeout;
  assert.ok(touched.includes("worker"), "worker initialized despite pane failure");
  assert.ok(touched.includes("contextMenu"), "context menu initialized despite pane failure");
  assert.ok(touched.includes("notifier"), "notifier initialized despite pane failure");

  console.log("[OK] service helper tests passed (v1.0.0)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
