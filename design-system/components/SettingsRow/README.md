# SettingsRow

One settings line: a label and an optional description on the left, the control on the right.

## When to use

Use a settings row for each setting in the Settings dialog, such as Theme, When a session ends or a device in Write-enabled devices. Put every row of one group in one `.st-rows` wrapper, so the rows get dividers between them.

Do not use it for lists of services or ports. Use the list rows of the Services and Dev tabs for those.

## Markup

The consumer supplies a `.st-rows` wrapper and a `.st-row` for each setting. The row holds `.st-row-text` (with `.st-row-label` and an optional `.st-row-desc`) and an optional `.st-row-ctl` with the control.

```html
<div class="st-rows">
  <div class="st-row has-desc">
    <div class="st-row-text">
      <div class="st-row-label">Theme</div>
      <div class="st-row-desc">Colours on this device.</div>
    </div>
    <div class="st-row-ctl">
      <div class="ctl-seg" role="radiogroup" id="uiTheme">…</div>
    </div>
  </div>
</div>
```

- `row()` in public/lib/controls.js builds this markup. Use it when you can.
- The control in `.st-row-ctl` can be a toggle (`label.ctl-toggle`), a segmented control (`div.ctl-seg`), a menu select (`div.ctl-menu`), a text field (`input.ctl-text`) or buttons.
- For a list of items, use `ul.st-rows` and `li.st-row`. Write-enabled devices does this.

## Variants

- `.has-desc`, or any row with a `.st-row-desc`: the minimum height is 69px instead of 57px.
- No `.st-row-ctl`: a row that only shows information, such as Last auto-stop.
- `label.st-row-text` with `for` set to the control's id: a click on the text changes the control, and the cursor is a pointer.
- A disabled toggle (`input.ctl-toggle-input[disabled]`): the track is dimmed. Write-enabled devices locks the device in use this way.
- `.st-row-label strong`: a name in the label at weight 500, with a badge next to it.
- Narrow space: the text keeps a basis of 240px, so the control wraps under the label when the row is too narrow for both.

## Tokens

- The `st-divider` token: the 1px line between two rows.
- The `text` token: the label.
- The `text-2` token: the description.

## Do and don't

- Do keep the label short and put the details in the description.
- Do put the rows of one group in one `.st-rows`, so the dividers come out right.
- Don't give the control a fixed width. `.st-row-ctl` has a maximum width of 100%, so a wide control wraps under the label.
- Don't put two settings in one row. Use one row for each setting.

Static rendition hand-written from public/settings.css:80-94 and public/lib/controls.js:row(), with the device rows from public/features/write-devices.js:box().
