#!/usr/bin/env node
/*
 * Pure-JS ByteLevel BPE decoder regression test.
 *
 * Usage:
 *   node tests/tokenizer_decode.test.js
 *
 * The expected string comes from the same tokenizer decoded with Python
 * `tokenizers`. The test does not need Zotero; it loads only the static decoder
 * from the service file.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const context = {
  Zotero: {},
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

const tokenizer = JSON.parse(
  fs.readFileSync(path.join(root, "chrome/content/models/tokenizer.json"), "utf8")
);
const decoder = new context.TexLinkService.BPEDecoder(tokenizer);
const ids = [
  64, 370, 264, 262, 279, 261, 265, 262, 263, 426, 261, 508, 313, 265, 262,
  272, 282, 265, 262, 269, 261, 261, 307, 296, 282, 508, 270, 508, 263, 277,
  262, 263, 418, 263, 356, 261, 269
];
const expected =
  "\\int _ { 0 } ^ { \\infty } \\! e ^ { - x ^ { 2 } } \\, d x \\! = \\! " +
  "\\frac { \\sqrt \\pi } 2";
assert.strictEqual(decoder.decode(ids), expected);
assert.strictEqual(decoder.decode([0, 1, 2, 3, 4]), "");
console.log("[OK] ByteLevel BPE decoder matches the Python tokenizer output");
