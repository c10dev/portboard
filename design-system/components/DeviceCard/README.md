# DeviceCard

One card per device in the devices tab: its name, state dot, how it reaches this server, and what it uses on this server now.

## When to use

Use it in the Cards view of the devices tab, one card for each device that uses this server now.
The device cards go in a `section.cards` grid. The This server card goes alone in a `section.cards.one`.
Do not use it for the compact device strip above the Services list. That strip uses `.device` cards.
Do not use it for a device with no connections, no reported ports and no Proxmox host role. Use an idle chip (`.chip`) for it.

## Markup

The consumer supplies an `<article class="card">` with a tone class inside a `<section class="cards">`.
The page also puts `.cards-only` on the section, so the section hides in the Tree view.
The card is focusable (`tabindex="0"`) and carries the device id in `data-id`.
The `.card-head` holds the `.glyph` and the `.who` column. The `.name-line` holds the `.dot` and the `.dev-name`.
After the head come the optional parts: a `ul.uses` list, a `.recent` line, and on the self card a `details.local` box.

```html
<section class="cards cards-only" aria-label="Devices in use">
  <article class="card t-ok" tabindex="0" data-id="laptop">
    <div class="card-head">
      <span class="glyph k-tailnet">mac</span>
      <div class="who">
        <div class="name-line">
          <span class="dot"></span>
          <strong class="dev-name">laptop</strong>
          <button class="bell" type="button" data-write="1" aria-pressed="false"
                  title="laptop: get an alert when it goes down"
                  aria-label="laptop: get an alert when it goes down">🔔</button>
        </div>
        <div class="dev-sub">Mac · Tailscale direct</div>
        <div class="dev-badges"><span class="badge new">New device</span></div>
      </div>
    </div>
    <ul class="uses">
      <li>
        <span class="use-name"><span>my-app</span><span class="use-port">:5173</span></span>
        <span class="use-meta">2 connections · 840 KB</span>
      </li>
    </ul>
    <div class="recent">Last 7 days: my-app 3h · api 20m</div>
  </article>
</section>
```

## Variants

- `.t-ok`, `.t-warn`, `.t-bad`, `.t-off` on `.card`: the tone of the name-line dot. `t-ok` is online or a healthy pool. `t-warn` and `t-bad` come from the compute-pool state. `t-off` is offline and keeps the grey default dot.
- `.card.self`: the This server card. It shows a `details.local` box in place of the uses list, and the cursor stays default.
- `.glyph.k-tailnet` and `.glyph.k-self`: accent tint. `.glyph.k-lan`: warn tint. `.glyph.k-pool`: info tint. Other kinds keep the neutral glyph.
- `.bell` in the name line: the down-alert toggle for tailnet devices. `.bell.on` with `aria-pressed="true"` means the alert is on; without `.on` the bell is faint.
- `.dev-badges`: optional badges (`.badge.new`, `.badge.info`, `.badge.warn` and the plain `.badge`).
- `.dev-pool`: a compute-pool or Proxmox line under the sub line. `.dev-pool.solo` puts it under the head on the self card.
- `.name-btn`: a Rename or Name it button at the right of the head, for devices this server can name.
- At 640px and less, the grid has one column and the head wraps.

## Tokens

- The `surface` token fills the card, and the `line` token draws its border and the row dividers.
- The `muted` token colours the sub line, ports, meta text and the hover border.
- The `accent` token draws the focus outline and tints the tailnet and self glyphs.
- The `neutral-bg` token fills the default glyph.
- The `warn-bg` and `warn` tokens colour the LAN glyph. The `info-bg` and `info` tokens colour the pool glyph.
- The `ok`, `warn` and `danger` tokens colour the dot for `t-ok`, `t-warn` and `t-bad`.
- The `accent` and `accent-text` tokens fill and colour the `.badge.new` badge.

## Do and don't

- Do put the tone class on the card, not on the dot. The `.t-ok .dot` rules read the tone from an ancestor.
- Do keep the bell inside `.name-line`, so that it follows the name.
- Don't put a `.card` outside `.cards`. The grid sets the column width and the gap.
- Don't add the uses list to the self card. Its connections go in the `details.local` box.

Static rendition hand-written from public/devices.css:6-65, 78, 144, 158, 161 and public/features/usage.js:card().
