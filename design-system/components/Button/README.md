# Button

The plain bordered button and link-button used for every row action, dialog button and header control on the dashboard.

## When to use

- Use it for any action the user clicks: row actions, dialog Close, Clean up all, refresh.
- Use `.btn` on an `<a>` when the action opens an address in a new tab.
- Use `.btn.primary` for the one main action in a group, such as Open ↗ or Ask.
- Do not use it for navigation items, segmented controls or menu triggers. Those components have their own rules.

## Markup

The `button()` builder makes a `<button type="button">`. The `extLink()` builder makes an `<a>` with `target="_blank"` and `rel="noopener"`. A group of row actions sits in `<div class="actions">`.

```html
<div class="actions">
  <a class="btn primary" href="https://desktop.example.ts.net:3000/" target="_blank" rel="noopener">Open ↗</a>
  <button type="button" data-write="1">Unexpose</button>
  <button type="button">Copy SSH</button>
</div>
```

A plain `<button>` needs no class. An `<a>` needs the `btn` class.

## Variants

- `.btn.primary`: accent fill. The background and border use the `accent` token and the text uses the `accent-text` token.
- `:disabled`: opacity .5 and the default cursor, on a `<button>` only. The dashboard sets it while an expose or unexpose request runs.
- `data-write="1"`: the button changes something. When `html[data-readonly]` is set, the button fades and does not take clicks.
- In a service row on a wide screen, the first `.btn.primary` in `.list .row .actions` is outlined in the `accent` token and fills on hover, on focus and on the selected row. That rule belongs to the row component.
- `.danger`: the `button()` builder adds it when `danger` is set. It has no style of its own. Only `.menu-panel button.danger`, `.insp-actions button.danger` and `.svc-actions button.danger` show it in the `danger` token colour, so use a danger button only inside a menu, the inspector or the service page actions.

## Tokens

- The `surface` token for the background, the `line` token for the border and the `text` token for the label.
- The `muted` token for the border on hover.
- The `accent` token and the `accent-text` token for `.btn.primary`.
- The `danger` token for `.danger` inside a menu, the inspector or the service page actions.

## Do and don't

- Do put a maximum of one `.btn.primary` in a group of actions.
- Do set `data-write="1"` on each button that changes state, so read-only mode disables it.
- Don't add `.danger` to a button outside a menu, the inspector or the service page actions. It shows as a default button there.
- Don't use a `<button>` to open an address. Use an `<a class="btn">` from `extLink()`.

Static rendition hand-written from public/style.css:90-98 and public/lib/dom.js:button (with extLink and public/features/control.js:reachButtons).
