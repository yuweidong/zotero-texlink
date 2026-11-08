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
  version: "0.1.4",
  rootURI: "file:///test/"
});
const source = {
  annotationKey: "ABCD1234",
  pageLabel: "12",
  sourceTitle: "Paper",
  pdfLink: "zotero://open-pdf/library/items/PDFKEY?page=12&annotation=ABCD1234",
  itemLink: "zotero://select/library/items/ITEMKEY"
};

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

const note = {
  getNote() {
    return '<blockquote data-texlink-entry="ABCD1234-test"></blockquote>';
  }
};
assert.strictEqual(service._noteHasEntry(note, "ABCD1234-test"), true);
assert.strictEqual(service._noteHasEntry(note, "other"), false);

console.log("[OK] service helper tests passed");
