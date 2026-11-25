texlink-pref-title = TexLink
texlink-pref-tagline = Structured formula anchors for Zotero
texlink-pref-intro = TexLink turns native PDF image annotations into traceable formula blocks in Zotero notes. Recognition runs locally in a Web Worker and never uses an external OCR service or LLM.
texlink-pref-restart-note = Changes are saved immediately. The master switch and startup warmup take effect after the next Zotero restart.

texlink-pref-general = General
texlink-pref-enable = Enable TexLink
texlink-pref-enable-hint = Turning this off unregisters TexLink after the next Zotero restart.
texlink-pref-warmup = Load and warm up the model on startup
texlink-pref-warmup-hint = Warmup happens in the Worker and keeps the first recognition request fast.
texlink-pref-open-note = Open the destination note after writing
texlink-pref-prompt-comment = Ask for an optional comment before recognition
texlink-pref-auto-process = Process new image annotations automatically
texlink-pref-auto-process-hint = This is off by default because diagrams and other non-formula images can also be annotations.

texlink-pref-recognition = Recognition
texlink-pref-max-tokens = Maximum generated tokens
texlink-pref-max-tokens-hint = Pix2Text-MFR supports at most 512 tokens. Longer formulas can be cut off.
texlink-pref-binarize = Apply Otsu binarization before inference
texlink-pref-binarize-hint = Usually off. The model was trained on natural grayscale images, so binarization can reduce accuracy.
texlink-pref-shortcut = Keyboard shortcut
texlink-pref-shortcut-hint = Comma-separated. Use accel for Cmd on macOS and Ctrl elsewhere. Example: accel,shift,L

texlink-pref-note-destination = Note destination
texlink-pref-note-target = Where to write formula blocks
texlink-pref-note-target-auto = Auto: current note for this item, otherwise the dedicated note
texlink-pref-note-target-active = Active: only the open note for this item; show an error if none is open
texlink-pref-note-target-dedicated = Dedicated: always use the dedicated note
texlink-pref-log-tag = Dedicated note tag
texlink-pref-log-tag-hint = Used to find the same note across multiple extractions. Avoid deleting this tag from the note.
texlink-pref-log-title = Dedicated note title
texlink-pref-max-comment = Maximum comment length

texlink-pref-template = Formula block template
texlink-pref-template-hint = The template must contain the LaTeX source and page-label placeholders. Blocks use Zotero's native math node. Do not add scripts, remote images, or event handlers; unsafe templates fall back to the built-in template.
texlink-pref-restore-template = Restore Default Template

texlink-pref-advanced = Advanced
texlink-pref-debug = Write detailed Worker messages to the Zotero debug output
texlink-pref-diagnostic = Write recognition-stage breadcrumbs to texlink-crash.log
texlink-pref-diagnostic-hint = The log is written to the system temporary directory. Leave this off unless you are diagnosing a crash.
texlink-pref-reset-all = Reset All TexLink Preferences

texlink-status-saved = Saved.
texlink-status-enabled-restart = Saved. Restart Zotero for the master switch change to take effect.
texlink-status-warmup-restart = Saved. Warmup changes take effect after a restart.
texlink-status-empty = This value cannot be empty.
texlink-status-shortcut-invalid = Use comma-separated modifiers and a key, such as accel,shift,L.
texlink-status-template-placeholders = The template must contain the required LaTeX source and page-label placeholders.
texlink-status-template-restored = Default formula template restored.
texlink-status-reset = All TexLink preferences were reset. Restart Zotero for startup changes.
texlink-status-reset-confirm = Reset all TexLink preferences to their defaults?

texlink-menu-single = TexLink: Recognize Formula and Add to Note
texlink-menu-multiple = TexLink: Recognize Selected Formulas and Add to Note
texlink-menu-tools = TexLink: Recognize Selected Formula Screenshot
texlink-menu-tools-tooltip = First select a formula with the image annotation tool in the PDF, then click here or use the shortcut.

texlink-progress-preparing = Preparing to recognize formula...
texlink-progress-loading-model = Loading offline model...
texlink-progress-reading = Reading screenshot and running inference...
texlink-progress-preprocessing = Preprocessing image...
texlink-progress-recognizing = Recognizing formula offline...
texlink-progress-writing = Writing to Zotero note...
texlink-progress-cancel = Cancel
texlink-progress-canceled = Canceled
texlink-progress-added = Added { $count } formula records to the Zotero note
texlink-progress-skipped = Skipped { $count } duplicate records
texlink-progress-failed-count = { $count } failed; see Zotero debug output
texlink-progress-recognition-failed = Recognition failed: { $message }
texlink-progress-failed = TexLink failed: { $message }
texlink-progress-worker-error = Inference Worker error: { $message }
texlink-progress-processing = Processing...
texlink-progress-ort = Initializing offline inference engine...
texlink-progress-encoder = Loading formula model (encoder)...
texlink-progress-decoder = Loading formula model (decoder)...
texlink-progress-decoding = Decoding formula ({ $step }/{ $max })...

texlink-error-busy = TexLink is still processing the previous formula; please wait.
texlink-error-open-pdf = Open a PDF and select a formula with the image annotation tool first. TexLink does not read the clipboard or upload images.
texlink-error-no-annotation = No image annotation is selected. Use the image annotation tool in the Zotero PDF reader to select the formula, then select that screenshot and try again.
texlink-error-model-missing = Formula model/tokenizer is not loaded, so recognition is unavailable. Reinstall the complete TexLink.xpi.
texlink-error-empty-formula = The model returned an empty formula; select a clearer formula image and try again.
texlink-error-no-attachment = This annotation has no associated PDF attachment.
texlink-error-no-parent = This PDF has no parent item. Add the PDF as an attachment under a bibliographic item first so TexLink can anchor formulas to that item's note.
texlink-error-no-image = This annotation is not an image annotation.
texlink-error-cache = Could not read the local cache for this screenshot. Make sure the annotation image is synced/saved locally.
texlink-error-cache-detail = Could not read the local cache for this screenshot: { $detail }. Make sure the annotation image is synced/saved locally.
texlink-error-readonly-library = The library containing this item is read-only; cannot create or modify notes.
texlink-error-target-readonly = Target note is not editable (it may be in a read-only library or the trash).
texlink-error-model-load = Model load failed: { $message }
texlink-error-model-config = Model configuration or tokenizer is not loaded yet.
texlink-error-worker-init = Inference Worker is not initialized.
texlink-error-unknown = Unknown error

texlink-prompt-title = TexLink Comment
texlink-prompt-message = Optional comment (leave blank to skip; Cancel aborts this recognition):

texlink-note-anchor-title = TexLink formula anchor
texlink-note-label-page = Page
texlink-note-label-extracted = Extracted
texlink-note-label-source = Source
texlink-note-label-open-pdf = Open in PDF
texlink-note-label-view-item = View item
texlink-note-label-latex-source = LaTeX source
texlink-note-label-comment = Comment
texlink-note-title = TexLink Formula Notes
texlink-note-intro = This note was created automatically by TexLink. Each formula block contains a local KaTeX preview, LaTeX source, page label, and ISO timestamp.
texlink-note-page-fallback = PDF page { $page }
texlink-note-untitled = Untitled item

texlink-error-main-window = Could not obtain the Zotero main window for image preprocessing.
texlink-error-decode-image = Could not decode the annotation image.
texlink-error-zero-image = Annotation image has zero dimensions.
texlink-error-canvas = Could not create a Canvas 2D context.
texlink-error-preferences-unavailable = This Zotero version cannot open plugin preferences.
texlink-error-worker-error = Inference Worker error: { $message }

# v1.0.0 - review, copy/export, and in-place replacement
texlink-pref-review = Review and duplicates
texlink-pref-review-hint = Mark low-confidence formulas for review
texlink-pref-review-hint-hint = Applies only to newly written blocks. Existing notes are never changed, and formulas are never rewritten automatically.
texlink-pref-confidence = Confidence threshold
texlink-pref-duplicates = Repeated recognition of the same screenshot
texlink-pref-duplicates-skip = Skip: keep the existing formula block
texlink-pref-duplicates-replace = Replace: update the existing block in place

texlink-menu-submenu = TexLink: Copy / Export / Review
texlink-menu-replace = TexLink: Re-recognize and Replace This Formula
texlink-menu-replace-tools = TexLink: Re-recognize and Replace Selected Formula
texlink-menu-copy-latex = Copy last LaTeX
texlink-menu-copy-markdown = Copy last formula as Markdown
texlink-menu-copy-inline = Copy last formula as inline math
texlink-menu-copy-all = Copy all formulas in current note (Markdown)
texlink-menu-copy-review = Copy low-confidence formulas for review

texlink-progress-replaced = Updated { $count } formula records in place

texlink-note-review-hint = ⚠ Needs review (low confidence)
texlink-note-label-confidence = Confidence

texlink-error-no-active-note = No editable open note belongs to this item. Open the item's note first or change the note destination setting.
texlink-error-replace-stale = The note changed while updating the formula. Please try again.
texlink-error-nothing-to-copy = There is nothing to copy yet.
texlink-error-no-last-result = Recognize a formula first; then you can copy it.
texlink-error-no-note = Open a Zotero note first, then use the copy or export command.
texlink-error-no-formulas = This note does not contain any TexLink formula blocks yet.
texlink-error-select-one = Select exactly one formula screenshot in the PDF to replace.
texlink-error-no-entry-to-replace = This screenshot has no TexLink formula block yet. Use Recognize Formula and Add to Note first.

texlink-status-copied = Copied to clipboard.
texlink-status-copied-latex = LaTeX copied to clipboard.
texlink-status-copied-inline = Inline formula copied to clipboard.
texlink-status-copied-all = Copied { $count } formulas to clipboard.
texlink-status-copied-review = Copied { $count } formulas that need review.
texlink-status-no-review = No low-confidence formulas in this note.
