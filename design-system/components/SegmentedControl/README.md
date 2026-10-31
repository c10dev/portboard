# SegmentedControl

A 32 px row of radio segments where only the picked segment is raised, used for the short choices in Settings.

## When to use

- Use it for one choice from two to four short options that the user sees all at once, such as Theme, List width and Language in Settings › Display.
- Use it when each option is one or two words.
- Do not use it for an on/off setting. Use the toggle switch.
- Do not use it for long lists or options that need a description. Use the menu select.

## Markup

The `segmented()` builder makes a `<div class="ctl-seg" role="radiogroup">`. Each option is a `<label class="ctl-seg-opt">` that holds a radio `<input class="ctl-seg-input">` and a `<span>` with the label. All radios in one control share one `name`. The picked option has `checked` on its radio.

```html
<div class="ctl-seg" role="radiogroup" id="uiTheme">
  <label class="ctl-seg-opt"><input type="radio" class="ctl-seg-input" name="seg1" value="system" checked><span>System</span></label>
  <label class="ctl-seg-opt"><input type="radio" class="ctl-seg-input" name="seg1" value="light"><span>Light</span></label>
  <label class="ctl-seg-opt"><input type="radio" class="ctl-seg-input" name="seg1" value="dark"><span>Dark</span></label>
</div>
```

The radio covers the whole segment and has opacity 0, so a click anywhere on the segment picks it. The builder sets `aria-label` from `label` and `data-write="1"` from `write`. The control needs no wrapper.

## Variants

- `:has(.ctl-seg-input:checked)`: the picked segment. It gets the `st-seg-on` token background, the `text` token colour, weight 500 and a hairline in the `line` token.
- `:hover`: the label changes from the `text-2` token to the `text` token.
- `:has(.ctl-seg-input:focus-visible)`: a 2px ring in the `accent` token, offset 1px.
- `.disabled`: setting the control's `disabled` property adds this class and sets `disabled` on each radio. The whole control has opacity .55.
- `title` on `.ctl-seg-opt`: a tooltip for the option, such as "Up to 808px" on List width.
- Narrow parent: the control has `max-width: 100%`. The segments shrink and the labels end in an ellipsis before the row overflows.
- `data-write="1"`: the control changes server state. When `html[data-readonly]` is set, it fades and does not take clicks.

## Tokens

- The `st-seg-bg` token for the track behind the segments.
- The `st-seg-on` token for the picked segment.
- The `text-2` token for labels and the `text` token for the picked or hovered label.
- The `line` token for the hairline around the picked segment.
- The `accent` token for the keyboard focus ring.

## Do and don't

- Do keep the labels short, so the control does not need the ellipsis at normal widths.
- Do put the control in a settings row with its own label and description. The segments do not name the setting.
- Don't use more than four segments. Use the menu select.
- Don't add the `disabled` class by hand. Set the control's `disabled` property, so the builder disables the radios too.

Static rendition hand-written from public/settings.css:114-125 and public/lib/controls.js:segmented.
