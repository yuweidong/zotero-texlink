# TexLink v0.1.5

## What's new

- Generated LaTeX source is compact and readable. Tokenizer-inserted spaces
  between symbols, braces, subscripts, and superscripts are removed.
- Text groups such as `\text{if }` keep their internal spaces.
- Explicit spacing commands such as `\,`, `\;`, `\:`, `\!`, and `\quad`
  are preserved.
- When removing a space could merge a control word with a following letter,
  TexLink inserts an empty group instead:
  `\alpha x` becomes `\alpha{}x`.
- The Settings page uses the native Zotero pane layout without a custom hero
  icon, and the Settings sidebar icon has an explicit 24×24 box.
- The Tools menu keeps its native dropdown structure and uses a 16×16 icon.
- The preference pane XHTML now has a single valid root, so the pane can load
  reliably on all supported platforms.

## Install

1. Open **Tools → Add-ons → gear menu → Install Add-on From File…**
2. Select `zotero-texlink-0.1.5.xpi`.
3. Restart Zotero.

## SHA256

```text
0967795bbe862d4e569283d2b69b97153984a4ff331fa397e8fa5d0035650eb3
```
