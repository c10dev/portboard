# Menu

The ⋯ overflow menu: a `details.menu` whose summary opens a `.menu-panel` of plain buttons, with destructive items last after a separator.

## When to use

- Use it for secondary actions on one row, such as Rename, Hide, View logs and Restart.
- Use it when an action is destructive, such as Stop. Put that action last, after a separator, in red.
- Do not use it for the main action of a row. Show that action as a visible button.
- Do not use it for a choice that the user must see at all times. Use a segmented control or a select.

## Markup

```html
<details class="menu">
  <summary title="More" aria-label="More for 3000">⋯</summary>
  <div class="menu-panel">
    <button type="button" data-write="1">Rename</button>
    <button type="button">View logs</button>
    <div class="menu-sep" role="separator"></div>
    <button class="danger" type="button" data-write="1">Stop</button>
  </div>
</details>
```

- The summary holds only the ⋯ character. Its `title` is "More". Its `aria-label` names the row, for example "More for 3000".
- Each item is a `<button type="button">`. Add `data-write="1"` to an item that changes state.
- `.menu` is `position: relative`. The panel is absolute, aligned to the right edge of the summary, so leave space below and to the left of the menu.

## Variants

- `[open]` on `details.menu`: the panel shows. The row menu keeps this attribute across the 10 s refresh.
- `button.danger`: a destructive item with red text. It always comes after the safe items.
- `.menu-sep` with `role="separator"`: a 1px line between the safe items and the danger items. It shows only when the menu has both kinds.
- `button:disabled`: the item shows at half opacity and does not act.
- `.owners-banner .menu-panel`: the auto-stop menu in the owners banner. The panel is wider, starts with a `span.muted` heading, and marks the current option with a ✓ prefix.
- `.list .row .actions > .menu`: in dense rows (641px and wider) the closed summary shows only on row hover, focus, the selected row, or while open. On touch screens it always shows.

## Tokens

- The `surface` token: summary and panel background.
- The `line` token: summary and panel border, and the separator.
- The `neutral-bg` token: item background on hover.
- The `danger` token: danger item text.
- The `text` token: item text.
- The `muted` token: the owners banner heading.
- The `radius-8` token and the `radius-10` token: the summary and panel corners have the same values (8px and 10px). The CSS writes these corners as literal values, not as the tokens.

## Do and don't

- Do put destructive items last, after `.menu-sep`, with the `danger` class.
- Do give each summary an `aria-label` that names its row.
- Don't add a `.menu-sep` when the menu has no danger item.
- Don't keep two menus open at once. Opening one menu from elsewhere closes the other open menus.

Static rendition hand-written from public/style.css:90-97, public/style.css:153-168, public/style.css:375-376, public/shell.css:426-438, public/lib/menu.js:moreMenu and public/lib/dom.js:button.
