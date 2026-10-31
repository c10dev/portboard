# Kbd

A key cap that names a keyboard shortcut in the palette button, the palette and the shortcuts dialog.

## When to use

Use a `kbd` to show the key or key combination that runs a command.
Put it only inside one of the four wrappers below, because the cap style comes from the wrapper.
Do not use a `kbd` for code, paths or port numbers.
Do not use it for a plain hint with no key; the shortcuts dialog is the one exception (see Variants).

## Markup

One `kbd` holds one combination as it reads on the platform: `⌘K` on a Mac, `Ctrl K` elsewhere.
Two `kbd` elements side by side are two keys that work in turn, like the arrow keys in the footer.

```html
<!-- palette button, inside the top bar's .controls -->
<div class="controls">
<button type="button" id="paletteBtn" class="palette-btn" title="Search and commands (⌘K or /)"
        aria-label="Search and commands" aria-keyshortcuts="Meta+K /">
  <span class="pb-ico">🔍</span><kbd>⌘K</kbd>
</button>
</div>

<!-- shortcuts dialog row: alternatives joined by .keys-or -->
<section class="keys-sec">
  <h3>General</h3>
  <dl>
    <dt>Search and commands</dt>
    <dd><kbd>⌘K</kbd><span class="keys-or">or</span><kbd>/</kbd></dd>
  </dl>
</section>

<!-- palette row inside <dialog class="palette"><ul class="pal-list">: the item's keys at the right -->
<li class="pal-row" id="pal-0" role="option" aria-selected="false" data-i="0">
  <span class="pal-kind k-cmd">Command</span>
  <div class="pal-main"><div class="pal-title">Open or close the sidebar</div></div>
  <span class="pal-keys"><kbd>⌘\</kbd></span>
</li>

<!-- palette footer, inside <dialog class="palette"> -->
<p class="pal-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> run · <kbd>→</kbd> more actions · <kbd>Esc</kbd> close</p>
```

The button also needs `aria-keyshortcuts` with the same keys (`Meta+K /` on a Mac, `Control+K /` elsewhere).

## Variants

- `.palette-btn kbd` and `.palette kbd`: 11px mono text, padding 0 4px, a 4px radius. This cap is flat, so it sits in the button and in running footer text.
- `.keys-sec kbd`: the same cap with padding 1px 5px, so it is a little taller.
- `.pal-keys kbd`: shell.css gives it padding 1px 5px too. Inside the palette, `.palette kbd` loads later and wins, so the palette row cap has padding 0 4px.
- `.pal-keys`: an inline flex group with a 3px gap, for more than one key on a palette row.
- `.keys-or`: the word "or" between alternative keys in a shortcuts dialog row.
- Hint text: a shortcut with no key (like "Drag the edge") shows its hint in the `kbd` cap in the shortcuts dialog.
- Width 640px or less: the palette button hides its `kbd` and shows only the icon. The palette footer is hidden too.

## Tokens

- The `neutral-bg` token fills the cap.
- The `line` token draws its 1px border.
- The `muted` token colours the key text.
- The `text-3` token colours the `.keys-or` word.
- The `radius-4` token matches the cap's 4px corner.

## Do and don't

- Do put one combination in one `kbd`, with the platform's glyphs (`⌘K`, `Ctrl K`).
- Do keep the `kbd` keys the same as the keys in `aria-keyshortcuts` and the button `title`.
- Don't put a `kbd` outside its wrappers: a bare `kbd` gets no cap style.
- Don't give a `kbd` its own colour for state; the row or the button shows selection.

Static rendition hand-written from public/shell.css:324-341, public/palette.css:3-7 and 56-62, and public/lib/keys.js:showShortcuts, public/lib/palette.js:row and initPalette.
