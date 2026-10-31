# Toast

A short notification in a stack at the bottom right of the page, with an optional Undo action.

## When to use

Use a toast to confirm a write (pin, hide, copy, alert off) or to report a failed request.
Add an Undo action when the user can reverse the change.
Do not use a toast for information that the user must read before they continue. Use a dialog for that.
Do not use a toast for a state that stays true, such as a service that is down. Use a badge or a banner on the page.

## Markup

A page that shows toasts has one `#toast` root (the settings page has none, so `toast()` does nothing there). `createToasts()` gives it the `toast-stack` class and the live-region attributes. Each toast is a `div.toast` with a `span.toast-text`, an optional `button.toast-action` and a `button.toast-close`.

```html
<div id="toast" class="toast-stack" role="status" aria-live="polite" aria-atomic="false" aria-label="Notifications">
  <div class="toast" data-depth="0">
    <span class="toast-text">3000 unpinned</span>
    <button type="button" class="toast-action" data-write="1">Undo</button>
    <button type="button" class="toast-close" title="Close" aria-label="Dismiss notification">×</button>
  </div>
</div>
```

The stack is `position: fixed`. The toast styles in the stack apply only inside `.toast-stack`.

## Variants

- `.error`: the toast shows a failure in danger colours.
- `.toast-action`: a button with an outline, for example Undo. A toast with an action stays until the user uses it or closes it.
- `data-depth="0"`: the front toast. The newest toast is at depth 0.
- `data-depth="1"` and `data-depth="2"`: older toasts tucked behind the front one, moved up and made smaller. Their content is hidden and they are `inert`. The stack sets `--toast-front-h` so they are as tall as the front toast.
- A deeper `data-depth`: the toast is not visible.
- A link: with the `link` option, `fill()` adds an `<a>` ("Open settings", `target="_blank"`) at the end of `.toast-text`. The link inherits the toast colour and is bold. Such a toast stays 20 s.
- A repeated message merges into one toast with a count, such as "Copied (×2)".

## Tokens

- the `text` token: toast background.
- the `bg` token: toast text.
- the `danger` token: error toast background.
- the `danger-text` token: error toast text.
- the `fs-3` token: text size in the stack.
- the `shadow-toast` token matches the toast shadow.
- the `radius-10` token matches the toast corner radius, and the `radius-6` token matches the button radius.

## Do and don't

- Do keep the text short: a port and what changed, such as "3000 unpinned".
- Do call `toast(text, true)` for failures. The toast gets `.error`, shows in danger colours and stays 7 s instead of 6 s.
- Don't put more than one action in a toast.
- Don't build a `.toast` outside the stack. Call `toast()` so the stack sets the depth, the timer and the live region.

Static rendition hand-written from public/shell.css:398-423 (base rule public/style.css:128-141) and public/lib/toast.js:createToasts.
