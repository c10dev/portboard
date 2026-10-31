# IconToggle

Glyph-only toggle buttons beside a service name: the pin star (`.pin`) and the down-alert bell (`.bell`).

## When to use

Use the pin to keep a port at the top of the list. Use the bell to turn the down alert on or off for a port or a device. In a service row, put both in the `.name-line`, next to the name link. A device card has only the bell in its `.name-line`. The service page puts the bell alone in its `.svc-title`.

Do not use them for other actions. A labelled action goes in a button in the row's `.actions`.

## Markup

The consumer supplies a `.name-line` wrapper with the pin button, the name link and the bell button. The bell can come after the link in the DOM or not: `.name-line .bell` has `order: 3`, so it always shows after the name. In the service list, the row is a `li.row` inside `ul.list`.

```html
<ul class="list">
  <li class="row">
    <div class="port">3000</div>
    <div class="main">
      <div class="name-line">
        <button type="button" class="pin on" aria-label="Pin" data-write="1" title="Unpin">★</button>
        <a class="name" href="service.html#3000">my-app</a>
        <button class="bell on" data-write="1" type="button"
          title="3000: down alert on (click to turn off)"
          aria-label="3000: down alert on (click to turn off)"
          aria-pressed="true">🔔</button>
      </div>
      <div class="meta">node</div>
      <div class="badges"></div>
    </div>
    <div class="actions"></div>
    <details class="more"><summary>Details</summary><dl></dl></details>
  </li>
</ul>
```

- The pin text is ★ when on and ☆ when off. Its title is "Unpin" when on and "Pin to top" when off.
- The bell text is always 🔔. Its `title` and `aria-label` are "{label}: down alert on (click to turn off)" when on and "{label}: get an alert when it goes down" when off. `aria-pressed` is `true` or `false`.
- `data-write="1"` marks a button that changes state.
- Set `hidden` on the pin when the port is not listening.

## Variants

- `.pin` (off): the star is in the `muted` token colour at opacity .55. Hover sets opacity 1.
- `.pin.on`: pinned. The star is gold (`#d4a72c`, a literal colour, not a token) at opacity 1.
- `.bell` (off): opacity .28 and greyscale. Hover sets opacity .8.
- `.bell.on`: alert on. Full colour at opacity 1.
- `.svc-title .bell`: the bell on the service page, at font size 16px.
- `.card .name-line .bell`: the bell on a device card, with a 2px left margin.
- In `.list .row` at widths of 641px and more, an off pin and an off bell have opacity 0. They show at their normal faint opacity on row hover, on `:focus-within` and on `.row.selected`. Their own hover or `:focus-visible` sets opacity 1. With a coarse pointer, they always show faint. An `.on` toggle always shows.

## Tokens

- The `muted` token: the colour of the pin star when it is off.

## Do and don't

- Do give the bell a `title`, an `aria-label` and `aria-pressed` that tell the current state.
- Do keep an off toggle in a listening row. It keeps its place, so the names stay in line.
- Don't use a token colour for the pinned star. The gold is a literal in the CSS.
- Don't put an icon toggle in `.actions`.

Static rendition hand-written from public/style.css:143-150, public/style.css:302-305, public/shell.css:446-463, public/service.css:9, public/devices.css:158, the `template#row` in public/index.html and public/features/ports.js:renderRow, public/features/alerts.js:bell().
