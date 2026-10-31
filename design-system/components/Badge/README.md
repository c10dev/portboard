# Badge

A small pill that states one fact about a port, device or event, tinted by tone.

## When to use

Use a badge for a short status or fact under a row name, in the inspector head, in an audit result or in a device tree row.
Keep the text to a few words.
Do not use a badge for a person or device that links somewhere: use the user chip.
Do not use a badge as a button.

## Markup

The `badge()` helper builds `<span class="badge TONE">text</span>`.
Put a group of badges in `<div class="badges">`, which wraps them with a small gap.

```html
<div class="badges">
  <span class="badge info key">tailnet HTTPS</span>
  <span class="badge warn key">Not listening</span>
  <span class="badge">local only</span>
</div>
```

## Variants

- No tone class: a plain fact (local only, HTTP 200, Ephemeral).
- `ok`: good or active (2 in use, tailnet direct, audit done).
- `warn`: wants a look (Not listening, Alerts paused 2 min, Standby).
- `info`: how something is reached (tailnet HTTPS, All interfaces, This server).
- `bad`: failing (Not responding for 5m, audit denied).
- `new`: a new device; bold, on the accent fill. The usage and new-device views build it directly as `<span class="badge new">`. The rule is in devices.css, so it applies on pages that load devices.css.
- `off`: the device tree emits it for Offline and a stopped guest, but no CSS rule exists, so it renders as the plain badge.
- `key`: a dense port row (wider than 640px) keeps this badge and hides the others. A missing row shows all its badges. It has no style of its own.
- `dense-only`: the badge is hidden at 640px and narrower, where the port row is not dense. Give it `key` too, or a dense row hides it.
- `owner-badge`: the session or worktree that owns a port. It stays on one line and ends with an ellipsis when it is too wide.
- Inside `.audit-list`, the badge moves to the right end of the line.

## Tokens

- Plain badge: the `neutral-bg` token and the `muted` token.
- `ok`: the `ok-bg` token and the `ok` token.
- `warn`: the `warn-bg` token and the `warn` token.
- `info`: the `info-bg` token and the `info` token.
- `bad`: the `danger` token, mixed at 14% into the `surface` token for the fill.
- `new`: the `accent` token and the `accent-text` token.
- Shape: a pill. The CSS writes the radius as a literal value equal to the `radius-pill` token.

## Do and don't

- Do pick the tone by meaning: info for reach, warn for a look, bad for a failure.
- Do mark the badges a dense row must keep with `key`.
- Don't rely on `off` for a dimmed look; it has no rule.
- Don't put long text in a badge, except the owner badge, which truncates.

Static rendition hand-written from public/style.css:115-119, 309, 379, 403, public/devices.css:161, public/shell.css:228-248 and public/lib/badge.js:badge().
