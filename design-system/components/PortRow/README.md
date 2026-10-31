# PortRow

One row per port in the Services list: the port number, the name and meta line, key badges and the row's actions.

## When to use

Use it for a listening port in the Services list, and for a watched port that no longer listens (the missing row).
Do not use it for devices, dev servers or settings items. They have their own rows.
Do not use it outside a `<ul class="list">`. The dense layout comes from the `.list .row` rules.

## Markup

The consumer supplies an `li.row` inside `ul.list`, with `.port`, `.main` and `.actions` as direct children.
`.main` holds `.name-line` (pin, name link, bell), `.meta` and `.badges`.
A listening row also ends with a `details.more` fact list and a `details.menu` in `.actions`.

```html
<ul class="list">
  <li class="row" data-port="3000">
    <div class="port">3000</div>
    <div class="main">
      <div class="name-line">
        <button type="button" class="pin" aria-label="Pin" data-write="1" title="Pin to top">☆</button>
        <a class="name" href="service.html#3000" title="my-app · View details">my-app</a>
        <button class="bell" data-write="1" type="button" title="3000: get an alert when it goes down" aria-label="3000: get an alert when it goes down" aria-pressed="false">🔔</button>
      </div>
      <div class="meta">my-app · node</div>
      <div class="badges"><span class="badge info key">tailnet HTTPS</span><span class="badge info">All interfaces</span><span class="badge">HTTP 200</span></div>
    </div>
    <div class="actions">
      <a class="btn primary" href="…" target="_blank" rel="noopener">Open ↗</a>
      <button type="button">Unexpose</button>
      <details class="menu"><summary title="More" aria-label="More for 3000">⋯</summary><div class="menu-panel">…</div></details>
    </div>
    <details class="more"><summary>Details</summary><dl><dt>Address</dt><dd>*</dd></dl></details>
  </li>
</ul>
```

Set `aria-pressed` on the bell to match its `.on` class.
Mark the badges that a dense row keeps with the `key` class.

## Variants

- `.selected`: the row open in the inspector. It gets an accent tint and a 3px accent bar on the left. Its pin, bell and ⋯ stay visible, and Open fills.
- `.system`: a port that is not visible by default. That is a hidden port, or a port that is not an app (for example another user's or a system process), unless it is pinned. Outside a group, the row shows at opacity .7.
- `.missing`: a watched port that does not listen. The border mixes in the danger colour and the port number is red. It has no pin, no bell, no ⋯ and no Details, and its one action is "Turn off alert". All its badges show.
- `.sub`: a row inside a group, under `.group-head`. The port number uses the `text-2` colour.
- `.pin.on` and `.bell.on` (with `aria-pressed="true"`): pinned and watched. When they are off, a dense row shows them only on hover, focus or the selected row. On a touch screen they always show.
- `.meta-use.meta-last` inside `.meta`: the "Used … ago" note. It hides while the row is hovered or focused, and on a phone.
- At 640px and below, the list keeps its border and every row shows its badges, buttons, Details, uptime and last-used lines.

## Tokens

- The `surface` token fills the list, and the `line` token draws its border and the row dividers.
- In a dense row, the `text-2` token colours the meta line, and the `text-3` token colours the `.meta-use` note in it.
- The `muted` token colours the `.last-used` line and the Details list.
- The `accent` token tints the selected row, draws its left bar and outlines Open. The `accent-text` token is the text of a filled Open.
- The `danger` token colours the missing row's port number, its border and its `bad` badge.
- The `side-bg` token fills a group header.
- The `fs-2`, `fs-3`, `fs-4` and `fs-5` type styles size the meta, port, name and phone port.
- The `info`, `info-bg`, `warn`, `warn-bg`, `neutral-bg` and `muted` tokens colour the badges.

## Do and don't

- Do put one main action first in `.actions`. A dense row hides every other action except the ⋯ menu.
- Do keep the pin and bell in the markup when they are off. They keep their place, so the names stay in line.
- Don't put a row in a list without `ul.list`. The dense columns and dividers come from that wrapper.
- Don't drop the `.port` cell on a missing row. The red port number is what marks it as down.

Static rendition hand-written from public/style.css:103-126, 296-311, 343-344 and public/shell.css:212-249, 428-456, 469-488, and public/features/ports.js:renderRow, public/features/control.js:reachButtons, public/features/alerts.js:bell and public/features/alerts.js:missingRows.
