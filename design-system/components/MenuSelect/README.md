# MenuSelect

A borderless text button with a chevron that opens a list of options, like a `<select>`, where each option can have a grey description line.

## When to use

- Use it in a settings row to pick one value from a short list, such as the digest schedule or what to stop when a Claude session ends.
- Use it when the options need a short description under the label.
- Do not use it for two or three short options that the user must see at all times. Use a segmented control.
- Do not use it for row actions. Use the ⋯ menu.

## Markup

The `menuSelect()` builder makes this markup. Build it with `menuSelect()`, not by hand, because the builder adds the keyboard handling and the placement of the list.

```html
<div class="ctl-menu" id="digestMode" data-write="1">
  <button type="button" class="ctl-menu-btn" aria-haspopup="listbox" aria-expanded="false"
          aria-controls="menu1" aria-label="Digest schedule" title="Off">
    <span class="ctl-menu-text">Off</span>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <ul class="ctl-menu-list" role="listbox" id="menu1" aria-label="Digest schedule" hidden>
    <li role="option" class="ctl-menu-opt" tabindex="-1" data-value="off" aria-selected="true"><span class="ctl-menu-label">Off</span></li>
    <li role="option" class="ctl-menu-opt" tabindex="-1" data-value="daily" aria-selected="false">
      <span class="ctl-menu-label">Daily</span>
      <span class="ctl-menu-desc">Optional second line.</span>
    </li>
  </ul>
</div>
```

- `.ctl-menu` is the root. It has `.value`, `.disabled` and a bubbling `change` event. Put `data-write="1"` on it when the choice changes a setting.
- The button `aria-label` names the setting. The button `title` is the description of the current option, or its label when it has no description.
- `.ctl-menu-text` holds the label of the current option. It ends with an ellipsis when the row is too narrow.
- `.ctl-menu-list` is `position: fixed`, so a scrolling modal does not clip it. When it opens, the builder sets `min-width`, `right`, `top` and `bottom` inline: 4px under the button, or 4px above it when there is no room below, and at least 8px from the right edge of the window.
- The list closes on a click outside, on Esc, on Tab, on a window resize and on a scroll outside the list.

## Variants

- `[hidden]` on `.ctl-menu-list`: the menu is closed. This is the default.
- `aria-expanded="true"` on `.ctl-menu-btn`: the menu is open. The button keeps the hover background while the list shows.
- `:disabled` on `.ctl-menu-btn`: the button shows at .55 opacity and does not open. Set it with `.disabled = true` on the root.
- `aria-selected="true"` on `.ctl-menu-opt`: the current option. An accent ✓ shows at its right.
- `.ctl-menu-desc` in an option: a smaller grey line under the label.
- `:focus-visible` on an option: an inset accent ring for keyboard focus. Arrow keys, Home and End move the focus. Enter and Space pick.

## Tokens

- The `text` token: button text and option labels.
- The `text-2` token: option descriptions.
- The `text-3` token: the chevron.
- The `st-hover` token: button background on hover and while open, and option background on hover and focus.
- The `accent` token: the ✓ of the current option, the button focus outline and the option focus ring.
- The `surface` token: list background.
- The `line` token: the hairline ring around the list.
- The `radius-8` token, the `radius-10` token and the `radius-6` token: button, list and option corners.

## Do and don't

- Do give the button an `aria-label` that names the setting.
- Do keep option descriptions short. The list is at most 360px wide, so a long description wraps to several lines. Its height is at most the smaller of 360px and half the window, and it scrolls past that.
- Don't give the button a border or a fixed width. It is as wide as its text, and the row wraps it when space is short.
- Don't put the list inside an element with `transform` in the app. A transform moves the fixed list away from the button.

Static rendition hand-written from public/settings.css:127-148 and public/lib/controls.js:menuSelect.
