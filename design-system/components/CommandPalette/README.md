# CommandPalette

The ⌘K or / search-and-command dialog: a search field over a grouped list of ports, devices, worktrees and commands, with a key hint footer.

## When to use

- Use it as the one place to find any item on any page and run its actions from the keyboard.
- Use it to reach an action that also has a button elsewhere, such as Stop or Logs for a port.
- Do not make it the only way to reach a common action. Also give that action a visible control on its page.
- Do not use it for a choice inside a form. Use a select or a segmented control.

## Markup

```html
<dialog id="palette" class="palette" aria-label="Search and commands">
  <div class="pal-head">
    <button type="button" id="palBack" class="pal-back" aria-label="Back" hidden>←</button>
    <input id="palQ" type="search" role="combobox" aria-expanded="true" aria-controls="palList"
           aria-autocomplete="list" aria-activedescendant="pal-0" placeholder="Search ports, devices, worktrees, commands">
    <button type="button" id="palClose" class="pal-close">Close</button>
  </div>
  <div id="palCtx" class="pal-ctx" hidden></div>
  <ul id="palList" class="pal-list" role="listbox" aria-label="Results">
    <li class="pal-group">Recent</li>
    <li class="pal-row sel danger" id="pal-0" role="option" data-i="0" aria-selected="true">
      <span class="pal-kind k-port">Port</span>
      <div class="pal-main"><div class="pal-title">8080 api</div></div>
      <span class="pal-verb">Stop</span>
    </li>
    <!-- the Command group comes here: every page has commands -->
    <li class="pal-group">Port</li>
    <li class="pal-row" id="pal-1" role="option" data-i="1" aria-selected="false">
      <span class="pal-kind k-port">Port</span>
      <div class="pal-main">
        <div class="pal-title">3000 my-app</div>
        <div class="pal-sub">my-app · my-app.service · ★</div>
      </div>
      <button type="button" class="pal-drill" title="More actions" aria-label="3000 my-app: more actions" tabindex="-1">›</button>
    </li>
    <li class="pal-more">Port: 2 more · type to find them</li>
  </ul>
  <p class="pal-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> run · <kbd>→</kbd> more actions · <kbd>Esc</kbd> close</p>
</dialog>
```

- The page opens the dialog with `showModal()`. `.palette[open]` makes it a flex column, so the list scrolls between the head and the footer.
- Each `li.pal-row` has `role="option"`, an `id` of `pal-N` and `data-i`. The input points at the selected row with `aria-activedescendant`.
- A row holds, in this order: one `span.pal-kind`, one `div.pal-main` with `.pal-title` and an optional `.pal-sub`, then an optional `.pal-keys`, then at most one of `.pal-verb`, `.pal-drill` or `.pal-hint`. A row with `.pal-keys` never gets `.pal-hint`.
- `.pal-group`, `.pal-more` and `.pal-empty` are plain `li` items without `role="option"`. They are not selectable.

## Variants

- `hidden` on `#palBack` and `#palCtx`: the main list. Remove `hidden` when the palette lists the actions of one item. `#palCtx` then holds a `span.pal-kind` and a `strong` with the item title, and the placeholder is "Search actions". In that list each row holds only `.pal-main` with the action label as its title: no kind tag, no `.pal-sub` and no trailing element.
- `.pal-row.sel` with `aria-selected="true"`: the selected row, on an info background. Only one row has it.
- `.pal-row.danger`: the row runs a destructive action, such as Stop. Its `.pal-verb` turns red.
- `.pal-kind.k-port`, `.k-device`, `.k-worktree`: the kind tag text takes the info, ok or warn colour. `.k-cmd` has no own rule and stays muted.
- `.pal-title mark`: the characters that match the query, in accent colour and heavier weight. Only a typed query adds them.
- `.pal-verb`: the action that a verb query (for example "3000 logs") or a recent action runs, in an outlined label.
- `.pal-drill` (›): the item has more than one action. It opens the action list of the item.
- `.pal-hint`: the label of the only action. It shows only on the selected row.
- `.pal-keys` with `kbd` children: the item has a keyboard shortcut.
- `.pal-group`: a section heading when the query is empty: Recent, then the kinds in the order Command, Port, Device, Worktree.
- `.pal-more`: the count of hidden items of one kind, or the first-load line "Loading ports, devices and worktrees…".
- `li.pal-empty`: no row matches. It holds a `strong` line ("Nothing matches …" or "No actions match …") and, in the main list, a help line.
- At 640px and narrower the dialog becomes a near full-screen sheet, and the footer and `.pal-hint` are hidden.

## Tokens

- The `surface` token: dialog background.
- The `line` token: dialog border, the line under the head and above the footer, the input border, and the `kbd` border.
- The `text` token: dialog and input text, and the `strong` line of `.pal-empty`.
- The `bg` token: input background.
- The `accent` token: input focus outline, `mark` text, and the `.pal-verb` outline and text.
- The `muted` token: group headings, `.pal-more`, `.pal-empty`, `.pal-sub`, `.pal-hint`, `.pal-drill`, the footer, `kbd` text, and the `.k-cmd` kind tag.
- The `neutral-bg` token: kind tag and `kbd` background.
- The `info-bg` token: the selected row background.
- The `info` token, the `ok` token and the `warn` token: port, device and worktree kind tag text.
- The `danger` token: the `.pal-verb` of a danger row.
- The `radius-12` token: dialog corners. The `radius-8` token: input and row corners. The `radius-6` token: kind tag and `.pal-verb` corners. The `radius-4` token: `kbd` corners.
- The `shadow-dialog` token: the dialog shadow.

## Do and don't

- Do keep the trailing elements of a row short (a `kbd`, one verb, ›), so that the title keeps the width.
- Do add the `danger` class to a row whose action stops or removes something.
- Don't make `.pal-group` or `.pal-more` items selectable or give them `role="option"`.
- Don't put a long title in a row without `.pal-main`. Its `min-width: 0` lets the title end in an ellipsis.

Static rendition hand-written from public/palette.css:5-63, public/shell.css:324,338-340 and public/lib/palette.js:initPalette (DIALOG, paint, row).
