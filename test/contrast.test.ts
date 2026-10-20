// The colour tokens in public/style.css meet WCAG AA where they are used as text: 4.5:1 for text on the backgrounds it
// sits on, in both light and dark mode. The pairs are the ones the pages use (sidebar headings in --text-3 on
// --side-bg, the palette's accent verbs on --info-bg, button text on --accent, error toasts on --danger).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');

/** The --name: #hex tokens of one block: the first :root (light) or the one inside the dark media query */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = css.slice(darkStart, css.indexOf('}', css.indexOf(':root {', darkStart)));
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['text', 'text-2', 'text-3', 'accent', 'ok', 'warn', 'info', 'danger'];
const BACKGROUNDS = ['bg', 'side-bg', 'surface', 'neutral-bg', 'info-bg'];
const FILLED = [['accent-text', 'accent'], ['danger-text', 'danger']];

for (const [mode, t] of [['light', light], ['dark', dark]] as const) {
  test(`${mode}: text tokens reach 4.5:1 on the backgrounds they sit on`, () => {
    for (const fg of TEXT) {
      for (const bg of BACKGROUNDS) {
        assert.ok(t[fg] && t[bg], `--${fg} and --${bg} are hex tokens`);
        const r = contrast(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${mode} --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`${mode}: text on a filled accent or danger background reaches 4.5:1`, () => {
    for (const [fg, bg] of FILLED) {
      const r = contrast(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${mode} --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
    }
  });
}
