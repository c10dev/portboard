# Meter

A thin labelled bar that shows one load reading (CPU or memory) as a percentage.

## When to use

Use it on a machine card to show CPU and memory load at a glance. The card puts a CPU meter and a Mem meter in one `.mbars` group, between the card head and the `.device-line`. The card leaves the group out when the machine sends no load data.
Do not use it for a value that is not a percentage of a whole. Do not use it as a progress bar for a running task.

## Markup

Put each `.mbar` in a `.mbars` group. The fill width is an inline style. The `title` attribute holds the full reading.

```html
<div class="mbars">
  <div class="mbar" title="CPU 12%">
    <span class="mbar-label">CPU</span>
    <span class="mbar-track"><span class="mbar-fill" style="width: 12%;"></span></span>
    <span class="mbar-val">12%</span>
  </div>
  <div class="mbar" title="Mem 48%">
    <span class="mbar-label">Mem</span>
    <span class="mbar-track"><span class="mbar-fill" style="width: 48%;"></span></span>
    <span class="mbar-val">48%</span>
  </div>
</div>
```

The grid has three columns: 34px for the label, the track, and 34px for the value. Keep the label and the value short.

## Variants

- `.mbar-fill.hot`: the reading is 90% or more. The fill changes from the `ok` token to the `warn` token.
- No reading: set the fill width to `0%`, show `–` as the value, and set `title` to "not read".

## Tokens

- the `neutral-bg` token: track background.
- the `ok` token: fill.
- the `warn` token: fill with `.hot`.
- the `muted` token: label and value text.

## Do and don't

- Do give each meter a `title` with the label and the full value.
- Do show `–` when there is no reading. Do not show `0%`, because that is a real value.
- Don't put a meter outside a `.mbars` group. The group sets the gap and the top margin.
- Don't change the fill colour for other thresholds. Only `.hot` changes it.

Static rendition hand-written from public/style.css:223-228 and public/features/machines.js:bar.
