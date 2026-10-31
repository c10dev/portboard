# UserChip

A small pill link that names one device or process that uses a port.

## When to use

Use it to show who uses a port now: under a port row's badges, in the port inspector and in the service page's "now" list.
The service page's usage history table also uses it to name each device that used the port.
Each chip links to that device on the Devices tab.
Do not use it for the one-line "last used" text on a port row. That line is plain text.
Do not use it for a port's own facts, such as HTTPS or the process count. Use a Badge for those.

## Markup

On a port row, put the chips in a `div.users` line. The line can start with an `ok` Badge that gives the total connection count.
Each chip is an `<a>` with `user-chip` and one `u-<kind>` class. The text is the device name, with ` ×N` when it has more than one connection. A `u-local` chip reads "This server", and a `u-routed` chip reads "via <router name>".

```html
<div class="users">
  <span class="badge ok">3 in use</span>
  <a class="user-chip u-tailnet" href="devices.html#laptop" title="Tailscale device">laptop</a>
  <a class="user-chip u-local" href="devices.html" title="A process on this server">This server ×2</a>
</div>
```

- `href`: `devices.html#<device id>`. A `u-local` chip links to `devices.html` itself. A `u-routed` chip links to the router.
- `title`: the kind's label (for example "Tailscale device"). A `u-routed` chip for a current connection has a title that names the router.

## Variants

- `u-tailnet`, `u-pool`: a Tailscale device or a compute-pool host. The dot uses the accent colour.
- `u-lan`, `u-other`: a LAN device or an unknown address. The dot uses the warning colour.
- `u-local`: a process on this server. The text is muted.
- `u-routed`: a tailnet device behind a subnet router. The border is dashed, the text is muted and the dot is a faint accent.
- `u-self`, `u-funnel`: this server, or Tailscale Funnel traffic from the public internet. They have no rule of their own, so they look like the default chip with a muted dot.
- Hover: the border changes to the muted colour.

## Tokens

- The `surface` token fills the chip, and the `line` token draws its border.
- The `text` token colours the name. The `muted` token colours `u-local` and `u-routed` names, the default dot and the hover border.
- The `accent` token colours the `u-tailnet`, `u-pool` and `u-routed` dots.
- The `warn` token colours the `u-lan` and `u-other` dots.
- The chip has the `radius-pill` token radius, and the dot has the `radius-round` token radius.

## Do and don't

- Do give every chip exactly one `u-<kind>` class, so that the dot tells the kind.
- Do put a port row's chips inside `.users`. That line supplies the wrap and the 4px gap. The inspector and the service page put each chip in a list item or table cell instead.
- Don't use a chip for a port's own facts. Use a Badge.
- Don't build a chip without an `href`. Each chip is a link to the Devices tab.

Static rendition hand-written from public/style.css:248-259 and public/lib/badge.js:userChip()/usingChip() (called from public/features/ports.js:111-121 and public/service.js).
