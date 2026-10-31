# IconButton

A square 28 px button that holds one glyph or icon, used for the bar controls and for close buttons in panels and dialogs.

## When to use

Use it for a frequent action that a glyph explains well: the sidebar toggle, back, forward, the details panel toggle, and the close × in the inspector, the shortcuts dialog and the settings dialog.
Always give it an `aria-label`, because the glyph has no text.
Do not use it for an action that needs a word to be clear, or for the main action of a form or a dialog. Use a text button there.

## Markup

The consumer supplies a `<button type="button">` with the `icon-btn` class, an `aria-label`, and usually a `title` with the same text.
The content is one text glyph or an inline SVG with `aria-hidden="true"` that draws in `currentColor`.

```html
<button type="button" id="inspToggle" class="icon-btn insp-toggle" title="Details panel" aria-label="Details panel"
        aria-controls="inspector" aria-pressed="true">
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">…</svg>
</button>

<button type="button" id="inspClose" class="icon-btn" aria-label="Close details" title="Close">×</button>
```

No wrapper is required. In the bar the buttons sit in `.brand` or `.controls`.

## Variants

- `aria-pressed="true"` or `aria-expanded="true"`: the on state. The glyph changes from the `muted` token to the `text` token.
- `:hover`: the background becomes the `neutral-bg` token and the glyph becomes the `text` token.
- `disabled`: the button shows at 35% opacity and has no hover background.
- `.nav-btn`: the back and forward arrows. The glyph is 15px instead of 16px. Hidden at 640px and below.
- `.insp-toggle`: the details panel toggle. Hidden at 640px and below.
- `.st-close`: the close button of the settings dialog. It is a 32px square at the top right of the dialog, the glyph uses the `text-2` token, and the hover background uses the `st-hover` token.
- `.side-toggle`: the sidebar toggle. It has a 2px right margin. When `aria-expanded="false"` and the sidebar footer wants attention (`#swChip.warn`, `#swChip.alarm`, `#obChip.warn`, or `html[data-readonly]`), a 7px dot in the `warn` token shows at the top right. With `#swChip.alarm` the dot uses the `danger` token.

## Tokens

- the `muted` token: the glyph colour at rest.
- the `text` token: the glyph colour on hover and in the on state.
- the `neutral-bg` token: the hover background.
- the `warn` token and the `danger` token: the attention dot on the sidebar toggle.
- the `text-2` token and the `st-hover` token: the `.st-close` glyph and its hover background.

## Do and don't

- Do give every icon button an `aria-label`. Add a `title` with the shortcut when one exists, for example "Back (⌘[)".
- Do use `aria-pressed` for a toggle that stays on, and `aria-expanded` for a toggle that opens a region.
- Don't put text labels or more than one glyph in it. The button is a fixed square (28px, or 32px with `.st-close`), so longer content does not fit.
- Don't restyle its colour for one place. Use the on state or a text button.

Static rendition hand-written from public/shell.css:29-44, 352 and public/settings.css:65-66, src/core/shell.ts:shellParts, public/lib/keys.js:showShortcuts and public/features/settings-modal.js:build.
