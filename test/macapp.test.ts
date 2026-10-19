// The Mac app's one bar (public/lib/macapp.js, shell.css [data-app="mac"], mac-app WindowChrome): what the page
// reports to the app about its header (the app hit-tests mouse-downs against it), the app-only back button, and the
// numbers the page and the app must agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { expandShell } from '../src/core/shell.ts';
// @ts-expect-error plain browser module, no types
import { barReport, inMacApp, NO_DRAG, setupMacApp } from '../public/lib/macapp.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const node = (r: ReturnType<typeof rect>) => ({ getBoundingClientRect: () => r });

/** A header whose controls are looked up by the NO_DRAG selector */
function header(bar = rect(0, 0, 1440, 52), controls = [rect(78, 12, 28, 28), rect(228.123, 9.5, 196.25, 33), rect(0, 0, 0, 0)]) {
  const h: any = node(bar);
  h.controls = controls;
  h.queried = [] as string[];
  h.querySelectorAll = (sel: string) => { h.queried.push(sel); return controls.map(node); };
  return h;
}

test('the report: the header rect and its controls in CSS px, hidden controls left out', () => {
  const h = header();
  assert.deepEqual(barReport(h), {
    type: 'bar',
    bar: { x: 0, y: 0, width: 1440, height: 52 },
    noDrag: [{ x: 78, y: 12, width: 28, height: 28 }, { x: 228.12, y: 9.5, width: 196.25, height: 33 }],
  });
  assert.deepEqual(h.queried, [NO_DRAG]);
});

test('an open dialog (the 설정 modal, ⌘K) is no-drag space too, where it covers the bar; the backdrop around it is not', () => {
  const h = header(rect(0, 0, 1280, 48), [rect(78, 12, 28, 28)]);
  const doc = { querySelectorAll: (sel: string) => (sel === 'dialog[open]' ? [node(rect(128, 16, 1024, 768))] : []) };
  assert.deepEqual(barReport(h, doc).noDrag, [{ x: 78, y: 12, width: 28, height: 28 }, { x: 128, y: 16, width: 1024, height: 768 }]);
  assert.deepEqual(barReport(h, { querySelectorAll: () => [] }).noDrag, [{ x: 78, y: 12, width: 28, height: 28 }], 'closed: only the controls');
  assert.match(read('public/lib/macapp.js'), /attributeFilter: \['open'\]/, 'a dialog opening or closing is reported again');
});

test('no-drag covers every control kind in the header: links (tabs, 설정 chip), buttons, fields, labels, the tab strip', () => {
  const kinds = NO_DRAG.split(',').map((s: string) => s.trim());
  for (const k of ['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'nav', '[role="button"]', '[tabindex]']) assert.ok(kinds.includes(k), k);
});

test('setupMacApp: data-app, one back button, and the layout reported to the app (again only when it changes)', () => {
  const listeners: Record<string, () => void> = {};
  const h = header();
  const brandKids: any[] = [];
  h.querySelector = (sel: string) => (sel === '.brand' ? { prepend: (b: any) => brandKids.unshift(b) } : null);
  h.addEventListener = () => assert.fail('the header has no click listener: the app hit-tests instead');
  const doc: any = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: (sel: string) => (sel === 'header.top' ? h : null),
    getElementById: (id: string) => brandKids.find((b) => b.id === id) ?? null,
    createElement: (tag: string) => ({ tag, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, addEventListener(_t: string, fn: () => void) { (this as any).on = fn; } }),
  };
  const posted: any[] = [];
  const observers: { kind: string; cb: () => void; targets: any[] }[] = [];
  const observer = (kind: string) => class {
    rec: { kind: string; cb: () => void; targets: any[] };
    constructor(cb: () => void) { this.rec = { kind, cb, targets: [] }; observers.push(this.rec); }
    observe(t: any) { this.rec.targets.push(t); }
  };
  let back = 0;
  const win: any = {
    history: { back: () => back++ },
    webkit: { messageHandlers: { portboard: { postMessage: (m: any) => posted.push(m) } } },
    requestAnimationFrame: (f: () => void) => f(),
    addEventListener: (t: string, fn: () => void) => { listeners[t] = fn; },
    ResizeObserver: observer('resize'),
    MutationObserver: observer('mutation'),
  };
  setupMacApp(doc, win);
  assert.equal(doc.documentElement.dataset.app, 'mac');
  assert.equal(brandKids.length, 1);
  assert.equal(brandKids[0].attrs['aria-label'], '뒤로');
  brandKids[0].on();
  assert.equal(back, 1);

  // reported once at once; nothing moved, nothing new is sent
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'bar');
  for (const t of ['resize', 'load']) listeners[t]();
  for (const o of observers) o.cb();
  assert.equal(posted.length, 1);
  // a chip grew: the next mutation reports the new layout
  h.controls[1] = rect(228, 9.5, 240, 33);
  observers.find((o) => o.kind === 'mutation')!.cb();
  assert.equal(posted.length, 2);
  assert.equal(posted[1].noDrag[1].width, 240);
  // back/forward cache: the same layout is reported again (the app forgot it when the navigation started)
  listeners.pageshow();
  assert.equal(posted.length, 3);
  // watched: the header's size, its subtree, and the app's attributes on <html>
  assert.deepEqual(observers.map((o) => [o.kind, o.targets.length]), [['resize', 1], ['mutation', 2]]);
  assert.equal(observers[1].targets[1], doc.documentElement);
});

test('without the app bridge (a browser in app mode for a screenshot) nothing is posted and nothing throws', () => {
  const h = header();
  h.querySelector = () => null;
  const doc: any = { documentElement: { dataset: {} }, querySelector: () => h, getElementById: () => null };
  setupMacApp(doc, { history: {} } as any);
  assert.equal(doc.documentElement.dataset.app, 'mac');
});

test('outside the app (node, a browser) nothing switches on', () => {
  assert.equal(inMacApp, false);
});

test('the page and the app agree: 78 px clear for the traffic lights, a 48 px bar', () => {
  const css = read('public/shell.css');
  const swift = read('mac-app/Sources/PortboardCore/Chrome.swift');
  const num = (name: string) => Number(swift.match(new RegExp(`static let ${name} = ([0-9.]+)`))?.[1]);
  const rule = css.match(/\[data-app="mac"\] \.top \{([^}]*)\}/)?.[1] ?? '';
  const padding = rule.match(/padding: (\d+)px (\d+)px (\d+)px (\d+)px/);
  assert.ok(padding, rule);
  assert.equal(Number(padding[4]), num('clearLeft'));
  assert.match(rule, new RegExp(`min-height: ${num('barHeight')}px`));
  // first row: top padding + .brand min-height + bottom padding + 1 px border = the bar
  const brand = Number(css.match(/\[data-app="mac"\] \.brand \{ min-height: (\d+)px; \}/)?.[1]);
  assert.equal(Number(padding[1]) + brand + Number(padding[3]) + 1, num('barHeight'));
  // the zoom button (16 + 2 × 20 + 14) ends before the controls start
  assert.ok(num('lightsX') + 2 * num('defaultStep') + num('buttonWidth') < num('clearLeft'));
  // browser and phone layouts are untouched: every new rule is scoped to the app, except hiding its back button
  const block = css.slice(css.indexOf('/* The Mac app (lib/macapp.js)'));
  const selectors = [...block.matchAll(/^([^\s/*}][^{}]*)\{/gm)].map((m) => m[1].trim());
  assert.ok(selectors.length > 5);
  for (const s of selectors) assert.ok(s.startsWith('[data-app="mac"]') || s === '.app-back', s);
  assert.match(block, /^\.app-back \{ display: none; \}/m);
  // the browser bar is the same height, so the layout under it doesn't move between the app and a browser
  assert.match(css, new RegExp(`--bar-h: ${num('barHeight')}px;`));
  assert.ok(!read('public/style.css').includes('data-app="mac"'), 'the app rules live in shell.css only');
});

test('the shell owns ← →: setupMacApp adds no back button of its own when #navBack is there', () => {
  const brandKids: any[] = [];
  const h: any = { getBoundingClientRect: () => rect(0, 0, 1440, 52), querySelectorAll: () => [], querySelector: () => ({ prepend: (b: any) => brandKids.push(b) }) };
  const doc: any = {
    documentElement: { dataset: {} },
    querySelector: () => h,
    getElementById: (id: string) => (id === 'navBack' ? {} : null),
    createElement: () => assert.fail('no back button when the shell has one'),
  };
  setupMacApp(doc, { history: {} } as any);
  assert.equal(brandKids.length, 0);
});

test('every page header, as served, has the .brand with the shell\'s ← (so no app-only back button) and the tabs', () => {
  // settings.html only redirects to the 설정 modal over 서비스 (public/settings.js)
  for (const page of ['index', 'devices', 'dev', 'service']) {
    const html = expandShell(read(`public/${page}.html`), { hostname: 'h', boot: '' });
    assert.match(html, /<header class="top">\s*<div class="brand">\s*<button type="button" id="sideToggle"/, page);
    assert.match(html, /id="navBack"/, page);
    assert.match(html, /<nav class="tabs shell-tabs"/, page);
  }
});

// The app's own text (mac-app/Resources/{en,ko}.lproj/Localizable.strings, read by PortboardCore/L10n.swift)

/** `"key" = "value";` lines of a .strings file; comments left out, `\"` `\\` `\n` unescaped */
function parseStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;\s*(?:\/\/.*)?$/);
    if (m) out.set(m[1], m[2].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)));
  }
  return out;
}

// Swift source without its comments (line, doc and block comments); string literals are kept, so `https://` stays
function swiftWithoutComments(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      if (c === '\\') { out += c + (next ?? ''); i++; continue; }
      if (c === '"' || c === '\n') inString = false;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else {
      if (c === '"') inString = true;
      out += c;
    }
  }
  return out;
}

test('the Mac app\'s text: en and ko have the same keys and placeholders, and every key is used in the Swift sources', () => {
  const enText = read('mac-app/Resources/en.lproj/Localizable.strings');
  const en = parseStrings(enText);
  const ko = parseStrings(read('mac-app/Resources/ko.lproj/Localizable.strings'));
  assert.ok(ko.size > 100, `${ko.size} keys`);
  assert.deepEqual([...en.keys()].sort(), [...ko.keys()].sort());
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [key, text] of ko) assert.deepEqual(placeholders(en.get(key) ?? ''), placeholders(text), key);
  const hangul = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;
  assert.doesNotMatch(enText, hangul, 'no Korean in the English file');
  assert.match(ko.get('shell.view.services') ?? '', hangul);

  const files = (readdirSync(new URL('../mac-app/Sources', import.meta.url), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.swift'))
    .map((f) => `mac-app/Sources/${f}`);
  assert.ok(files.length > 10, files.join(' '));
  const code = new Map(files.map((f) => [f, swiftWithoutComments(read(f))]));
  const all = [...code.values()].join('\n');
  // every L10n.t("key" and every key-like literal (the pool state table, ternaries) is in both files
  const used = new Set([...all.matchAll(/L10n\.t\(\s*"([^"]+)"/g), ...all.matchAll(/"((?:mac|shell|common)\.[A-Za-z0-9.]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 100, `${used.size} keys used`);
  for (const key of used) assert.ok(en.has(key) && ko.has(key), `${key} is used but missing from the .strings files`);
  for (const key of ko.keys()) assert.ok(all.includes(`"${key}"`), `${key} is not used in mac-app/Sources`);
  // no Korean left in the sources outside comments: all user-facing text goes through L10n.t
  for (const [f, src] of code) {
    src.split('\n').forEach((line, i) => assert.doesNotMatch(line, hangul, `${f} (code line ${i + 1}): ${line.trim()}`));
  }
});
