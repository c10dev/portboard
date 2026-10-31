# TextInput

The 32px bordered text, password and time field that sits on the right of a settings row.

## When to use

- Use `.ctl-text` for a one-line value in a settings row: the owner token, a port rule key or a port rule name.
- Use `.ctl-time` for a native `type="time"` field, such as the digest send time.
- Do not use it for a choice from a short list. Use the segmented control or the menu-select.
- Do not use it outside the settings modal. The style is in the settings stylesheet only.

## Markup

The section scripts build the `<input>` with `h()` and put it in the control slot of `row()`. A field with a button, or a time field with its unit, goes in a `.ctl-group`.

```html
<div class="st-rows">
  <div class="st-row">
    <div class="st-row-text"><div class="st-row-label">Name</div></div>
    <div class="st-row-ctl">
      <input id="prLabel" class="ctl-text" maxlength="80" placeholder="Empty: not set" aria-label="Name" data-write="1">
    </div>
  </div>
  <div class="st-row">
    <div class="st-row-text"><div class="st-row-label">Digest</div></div>
    <div class="st-row-ctl">
      <span class="ctl-group">
        <input id="digestTime" class="ctl-time" type="time" step="60" aria-label="Send time (KST)" data-write="1">
        <span class="muted">KST</span>
      </span>
    </div>
  </div>
</div>
```

Each field needs an `aria-label`, because the row label is not a `<label>` element.

## Variants

- `.ctl-text`: width `min(320px, 100%)`.
- `.ctl-time`: the native time field at its own width.
- `type="password"` with `autocomplete="off"` and `spellcheck="false"`: the owner token. It is not a write control, because entering it is how a read-only browser becomes the owner.
- `data-write="1"`: the field changes server state. When `html[data-readonly]` is set, it fades to opacity .45 and does not take input.
- `:focus`: the border changes to the `accent` token and a 2px ring of the `accent` token at 55% shows around it.
- Under 768px the font size changes from 14px to 16px, so phones do not zoom in on focus.

## Tokens

- The `bg` token for the background.
- The `line` token for the border.
- The `text` token for the value.
- The `accent` token for the focus border and ring.
- The `muted` token for a unit after the field, such as KST.

## Do and don't

- Do set `aria-label` to the same text as the row label.
- Do set `data-write="1"` on each field that saves to the server.
- Don't set a width on `.ctl-text`. The rule already limits it to 320px and the row width.
- Don't put a unit inside the field. Put it after the field in a `.ctl-group` with `class="muted"`.

Static rendition hand-written from public/settings.css:150-156, 226 and public/style.css:397, and public/features/settings-modal.js:paintOwnerToken (with public/features/digest.js:section, public/features/port-rules.js and public/lib/controls.js:row).
