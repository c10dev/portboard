// The design system (design-system/README.md, scripts/design-system.ts) is built from public/*.css: every colour token
// of style.css and settings.css reaches tokens.json with the same value in both themes, in a shape the Design System
// artifact reads (no var(), color-mix() or named colours; aliases name a real token), and bundle.css keeps every rule
// but the token declarations. Each component has guidelines and a preview that loads nothing from outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blocks, buildTokens, bundleCss, colorValue, customProps, declarations, isTokenBlock, tokensCss, STYLESHEETS } from '../scripts/design-system.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { tokens } = buildTokens('0000000', '2026-01-01');
const byName = new Map(tokens.color.tokens.map((t) => [t.name, t]));
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla|oklch)\([0-9.%\s,/]+\)|\{[A-Za-z0-9-]+\})$/;

test('declarations: a ";" inside a comment or parentheses does not cut a declaration', () => {
  const body = '\n  /* a; b */\n  --x: rgb(0 0 0 / 10%);\n  --y: url("a;b");\n  color: red';
  assert.deepEqual(declarations(body).map((d) => d.trim()), ['/* a; b */\n  --x: rgb(0 0 0 / 10%);', '--y: url("a;b");', 'color: red']);
  assert.deepEqual(customProps(body), [['x', 'rgb(0 0 0 / 10%)'], ['y', 'url("a;b")']]);
  assert.equal(declarations(body).join(''), body);
});

test('blocks: selectors, nesting in @media and offsets that cut the whole rule', () => {
  const css = '/* c */\n:root { --a: 1px; }\n@media (x) {\n  .b { color: red; }\n}\n';
  const bs = blocks(css);
  assert.deepEqual(bs.map((b) => [b.at, b.selector]), [[[], ':root'], [['@media (x)'], '.b']]);
  assert.equal(css.slice(bs[0].start, bs[0].end), ':root { --a: 1px; }');
  assert.equal(css.slice(bs[1].start, bs[1].end), '.b { color: red; }');
});

test('colorValue: hex lowercased, functions kept, var() an alias, the rest refused', () => {
  assert.equal(colorValue('#AbCdEf'), '#abcdef');
  assert.equal(colorValue('rgb(0 0 0 / 10%)'), 'rgb(0 0 0 / 10%)');
  assert.equal(colorValue('var(--text-2)'), '{text-2}');
  for (const v of ['red', 'transparent', 'color-mix(in srgb, red 10%, blue)', '12px', 'ui-monospace, monospace']) assert.equal(colorValue(v), null, v);
});

test('tokens: every colour custom property of style.css and settings.css, same value in both themes', () => {
  for (const file of ['public/style.css', 'public/settings.css']) {
    const css = read(file);
    const light = customProps(blocks(css).find((b) => b.selector === ':root' && !b.at.length)!.body);
    const dark = new Map(customProps(blocks(css).find((b) => b.selector === ':root[data-theme="dark"]' && customProps(b.body).length)!.body));
    for (const [name, value] of light) {
      if (!colorValue(value)) continue;
      const t = byName.get(name);
      assert.ok(t, `${file} --${name} is in tokens.json`);
      assert.equal(t.value.light, colorValue(value), `--${name} light`);
      assert.equal(t.value.dark ?? t.value.light, colorValue(dark.get(name) ?? value), `--${name} dark`);
    }
  }
  assert.equal(byName.get('muted')?.value.light, '{text-2}');
  assert.equal(byName.get('st-seg-on')?.value.light, '{surface}');
});

test('tokens: names, values and notes in the shape the Design System page reads', () => {
  const seen = new Set<string>();
  for (const t of [...tokens.color.tokens, ...tokens.shadow.tokens, ...tokens.radius.tokens, ...tokens.layout.tokens]) {
    assert.match(t.name, NAME);
    assert.ok(!seen.has(t.name), `${t.name} is used once`);
    seen.add(t.name);
    assert.ok(t.usage.trim().length > 10, `${t.name} has a usage note`);
  }
  for (const t of tokens.color.tokens) {
    for (const v of Object.values(t.value)) {
      assert.match(v, COLOR, `${t.name}: ${v}`);
      if (v.startsWith('{')) assert.ok(byName.has(v.slice(1, -1)) && v.slice(1, -1) !== t.name, `${t.name}: ${v} names another colour token`);
    }
  }
  assert.deepEqual(tokens.color.themes.map((t) => t.id), ['light', 'dark']);
  for (const t of [...tokens.radius.tokens, ...tokens.layout.tokens]) assert.match(t.value, /^\d+(\.\d+)?(px|%)$/, t.name);
  for (const stack of Object.values(tokens.type.families)) assert.doesNotMatch(stack, /[;{}<>\\()]/);
  const styles = tokens.type.groups.flatMap((g) => g.styles);
  assert.deepEqual(styles.filter((s) => /^fs-/.test(s.name)).map((s) => s.fontSize), ['11px', '12px', '13px', '14px', '15px']);
  for (const s of styles) assert.ok(s.usage.trim(), `${s.name} has a usage note`);
});

test('tokens.css declares every token; bundle.css keeps every rule but those declarations', () => {
  const css = tokensCss(tokens);
  assert.match(css.split('\n')[0], /^\/\* Portboard — generated from tokens\.json \*\/$/);
  for (const t of [...tokens.color.tokens, ...tokens.shadow.tokens, ...tokens.radius.tokens, ...tokens.layout.tokens]) assert.match(css, new RegExp(`--${t.name}: `));
  const bundle = bundleCss(tokens);
  const own = new Set([...tokens.color.tokens, ...tokens.layout.tokens].map((t) => t.name));
  for (const b of blocks(bundle).filter(isTokenBlock)) {
    for (const [n] of customProps(b.body)) assert.ok(!own.has(n), `--${n} left in ${b.selector}`);
  }
  assert.match(bundle, /--mono: ui-monospace/, '--mono stays: tokens.css calls the family --font-mono');
  assert.match(bundle, /:root\[data-side="closed"\] \{ --side-w: 0px; \}/, 'state blocks stay');
  // every other rule, bodies included, in order; an @media (max-width) :root { --col-pad } override is not a token block
  const rules = (s: string) => blocks(s).filter((b) => !isTokenBlock(b)).map((b) => `${b.at.join(' ')} ${b.selector} {${b.body}}`);
  assert.deepEqual(rules(bundle), STYLESHEETS.flatMap((f) => rules(read(f))), 'every other rule is kept as written');
  assert.equal((bundle.match(/--col-pad:/g) ?? []).length, STYLESHEETS.map(read).join('').match(/--col-pad:/g)!.length - 1, 'only the top-level --col-pad goes');
});

test('notes: a token without a note, or a note without a token, fails the build', () => {
  const notes = JSON.parse(read('design-system/tokens.notes.json'));
  assert.doesNotThrow(() => buildTokens('0000000', '2026-01-01', notes));
  const { accent: _, ...noAccent } = notes.color;
  assert.throws(() => buildTokens('0000000', '2026-01-01', { ...notes, color: noAccent }), /out of step[\s\S]*color accent/);
  assert.throws(() => buildTokens('0000000', '2026-01-01', { ...notes, color: { ...notes.color, gone: 'x' } }), /color gone \(a note for a token the CSS no longer has\)/);
  assert.throws(() => buildTokens('0000000', '2026-01-01', { ...notes, radius: [...notes.radius, { name: 'radius-x', value: '123px', usage: 'x' }] }), /radius radius-x/);
});

test('type: a figure style whose font shorthand has no line height has none in tokens.json and normal in tokens.css', () => {
  const fig = tokens.type.groups.find((g) => g.name === 'Figures')!.styles;
  const port = fig.find((s) => s.name === 'figure-port')!;
  assert.deepEqual([port.fontSize, port.fontWeight, 'lineHeight' in port], ['18px', 600, false]);
  assert.equal(fig.find((s) => s.name === 'figure-access-code')!.lineHeight, '1.1');
  assert.match(tokensCss(tokens), /^\.figure-port \{ font-family: var\(--font-mono\); font-size: 18px; line-height: normal; font-weight: 600; \}$/m);
});

const COMPONENTS = join(ROOT, 'design-system/components');
const comps = readdirSync(COMPONENTS);

test('components: each has guidelines and a preview with the card marker, loading nothing from outside', () => {
  assert.ok(comps.includes('Cover'), 'the cover');
  for (const c of comps) {
    const dir = join(COMPONENTS, c);
    const preview = readFileSync(join(dir, 'preview.html'), 'utf8');
    assert.match(preview.split('\n')[0], c === 'Cover' ? /^<!-- @dsCard height=\d+ -->$/ : /^<!-- @dsCard group="[^"]+" height=\d+( subtitle="[^"]*")? -->$/, `${c} marker`);
    assert.doesNotMatch(preview, /<(iframe|frame|object|embed|portal|noscript)\b/i, c);
    assert.doesNotMatch(preview, /(src|href)=["']?(https?:)?\/\//i, `${c} loads nothing by URL`);
    assert.doesNotMatch(preview, /<link\b/i, c);
    if (c === 'Cover') assert.ok(!existsSync(join(dir, 'README.md')), 'the cover folder stays bare');
    else assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').trim(), `${c} README`);
  }
});

test('README and guidelines name only tokens and styles that exist', () => {
  const known = new Set([...tokens.color.tokens, ...tokens.shadow.tokens, ...tokens.radius.tokens, ...tokens.layout.tokens].map((t) => t.name));
  for (const g of tokens.type.groups) for (const s of g.styles) known.add(s.name);
  const allCss = STYLESHEETS.map(read).join('\n');
  const docs = [join(ROOT, 'design-system/README.md'), join(ROOT, 'design-system/assets/Logos/README.md'), ...comps.filter((c) => c !== 'Cover').map((c) => join(COMPONENTS, c, 'README.md'))];
  for (const f of docs) {
    for (const m of readFileSync(f, 'utf8').matchAll(/`([a-z][a-z0-9-]*)` token/g)) assert.ok(known.has(m[1]), `${f}: \`${m[1]}\` token`);
    // a `--name` is a token or a custom property the stylesheets read (--mono, --fs-3, or one the JS sets, like --d)
    for (const m of readFileSync(f, 'utf8').matchAll(/`--([a-z][a-z0-9-]*)`/g)) assert.ok(known.has(m[1]) || allCss.includes(`var(--${m[1]}`), `${f}: --${m[1]}`);
  }
});

test('the script writes the artifact layout into an empty folder', () => {
  const out = mkdtempSync(join(tmpdir(), 'pb-ds-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/design-system.ts'), '--out', out, '--by', 'test', '--at', '2026-01-01T00:00:00Z', '--logo-blob', 'abc'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    const p = (s: string) => join(out, 'project', s);
    const index = JSON.parse(readFileSync(p('design-system.json'), 'utf8'));
    assert.equal(index.editing, 'code');
    assert.deepEqual(index.createdOnFiles, { v: 1, at: JSON.parse(read('design-system/system.json')).createdAt });
    assert.equal(index.assetGroups.Logos.files['icon.svg'].blob, 'abc');
    assert.equal(index.lastChange.by, 'test');
    for (const f of ['tokens.json', 'tokens.css', 'README.md', 'components/bundle.css', 'components/Cover/preview.html']) assert.ok(existsSync(p(f)), f);
    assert.ok(!existsSync(p('tokens.notes.json')) && !existsSync(p('system.json')), 'the sources of the index and tokens stay out');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
