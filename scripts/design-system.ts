// Builds the files of the Portboard design system (design-system/README.md): the layout of a claude.ai Design System
// artifact, under <out>/project/. Tokens come from the custom properties in public/*.css, so the stylesheets stay the
// only source of every value. The README, the component guidelines and the previews come from design-system/.
// Nothing is published.
//
//   node scripts/design-system.ts --out DIR [--logo-blob ID [--logo-size BYTES]] [--by NAME] [--at ISO-8601]
//
//   --out DIR        where to write (DIR/project/…); must not exist or be empty
//   --logo-blob ID   the artifact's upload id of public/icon.svg; adds the Logos asset group to the index
//   --logo-size N    the size the upload reports (the artifact store may rewrite an SVG); default: the file's size
//   --by NAME        lastChange.by (default: git config user.name)
//   --at ISO-8601    lastChange.at (default: now)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'design-system');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The stylesheets in the order the pages load them; bundle.css is these with the token declarations taken out */
export const STYLESHEETS = ['public/style.css', 'public/shell.css', 'public/devices.css', 'public/service.css', 'public/dev.css', 'public/settings.css', 'public/palette.css'];

export interface Block { at: string[]; selector: string; body: string; start: number; end: number }

/** Every rule block of a stylesheet with the at-rules around it. Comments and strings are skipped. */
export function blocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: { head: string; start: number; selStart: number; isAt: boolean }[] = [];
  let head = '', headStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      head += css.slice(i, j + 1); i = j; continue;
    }
    if (c === '{') {
      const h = head.trim();
      stack.push({ head: h, start: i + 1, selStart: headStart, isAt: h.startsWith('@') });
      head = ''; continue;
    }
    if (c === '}') {
      const top = stack.pop();
      if (top && !top.isAt) {
        out.push({ at: stack.filter((s) => s.isAt).map((s) => s.head), selector: top.head, body: css.slice(top.start, i), start: top.selStart, end: i + 1 });
      }
      head = ''; headStart = i + 1; continue;
    }
    if (c === ';' && !stack.length) { head = ''; headStart = i + 1; continue; }
    if (!head.trim()) headStart = i;
    head += c;
  }
  return out;
}

/** A block body cut after each `;` outside comments, strings and parentheses; joined again they are the body */
export function declarations(body: string): string[] {
  const out: string[] = [];
  let from = 0, depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? body.length : e + 1; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1; i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && !depth) { out.push(body.slice(from, i + 1)); from = i + 1; }
  }
  if (from < body.length) out.push(body.slice(from));
  return out;
}

const uncomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** The custom property a declaration sets, or null */
const propName = (d: string) => /^\s*--([A-Za-z0-9-]+)\s*:/.exec(uncomment(d))?.[1] ?? null;

/** The `--name: value` declarations of a block body, in order */
export function customProps(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const d of declarations(body)) {
    const m = /^\s*--([A-Za-z0-9-]+)\s*:\s*([\s\S]+?)\s*;?\s*$/.exec(uncomment(d));
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

function propsOf(file: string, selector: string, at: string[] = []): Map<string, string> {
  // `:root[data-theme="dark"] { color-scheme: dark; }` is a second block of the same selector without custom properties
  const hit = blocks(read(file)).filter((b) => b.selector === selector && b.at.join('|') === at.join('|') && customProps(b.body).length);
  if (hit.length !== 1) throw new Error(`${file}: expected one "${selector}" block with custom properties${at.length ? ` in ${at.join(' ')}` : ''}, found ${hit.length}`);
  return new Map(customProps(hit[0].body));
}

/** A themed stylesheet's light (:root) and dark tokens; the prefers-color-scheme block must equal the forced one */
function themed(file: string): { light: Map<string, string>; dark: Map<string, string> } {
  const light = propsOf(file, ':root');
  const dark = propsOf(file, ':root[data-theme="dark"]');
  const media = propsOf(file, ':root:not([data-theme="light"])', ['@media (prefers-color-scheme: dark)']);
  if (JSON.stringify([...media]) !== JSON.stringify([...dark])) throw new Error(`${file}: the prefers-color-scheme dark block differs from :root[data-theme="dark"]`);
  return { light, dark };
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9.%\s,/-]+\))$/i;
/** A colour value as tokens.json takes it: hex lowercased, functions as written, var(--x) as the alias {x} */
export function colorValue(v: string): string | null {
  const alias = /^var\(--([A-Za-z0-9-]+)\)$/.exec(v);
  if (alias) return `{${alias[1]}}`;
  return COLOR.test(v) ? (v.startsWith('#') ? v.toLowerCase() : v) : null;
}

export interface Notes {
  color: Record<string, string>;
  layout: Record<string, string>;
  type: Record<string, { name?: string; usage: string; from?: string }>;
  radius: { name: string; value: string; usage: string }[];
  shadow: { name: string; value: string; usage: string }[];
}

/** The font shorthand of one rule: `[weight] size[/line-height] family` */
function fontOf(selector: string): { fontWeight?: number; fontSize: string; lineHeight?: string; family: string } {
  for (const f of STYLESHEETS) {
    for (const b of blocks(read(f))) {
      if (b.selector !== selector || b.at.length) continue;
      const m = /(?:^|;)\s*font:\s*(?:(\d{3})\s+)?([0-9.]+px|var\(--[a-z0-9-]+\))(?:\/([0-9.]+))?\s+([^;]+)/.exec(b.body);
      if (m) return { fontWeight: m[1] ? Number(m[1]) : undefined, fontSize: m[2], lineHeight: m[3], family: m[4].trim() };
    }
  }
  throw new Error(`no top-level "${selector}" rule with a font shorthand in ${STYLESHEETS.join(', ')}`);
}

export function buildTokens(sha: string, date: string, notes: Notes = JSON.parse(readFileSync(join(SRC, 'tokens.notes.json'), 'utf8'))) {
  const style = themed('public/style.css');
  const settings = themed('public/settings.css');
  const missing: string[] = [];
  const skipped: string[] = [];

  const color: { name: string; value: Record<string, string>; usage: string }[] = [];
  for (const { light, dark } of [style, settings]) {
    for (const [name, raw] of light) {
      const lv = colorValue(raw);
      if (!lv) {
        // --mono and --fs-N are the type, below; any other value is one tokens.json cannot hold (color-mix(), a name)
        if (name !== 'mono' && !/^fs-\d+$/.test(name)) missing.push(`--${name}: ${raw} is not a colour tokens.json can hold`);
        continue;
      }
      const dv = dark.has(name) ? colorValue(dark.get(name)!) : lv;
      if (!dv) { skipped.push(`--${name} (dark: ${dark.get(name)})`); continue; }
      if (!notes.color[name]) missing.push(`color ${name}`);
      color.push({ name, value: dv === lv ? { light: lv } : { light: lv, dark: dv }, usage: notes.color[name] ?? '' });
    }
    for (const name of dark.keys()) if (!light.has(name)) skipped.push(`--${name} (dark only)`);
  }
  for (const name of Object.keys(notes.color)) if (!color.some((t) => t.name === name)) missing.push(`color ${name} (a note for a token the CSS no longer has)`);

  const body = fontOf('body');
  const sans = body.family;
  const mono = style.light.get('mono');
  if (!mono) throw new Error('public/style.css: no --mono');
  const lineHeight = body.lineHeight;
  if (!lineHeight) throw new Error('public/style.css: body has no line height in its font shorthand');
  const scale = [...style.light].filter(([n]) => /^fs-\d+$/.test(n));
  const styles = scale.map(([n, v]) => {
    const note = notes.type[n];
    if (!note) missing.push(`type ${n}`);
    return { name: n, fontSize: v, lineHeight, fontWeight: 400, usage: note?.usage ?? '' };
  });
  if (`var(--${scale.find(([n]) => n === 'fs-4')?.[0]})` !== body.fontSize) throw new Error(`body font size is ${body.fontSize}, not var(--fs-4)`);
  const extra = Object.entries(notes.type).filter(([, n]) => n.from).map(([name, n]) => {
    const f = fontOf(n.from!);
    const size = f.fontSize.startsWith('var(') ? style.light.get(f.fontSize.slice(6, -1)) : f.fontSize;
    // a font shorthand without a line height resets it to normal, which tokens.json cannot write: leave it out
    return { name, fontSize: size!, ...(f.lineHeight ? { lineHeight: f.lineHeight } : {}), fontWeight: f.fontWeight ?? 400, family: f.family === 'var(--mono)' ? 'mono' : 'sans', usage: n.usage };
  });
  for (const n of Object.keys(notes.type)) if (!notes.type[n].from && !scale.some(([s]) => s === n)) missing.push(`type ${n} (a note for a size the CSS no longer has)`);

  const shell = propsOf('public/shell.css', ':root');
  const layout = [...shell].map(([name, value]) => {
    if (!notes.layout[name]) missing.push(`layout ${name}`);
    return { name, value, usage: notes.layout[name] ?? '' };
  });

  const allCss = STYLESHEETS.map(read).join('\n');
  for (const r of notes.radius) {
    const uses = allCss.match(new RegExp(`border-radius:\\s*${r.value.replace(/[.%]/g, (c) => `\\${c}`)}\\s*[;}]`, 'g'))?.length ?? 0;
    if (!uses) missing.push(`radius ${r.name}: no "border-radius: ${r.value}" left in the stylesheets`);
  }
  for (const sh of notes.shadow) {
    if (!allCss.includes(`box-shadow: ${sh.value}`)) missing.push(`shadow ${sh.name}: no "box-shadow: ${sh.value}" left in the stylesheets`);
  }
  if (missing.length) throw new Error(`design-system/tokens.notes.json is out of step with the CSS:\n  ${missing.join('\n  ')}`);

  return {
    tokens: {
      name: 'Portboard',
      version: 1,
      color: { themes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }], tokens: color },
      type: {
        fonts: [],
        families: { sans, mono },
        groups: [
          { name: 'Scale', family: 'sans', styles },
          { name: 'Figures', family: 'mono', styles: extra.filter((s) => s.family === 'mono').map(({ family: _, ...s }) => s) },
        ].filter((g) => g.styles.length),
      },
      shadow: { note: 'Literal box-shadow values: only floating layers get a shadow; surfaces are set apart by line borders.', tokens: notes.shadow },
      radius: { note: 'Literal border-radius values in the stylesheets; these names exist only in the design system.', tokens: notes.radius },
      layout: { note: 'Shell sizes from public/shell.css :root.', tokens: layout },
      meta: {
        source: 'github', repo: 'c10dev/portboard', ref: `main@${sha}`, package: '.',
        paths: { tokens: ['public/style.css', 'public/settings.css', 'public/shell.css'], fonts: [], assets: ['public/icon.svg'], docs: ['design-system/'] },
        synced: date,
      },
    },
    skipped,
  };
}

type Tokens = ReturnType<typeof buildTokens>['tokens'];

/** tokens.css laid out as the Design System type compiles it */
export function tokensCss(t: Tokens): string {
  const v = (x: string) => (x.startsWith('{') ? `var(--${x.slice(1, -1)})` : x);
  const first = t.color.themes[0].id;
  const lines = ['/* Portboard — generated from tokens.json */', `:root, [data-theme="${first}"] {`];
  for (const c of t.color.tokens) lines.push(`  --${c.name}: ${v(c.value[first])};`);
  for (const sh of t.shadow.tokens) lines.push(`  --${sh.name}: ${sh.value};`);
  lines.push('}');
  for (const th of t.color.themes.slice(1)) {
    lines.push(`[data-theme="${th.id}"] {`);
    for (const c of t.color.tokens) if (c.value[th.id] || c.value[first].startsWith('{')) lines.push(`  --${c.name}: ${v(c.value[th.id] ?? c.value[first])};`);
    lines.push('}');
  }
  lines.push(':root {');
  for (const r of t.radius.tokens) lines.push(`  --${r.name}: ${r.value};`);
  for (const l of t.layout.tokens) lines.push(`  --${l.name}: ${l.value};`);
  for (const [k, stack] of Object.entries(t.type.families)) lines.push(`  --font-${k}: ${stack};`);
  lines.push('}');
  for (const g of t.type.groups) {
    for (const s of g.styles) lines.push(`.${s.name} { font-family: var(--font-${g.family}); font-size: ${s.fontSize}; line-height: ${'lineHeight' in s ? s.lineHeight : 'normal'}; font-weight: ${s.fontWeight}; }`);
  }
  return `${lines.join('\n')}\n`;
}

/** The blocks tokens.css replaces, with the at-rules around them; `@media (max-width: 640px) { :root { --col-pad } }` stays */
const TOKEN_BLOCKS = [':root|', ':root[data-theme="dark"]|', ':root:not([data-theme="light"])|@media (prefers-color-scheme: dark)'];
export const isTokenBlock = (b: Block) => TOKEN_BLOCKS.includes(`${b.selector}|${b.at.join(' ')}`);

/** The stylesheets without the declarations tokens.css makes; a block left empty goes too */
export function bundleCss(t: Tokens): string {
  const own = new Set([...t.color.tokens.map((c) => c.name), ...t.layout.tokens.map((l) => l.name)]);
  const parts = ['/* Portboard — public/*.css for the previews, without the custom properties tokens.css declares */'];
  for (const f of STYLESHEETS) {
    let css = read(f);
    const edits = blocks(css)
      // only the blocks tokens.css replaces; `:root[data-side="closed"] { --side-w: 0px }` and the like stay
      .filter((b) => isTokenBlock(b) && customProps(b.body).some(([n]) => own.has(n)))
      .map((b) => {
        const body = declarations(b.body).filter((d) => !own.has(propName(d) ?? '')).join('');
        return { b, body: uncomment(body).trim() ? body : null };
      })
      .sort((x, y) => y.b.start - x.b.start);
    for (const { b, body } of edits) {
      const open = css.indexOf('{', b.start);
      css = body === null ? css.slice(0, b.start) + css.slice(b.end) : css.slice(0, open + 1) + body + css.slice(b.end - 1);
    }
    css = css.replace(/@media \(prefers-color-scheme: dark\) \{\s*\}/g, '');
    parts.push(`/* ---- ${f} ---- */`, css.trim());
  }
  const out = `${parts.join('\n')}\n`;
  if (/<\/style/i.test(out)) throw new Error('bundle.css holds "</style"');
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function main(argv: string[]) {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const out = arg('--out');
  if (!out) { console.error('usage: node scripts/design-system.ts --out DIR [--logo-blob ID [--logo-size BYTES]] [--by NAME] [--at ISO-8601]'); process.exit(2); }
  if (existsSync(out) && readdirSync(out).length) { console.error(`${out} is not empty`); process.exit(2); }
  const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();
  const sha = git('rev-parse', '--short=7', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'public', 'design-system') !== '';
  const at = arg('--at') ?? new Date().toISOString();
  const by = arg('--by') ?? (() => { try { return git('config', 'user.name'); } catch { return 'Claude'; } })();
  const { tokens, skipped } = buildTokens(sha, at.slice(0, 10));
  const P = join(out, 'project');
  const put = (p: string, text: string) => { mkdirSync(dirname(join(P, p)), { recursive: true }); writeFileSync(join(P, p), text); };

  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    // the token notes and the index date feed tokens.json and the index; the inventory is a checklist for the repo
    if (rel === 'tokens.notes.json' || rel === 'system.json' || rel === 'inventory.md') continue;
    mkdirSync(dirname(join(P, rel)), { recursive: true });
    cpSync(f, join(P, rel));
  }
  put('tokens.json', `${JSON.stringify(tokens, null, 2)}\n`);
  put('tokens.css', tokensCss(tokens));
  put('components/bundle.css', bundleCss(tokens));

  const system = JSON.parse(readFileSync(join(SRC, 'system.json'), 'utf8'));
  const logo = arg('--logo-blob');
  const svg = readFileSync(join(ROOT, 'public/icon.svg'));
  const index = {
    v: 3, layout: 'files', createdOnFiles: { v: 1, at: system.createdAt }, editing: 'code',
    title: 'Portboard', namespace: 'Portboard', libraries: [],
    sections: {}, groups: logo ? ['Logos'] : [],
    assetGroups: logo ? { Logos: { name: 'Logos', tile: 'l', order: ['icon.svg'], files: { 'icon.svg': { name: 'icon.svg', blob: logo, size: Number(arg('--logo-size') ?? svg.length), type: 'image/svg+xml' } } } } : {},
    blobs: {}, docs: { readme: 'project/README.md', sections: [] },
    lastChange: { by, at, via: `Claude Code · c10dev/portboard@${sha}${dirty ? ' (uncommitted changes)' : ''}`, note: 'Rebuilt from public/*.css and design-system/ by scripts/design-system.ts.' },
  };
  put('design-system.json', `${JSON.stringify(index, null, 2)}\n`);
  console.log(`wrote ${files(P).length} files to ${P}${dirty ? ' (public/ or design-system/ has uncommitted changes)' : ''}`);
  if (!logo) console.log('no --logo-blob: the index has no Logos group (upload public/icon.svg to the artifact first)');
  for (const s of skipped) console.log(`not in tokens.json: ${s}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
