# WhyEmpty

An empty state that says why a list shows nothing and offers the next step.

## When to use

Use it where a list, card grid or table can be empty: the Services list, the Dev worktrees and the Devices cards.
Say the cause in the title, and add a reason or a button when the user can change the result.
Do not use it for a failed load: that is an error, not an empty list.
Do not use it for the no-result row inside the command palette: that row is `.pal-empty`.

## Markup

The `whyEmpty(box, { title, text, actions })` helper fills a box that you supply.
It adds the `why-empty` class and replaces the children of the box.
The children are one `<strong>` title, an optional `<span class="why">` reason and an optional `<span class="acts">` with plain buttons.
All children are phrasing content, so the box can be a `<p>` or a `<div>`.
On the Services page the box is the existing `<p id="empty" class="empty">`.

```html
<p id="empty" class="empty why-empty">
  <strong>No ports in use now.</strong>
  <span class="why">They show up here when another device or a process on this server connects.</span>
  <span class="acts"><button type="button">Show all</button></span>
</p>

<div class="why-empty">
  <strong>No removable worktrees.</strong>
  <span class="acts"><button type="button">Show all</button></span>
</div>
```

## Variants

- Title only: no `.why` and no `.acts`, for a state with no cause the user can change ("No TCP ports are listening.").
- `.why`: a reason or a hint below the title, at most 560px wide.
- `.acts`: one or more buttons that wrap and center, with a 6px gap.
- `.empty` on the same element: the Services page box. The `.why-empty` padding (32px 12px) replaces the `.empty` padding.
- A direct child of `.cards` or `#repos`: the box spans all grid columns, so it takes the full row of the Devices card grid.
- `code` inside the box: 12px text in the mono font. The helper sets text only, so it never adds a `code` element.

## Tokens

- The `muted` token colors the box text and the reason.
- The `text` token colors the title.
- The `line` token, the `surface` token and the `text` token style the buttons through the shared button rule.

## Do and don't

- Do write the title as the cause ("3 ports hidden by the filters"), not as "Nothing here".
- Do give the button that undoes the cause, such as "Show all" or "Clear search".
- Don't put links, lists or block elements in the box: the helper accepts text and buttons only.
- Don't add a second empty message next to it: the helper replaces the children of the box.

Static rendition hand-written from public/palette.css:66-71 and public/lib/empty.js:whyEmpty.
