# UptimeBar

A row of small pills that shows the recent up and down checks of a watched port, with its uptime percentages.

## When to use

Use the uptime line in the port inspector, and under a watched port's row at 640px and below. Above 640px, the list row hides it.
Use bar rows on the service page for recent checks, 24 hours and 30 days.
Do not use it for a port without a down alert, because no checks exist for it.
Do not use it as a chart of load or traffic.

## Markup

`bar()` builds `<span class="ubar" role="img">` with one `<i>` per slot and an `aria-label` that counts the checks.
`uptimeLine()` puts the bar and `<span class="uptime-pct">` in `<div class="uptime-line">`.
On the service page, `barRow()` puts a label, the bar and a note in `<div class="bar-row">`, inside `<div class="bars">`.

```html
<div class="uptime-line" title="Checked every 30 s · last check 10:42:05">
  <span class="ubar " role="img" aria-label="Last 2 checks: 1 up, 1 down">
    <i class="up" title="About 60s ago · Up"></i>
    <i class="down" title="About 30s ago · Down"></i>
  </span>
  <span class="uptime-pct">24h 99.95% · 7d 100%</span>
</div>

<div class="bars">
  <div class="bar-row">
    <span class="bar-k">24 hours</span>
    <span class="ubar wide" role="img" aria-label="Last 2 checks: 1 up, 0 down">
      <i class="up" title="11:00 AM · 100%"></i>
      <i class="none" title="11:30 AM · Not checked"></i>
    </span>
    <span class="bar-note">30m × 48</span>
  </div>
</div>
```

## Variants

- `i.up`: the check passed. Green.
- `i.down`: the check failed. Red.
- `i.quiet`: Portboard restarted or stopped the service. Amber.
- `i.none`: the slot was not checked. It has no rule of its own and keeps the base gray fill.
- `.uptime-line.muted`: no checks yet. The line holds only the text "Uptime: no checks yet". On a page that also loads devices.css, its `.muted` rule sets the font size to 13px.
- `.ubar` inside `.bar-row`: a taller bar that fills its column up to 720px, with pills that share the width.
- `.ubar.wide`: set by `slotBar()` for the 24 hours and 30 days rows. It has no style of its own.
- At 640px and below, a bar row puts the bar on its own second line at full width.

## Tokens

- Pills: the `ok` token for up, the `danger` token for down, the `warn` token for quiet, the `line` token for not checked.
- Text: the `muted` token for the uptime line, the row label and the note.

## Do and don't

- Do give each pill a `title` with its time and state, because the color alone does not say it.
- Do keep `role="img"` and the `aria-label` count on the bar.
- Don't put a bar row outside `.bars` and `.bar-row`, because the taller size comes from `.bar-row .ubar`.
- Don't add a rule for `i.none`, because the base `.ubar i` rule already gives it the gray fill.

Static rendition hand-written from public/style.css:345-351, public/service.css:39-44, 71-72, public/shell.css:198, 232 and public/features/uptime.js:bar(), uptimeLine(), slotBar(), public/service.js:barRow().
