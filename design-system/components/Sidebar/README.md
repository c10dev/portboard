# Sidebar

The left navigation column: the view rows with counts, the Pinned ports, the Devices tree and a footer with Settings and status chips.

## When to use

- Use it once per page, as the first column of the dashboard shell.
- Use the view rows to move between Services, Devices, Dev and Settings.
- Use a side section for a short list of links into a view, such as pinned ports or devices.
- Do not use it for in-page tabs or filters. Use the segmented control or the tab strip for those.

## Markup

The server writes the column (`shellParts().sidebar` in src/core/shell.ts). The script fills the counts, the sections and the chips. A view row is an `<a class="side-view">` with a `.sv-label` and a `.side-count`. A section is a `<section class="side-sec">` with an `<h2>` and a `<ul>`. Each `<li>` holds one `.side-item`. The footer is `<div class="side-foot">` and comes last.

```html
<nav id="shellSide" class="shell-side" aria-label="Navigation">
  <div class="side-views" role="list">
    <a href="./" class="side-view" role="listitem" data-view="services" aria-current="page"><span class="sv-label">Services</span><span class="side-count" id="count-services">12</span></a>
    <a href="devices.html" class="side-view" role="listitem" data-view="devices"><span class="sv-label">Devices</span><span class="side-count" id="count-devices">3</span></a>
  </div>
  <section class="side-sec" id="sidePinned">
    <h2>Pinned</h2>
    <ul>
      <li><a class="side-item t-warn" href="./#5173" title="5173 my-app · Not listening"><span class="dot"></span><span class="si-text">my-app</span><span class="si-sub">5173</span></a></li>
    </ul>
  </section>
  <section class="side-sec side-tree" id="sideDevices">
    <h2>Devices</h2>
    <ul>
      <li class="si-row" style="--d: 0"><button class="si-fold" type="button" data-fold="direct" aria-label="Collapse or expand Direct connections" aria-expanded="true"></button><span class="side-item si-group" data-fold="direct" title="Direct connections"><span class="si-text">Direct connections</span></span></li>
      <li class="si-row" style="--d: 1" data-up="direct"><span class="si-fold-pad"></span><a class="side-item t-ok" href="devices.html#laptop" title="laptop · Online"><span class="dot"></span><span class="si-text">laptop</span></a></li>
    </ul>
  </section>
  <div class="side-foot" id="shellFoot">
    <a href="settings.html" class="side-view" data-view="settings"><svg class="sv-icon" …></svg><span class="sv-label">Settings</span><span class="side-count" id="count-settings">2</span></a>
  </div>
</nav>
```

The top view rows need `role="listitem"` inside `.side-views[role="list"]`. The Settings row in the footer has no role and has the gear `.sv-icon` first. A tree row needs `.side-tree` on its section, `.si-row` on the `<li>` and a `.si-fold` or a `.si-fold-pad` before the item.

## Variants

- `aria-current="page"` on a `.side-view`: the current view. It gets a grey tint and a bold label.
- `.side-item.selected`: the selected port or the open device. It gets an accent tint.
- `.t-ok`, `.t-warn`, `.t-bad` on a `.side-item` with a `.dot`: a green, amber or red dot.
- `.t-off`: an offline device. The dot is grey and the text uses the `text-3` token.
- `.t-lan`: a LAN-only machine. The dot is a hollow ring.
- No tone class and no `.dot`: a listening pinned port.
- `.si-sub`: mono text at the right end, such as a port number or VM 205. It comes after the badges.
- `.si-badge`: a small grey tag after the text, such as Offline or This server.
- `--d` on `.si-row`: the depth. Each level indents 12px.
- `.si-fold[aria-expanded]`: `true` turns the triangle down, `false` points it right. The fold button and the group row share a `data-fold` key. `.si-row[hidden]` hides the rows of a folded group, and `data-up` on a row names the groups above it.
- `.si-group`: a row without a link, such as Direct connections or a host. It uses the `text-3` token, and a click folds it. A host row also has a tone and a `.dot`.
- `.ob-chip.warn` and `.sw-chip.warn` or `.sw-chip.alarm` in the footer: setup steps left and a collector warning or failure.
- `.readonly-note` in the footer: the connection is read-only.
- `.side-sec[hidden]`: an empty section does not show. The footer hides when all its children are hidden.

## Tokens

- The `side-bg` token for the column and the `line` token for its right edge and the footer rule.
- The `text` token for view rows and hover, the `text-2` token for items and the Settings row, and the `text-3` token for counts, headings, sub text and group rows.
- The `fs-4` token for view rows, the `fs-3` token for items, the `fs-2` token for counts and headings and the `fs-1` token for sub text and badges.
- The `accent` token for `.selected` and the fold focus ring.
- The `ok`, `warn` and `danger` tokens for the dots.
- The `muted` and `surface` tokens for the default dot and the `.t-lan` ring.
- The `warn`, `danger` and `surface` tokens for the footer chips, and the `warn-bg` and `warn` tokens for `.readonly-note`.
- The `side-w` layout token for the column width.

## Do and don't

- Do set `aria-current="page"` on exactly one view row.
- Do give each item a `title` with its full name and state, because long text ends in an ellipsis.
- Don't put more than a short list in a side section. The full list belongs on its view.
- Don't add a `.dot` without a tone class. The script adds the dot only with a tone.

Static rendition hand-written from public/shell.css:108-167 and public/lib/shell-boot.js:fill (with src/core/shell.ts:sideView and public/features/nav.js:navPinned, navTree).
