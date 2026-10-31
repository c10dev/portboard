# StatusDot

An 8 px round dot that shows the state of a device, service, collector, setup item or tree row before its name.

## When to use

- Put it before a name to show a state at a glance: online, degraded, down or off.
- Put a text label next to the dot. The dot only adds color, so the label must say the state too.
- Do not use it for counts or progress. Use a badge or a meter for that.
- Do not use it as a button. It has no focus state and no click action.

## Markup

The dot is an empty `span`. Its color comes from a tone class. The tone class sits on the parent or on the dot itself, and this depends on the context.

```html
<!-- device strip: tone on the card -->
<div class="devices">
  <div class="device ok">
    <div class="device-head"><span class="dot"></span><strong>desktop</strong></div>
  </div>
</div>

<!-- device cards and chips on the Devices tab: tone on the card or chip -->
<article class="card t-ok"><div class="name-line"><span class="dot"></span><strong class="dev-name">desktop</strong></div></article>

<!-- alert and collector lists: tone on the dot -->
<ul class="alerts-list">
  <li class="alerts-item"><span class="dot ok"></span><span class="alerts-port">3000</span><strong>my-app</strong><span class="alerts-state ok">OK</span></li>
</ul>

<!-- network tree: tone on the dot, with a t- prefix -->
<div class="nt-row k-device" role="treeitem" aria-level="1">
  <div class="nt-main"><div class="nt-line"><span class="dot t-ok"></span><strong class="nt-name">desktop</strong></div></div>
</div>

<!-- self-watch chip -->
<button class="sw-chip" type="button" aria-label="Data collection status"><span class="sw-dot"></span><span class="sw-text">Collection OK</span></button>

<!-- Proxmox guest: a smaller dot -->
<ul class="guests"><li class="guest on"><span class="gdot"></span><span class="guest-name"><span class="gname">api</span></span></li></ul>
```

## Variants

- `.device.ok`, `.device.warn`, `.device.bad` on the device strip card: the dot uses the `ok`, `warn` or `danger` token. `.device.off` keeps the `muted` dot and fades the card.
- `.card.t-ok`, `.t-warn`, `.t-bad` (also on `.chip`): the same three tones. With no tone or `t-off`, the dot is a mix of the `muted` and `surface` tokens.
- `.alerts-item .dot.ok`, `.dot.warn`, `.dot.bad`: the tone class sits on the dot. Inside `.sw-dlg`, `.dot.muted` uses the `line` token for a collector that is off or not set up.
- `.nt-row .dot.t-ok`, `.t-warn`, `.t-bad`: tree rows. `.dot.t-lan` is an open ring for a device that is only on the LAN. `.dot.t-off` has no rule of its own, so it shows the mixed off color.
- `.sw-dot`: the self-watch chip dot. It uses the `ok` token. `.sw-chip.warn` and `.sw-chip.alarm` change it to the `warn` and `danger` tokens.
- `.gdot`: a 7 px guest dot. `.guest.on` turns it to the `ok` token.
- `.side-item.t-ok`, `.t-warn`, `.t-bad`, `.t-lan` in the sidebar: a 7 px dot with the same tones. `.side-item.t-off` keeps the mixed dot and uses the `text-3` token for the text.
- `.set-list .dot.ok`, `.dot.warn`, `.dot.todo` in the settings lists: the `ok`, `warn` and `danger` tokens.

## Tokens

- the `ok` token: online, healthy
- the `warn` token: degraded, busy, checking
- the `danger` token: down, failing
- the `muted` token: the plain `.dot` default, and part of the mixed off color
- the `surface` token: mixed with `muted` for the off color and the LAN ring
- the `line` token: the muted collector dot in the self-watch dialog
- the `text-3` token: the text of an off sidebar item

## Do and don't

- Do put the tone class where the CSS expects it: on the parent for cards, chips and the device strip, on the dot for lists and tree rows.
- Do keep a text state next to the dot, for example "Online" or "Not responding".
- Don't color the dot with an inline style. Use the tone classes.
- Don't use `.dot.muted` outside `.sw-dlg .alerts-item`. Elsewhere nothing sets its background, so it shows the plain `muted` dot.

Static rendition hand-written from public/style.css:210-213, 327-329, 356-361, public/devices.css:33-36, 91-92, 261-265, public/shell.css:133-137, 157 and public/settings.css:168-171, and public/features/devices.js:deviceStrip, alerts.js:paintDialog, selfwatch.js:paintDialog, nettree-view.js:toneOf, usage.js:card, proxmox.js:guestList, secrets.js:row and public/lib/shell-boot.js.
