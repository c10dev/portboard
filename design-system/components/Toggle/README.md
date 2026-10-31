# Toggle

A 36 × 20 on/off switch: a real checkbox with `role="switch"`, laid invisibly over a pill track.

## When to use

Use a toggle for one setting that takes effect as on or off, such as each device in Write-enabled devices.

Do not use it to pick one of several values. Use the segmented control for that. Do not use it for an action that runs at once, such as stop or expose. Use a button for that.

## Markup

The consumer supplies a `label.ctl-toggle` with two children in this order: the checkbox `input.ctl-toggle-input` and the empty `span.ctl-toggle-track`. The track must come straight after the input, because the CSS styles it with `.ctl-toggle-input:checked + .ctl-toggle-track`.

```html
<label class="ctl-toggle" data-write="1">
  <input type="checkbox" role="switch" class="ctl-toggle-input"
    id="wd-desktop" value="desktop" aria-label="Allow changes from desktop"
    data-write="1" checked>
  <span class="ctl-toggle-track" aria-hidden="true"></span>
</label>
```

- The input has no visible text, so give it an `aria-label`.
- Put `data-write="1"` on the label and the input when the switch changes server state.
- In a settings row, put the toggle in `div.st-row-ctl` inside `li.st-row`, in `ul.st-rows`. Point the row's `label.st-row-text` at the input with `for`.

## Variants

- Off (no `checked`): the track is the `text` token at 20%, and the white knob is at the left.
- `checked`: the track is the `accent` token, and the knob moves 16px to the right.
- `:focus-visible` on the input: a 2px `accent` outline with a 2px offset around the track.
- `disabled`: the track has opacity .55 and the cursor is the default. Write-enabled devices uses it to lock the device in use on.
- `html[data-readonly]`: style.css greys every `[data-write]` element to opacity .45 and blocks clicks. The wrapper carries the grey once, and the input stays at opacity 0.

## Tokens

- The `text` token: the off track, mixed at 20% with transparent.
- The `accent` token: the on track and the focus ring.

## Do and don't

- Do give each switch an `aria-label` that names what it allows, such as "Allow changes from laptop".
- Do keep the input before the track. The track styles depend on the sibling selector.
- Don't hide the input with `display: none`. It is the click and keyboard target.
- Don't add a visible text label inside `.ctl-toggle`. Put the text in the row label.

Static rendition hand-written from public/settings.css:97-112 and public/lib/controls.js:toggle().
