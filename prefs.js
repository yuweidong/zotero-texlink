/*
 * TexLink default preferences.
 *
 * Zotero executes this file at plugin startup and provides a global
 * pref(name, value) function. Values written here are defaults; anything set
 * by the user or another plugin through Zotero.Prefs.set() takes precedence.
 * Runtime code always reads through extensions.zotero.texlink.*.
 */

// Default HTML template for one formula record. Placeholders are replaced by
// texlink-service.js.
//
// Notes:
// 1. The Zotero 10 note editor renders native KaTeX math nodes. Block math is
//    represented as <pre class="math">$$...$$</pre>; inline math uses
//    <span class="math">$...$</span>.
// 2. Never place {{latexRaw}} inside an HTML attribute. It is HTML-escaped
//    before being written into the math node.
// 3. Advanced users may customize this template. If {{latexRaw}} or
//    {{pageLabel}} is missing, TexLink falls back to its internal template.
const TEXLINK_DEFAULT_NOTE_TEMPLATE = [
  '<blockquote data-texlink-entry="{{id}}" data-texlink-annotation="{{annotationKey}}" data-texlink-confidence="{{confidence}}">',
  '  <h3>{{anchorTitle}}</h3>',
  '  <pre class="math">$${{latexRaw}}$$</pre>',
  '  <p><strong>{{labelPage}}:</strong> {{pageLabel}} | <strong>{{labelExtracted}}:</strong> {{timestamp}}</p>',
  '  <p><strong>{{labelSource}}:</strong> {{sourceTitle}} | <a href="{{pdfLink}}">{{labelOpenPdf}}</a> | <a href="{{itemLink}}">{{labelViewItem}}</a></p>',
  '  {{commentBlock}}',
  '  <p><strong>{{labelLatexSource}}:</strong></p>',
  '  <pre>{{latexRaw}}</pre>',
  '</blockquote>'
].join('\n');

// Master switch. Existing notes are left untouched when disabled, but TexLink
// stops registering menus, shortcuts, and the automatic screenshot listener.
pref('extensions.zotero.texlink.enabled', true);

// Load and warm up the ONNX model in the background after Zotero starts.
// Warmup runs inside a Web Worker and never blocks the main thread. When this
// is off, the first recognition request takes a few seconds longer.
pref('extensions.zotero.texlink.warmupOnStartup', true);

// Maximum number of generated tokens. Pix2Text-MFR supports up to 512.
pref('extensions.zotero.texlink.maxNewTokens', 384);

// Where formula blocks are written:
//   auto      - append to the open note if it belongs to the same item;
//               otherwise use the dedicated log note, creating it if needed
//   active    - prefer the open note and fall back to the dedicated log note
//   dedicated - always use the dedicated log note
pref('extensions.zotero.texlink.noteTarget', 'auto');

// Tag used to find the dedicated note across multiple extractions. Do not
// remove this tag manually unless you intend to create a new note.
pref('extensions.zotero.texlink.logNoteTag', 'texlink-formula-log');

// Title for a newly created dedicated note. Zotero derives the note title from
// the first heading in the HTML.
pref('extensions.zotero.texlink.logNoteTitle', 'TexLink Formula Notes');

// Open the destination note in a new tab after writing. Disabled by default
// so recognition does not interrupt reading.
pref('extensions.zotero.texlink.openNoteAfterInsert', false);

// Show an optional comment prompt before recognition. Uses the Zotero main
// window's nsIPromptService.
pref('extensions.zotero.texlink.promptForComment', false);

// Listen for newly created native image annotations and process them
// automatically. Disabled by default to avoid treating diagrams as formulas.
pref('extensions.zotero.texlink.autoProcessNewScreenshots', false);

// Keyboard shortcut. Comma-separated; accel is Cmd on macOS and Ctrl elsewhere.
pref('extensions.zotero.texlink.shortcut', 'accel,shift,L');

// Apply Otsu binarization during image preprocessing. Disabled by default:
// Pix2Text-MFR uses a DeiT image processor trained on natural grayscale
// images, so aggressive binarization usually reduces accuracy.
pref('extensions.zotero.texlink.binarize', false);

// Maximum length of the optional comment stored in a formula block.
pref('extensions.zotero.texlink.maxCommentLength', 2000);

// Write detailed Worker round-trip information to the Zotero debug output.
pref('extensions.zotero.texlink.debug', false);

// Write recognition-stage breadcrumbs to a texlink-crash.log file in the
// system temporary directory. Useful when diagnosing a native crash; keep it
// off during normal use.
pref('extensions.zotero.texlink.diagnosticLog', false);

// HTML template used for each formula block. See the notes above.
pref('extensions.zotero.texlink.noteTemplate', TEXLINK_DEFAULT_NOTE_TEMPLATE);
