// The UI languages (docs/i18n/): both catalogs hold the same keys, every key the code uses exists and every key in
// them is used, the web and server formatters agree, and the language is chosen the way docs/i18n/ says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS, fill, lookup, requestLocale, t as st, withLocale, currentLocale } from '../src/core/i18n.ts';
import { resolveSite, parseSiteFile } from '../src/core/site.ts';
import { expandShell, fillStrings } from '../src/core/shell.ts';
import { setCatalog, t as wt, tn, loadLocalePref, saveLocalePref, LOCALE_KEY, LOCALE_COOKIE } from '../public/lib/i18n.js';
import { FakeDocument, fakeWindow, loadPage, runBoot } from './fixtures/fake-dom.ts';
import { code } from './fixtures/strip-comments.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;

const ko = CATALOGS.ko;
const en = CATALOGS.en;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every file whose code may use a key: the pages and their modules, the server, the scripts the docs run */
const CODE = [...walk('public'), ...walk('src')].filter((p) => /\.(js|ts|html|mjs)$/.test(p));

const placeholders = (v: string | Record<string, string>) =>
  [...new Set((typeof v === 'string' ? [v] : Object.values(v)).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();

test('both catalogs have the same keys, placeholders and plural forms', () => {
  assert.ok(Object.keys(ko).length > 50, 'the catalogs are read');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  for (const k of Object.keys(ko)) {
    assert.deepEqual(placeholders(en[k]), placeholders(ko[k]), `${k}: the same {placeholders}`);
    for (const v of [ko[k], en[k]]) {
      if (typeof v === 'string') continue;
      assert.ok(typeof v.other === 'string', `${k}: a plural has "other"`);
      for (const form of Object.keys(v)) assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(form), `${k}: ${form}`);
    }
  }
});

test('keys are dotted lowercase words, sorted, and the en catalog has no Korean but the language names', () => {
  for (const k of Object.keys(ko)) assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/, k);
  assert.deepEqual(Object.keys(ko), Object.keys(ko).sort(), 'ko.json is sorted');
  assert.deepEqual(Object.keys(en), Object.keys(en).sort(), 'en.json is sorted');
  const native = new Set(['settings.display.lang.ko']);
  for (const [k, v] of Object.entries(en)) if (!native.has(k)) assert.ok(!HANGUL.test(JSON.stringify(v)), `en ${k}: ${JSON.stringify(v)}`);
});

// A key at a call site is a literal: t('a.b'), tn("a.b"), data-t="a.b", data-t-title="a.b"; or a literal in a table
// the code passes on ('ports.kind.system' in a map). Built keys (t(`x.${y}`)) can't be checked, so they aren't allowed.
const CALL = /\b(?:t|tn)\(\s*(['"`])([^'"`]+?)\1/g;
const ATTR = /\bdata-t(?:h|-[a-z-]+)?="([^"$]+)"/g;
const LITERAL = /(['"`])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)\1/g;

test('every key the code uses is in the catalogs, and no key is built from parts', () => {
  const missing: string[] = [];
  const built: string[] = [];
  for (const f of CODE) {
    if (f.startsWith(join('public', 'i18n'))) continue;
    const src = code(f, read(f));
    for (const m of src.matchAll(CALL)) {
      if (m[2].includes('${')) built.push(`${f}: ${m[0]}`);
      else if (!(m[2] in ko) && /^[a-z]+\./.test(m[2])) missing.push(`${f}: ${m[2]}`);
    }
    for (const m of src.matchAll(ATTR)) if (!(m[1] in ko)) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(built, [], 'keys are literals');
  assert.deepEqual(missing, [], 'keys missing from the catalogs');
});

test('every catalog key is used somewhere', () => {
  const used = new Set<string>();
  for (const f of CODE) {
    if (f.startsWith(join('public', 'i18n'))) continue;
    const src = code(f, read(f));
    for (const m of src.matchAll(LITERAL)) used.add(m[2]);
    for (const m of src.matchAll(ATTR)) used.add(m[1]);
  }
  assert.deepEqual(Object.keys(ko).filter((k) => !used.has(k)), [], 'unused keys (remove them from both catalogs)');
});

test('t(): placeholders, plurals by count, the key itself when missing; web and server agree', () => {
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(st('shell.view.services', undefined, 'en'), 'Services');
  assert.equal(st('shell.view.services', undefined, 'ko'), '서비스');
  assert.equal(st('no.such.key'), 'no.such.key');
  assert.equal(lookup('boot.fold', {}, 'en'), 'Collapse or expand {name}');
  for (const l of ['ko', 'en'] as const) {
    setCatalog(l, CATALOGS[l]);
    for (const k of Object.keys(ko)) {
      const params = Object.fromEntries(placeholders(ko[k]).map((p) => [p, p === 'n' ? 3 : `<${p}>`]));
      assert.equal(wt(k, params), st(k, params, l), `${l} ${k}`);
      if (typeof CATALOGS[l][k] !== 'string') {
        for (const n of [0, 1, 2, 5]) assert.equal(wt(k, { ...params, n }), st(k, { ...params, n }, l), `${l} ${k} n=${n}`);
      }
    }
  }
  setCatalog('en', { 'x.items': { one: '{n} item', other: '{n} items' } });
  assert.equal(wt('x.items', { n: 1 }), '1 item');
  assert.equal(wt('x.items', { n: 4 }), '4 items');
  setCatalog(process.env.PORTBOARD_LOCALE === 'en' ? 'en' : 'ko', CATALOGS[process.env.PORTBOARD_LOCALE === 'en' ? 'en' : 'ko']);
});

test('tn(): <b>/<code> from the catalog become elements, params stay text unless they are nodes', () => {
  const doc = new FakeDocument();
  (globalThis as any).document = doc;
  try {
    setCatalog('en', { 'x.rich': 'Run <code>{cmd}</code> then <b>{what}</b> {link}.' });
    const link = doc.createElement('a');
    link.textContent = 'here';
    const out = tn('x.rich', { cmd: '<script>', what: 'restart', link });
    const text = out.map((n: any) => (typeof n === 'string' ? n : `[${n.tagName.toLowerCase()}:${n.textContent}]`)).join('');
    assert.equal(text, 'Run [code:<script>] then [b:restart] [a:here].');
  } finally {
    delete (globalThis as any).document;
    setCatalog(process.env.PORTBOARD_LOCALE === 'en' ? 'en' : 'ko', CATALOGS[process.env.PORTBOARD_LOCALE === 'en' ? 'en' : 'ko']);
  }
});

test('the device choice: pb.locale ko | en, anything else is 자동', () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  assert.equal(loadLocalePref(storage), 'auto');
  saveLocalePref('en', storage);
  assert.equal(m.get(LOCALE_KEY), 'en');
  assert.equal(loadLocalePref(storage), 'en');
  saveLocalePref('auto', storage);
  assert.equal(m.has(LOCALE_KEY), false);
  m.set(LOCALE_KEY, 'fr');
  assert.equal(loadLocalePref(storage), 'auto');
  assert.equal(loadLocalePref({ getItem() { throw new Error('blocked'); } }), 'auto');
  assert.equal(LOCALE_COOKIE, 'pb_locale');
});

test('the server locale: PORTBOARD_LOCALE, else portboard.json, else en; a bad value is ignored', () => {
  assert.equal(resolveSite({}).locale, 'en');
  assert.equal(resolveSite({}).sources.locale, 'default');
  assert.equal(resolveSite({ file: { locale: 'ko' } }).locale, 'ko');
  assert.equal(resolveSite({ file: { locale: 'ko' } }).sources.locale, 'file');
  assert.equal(resolveSite({ checkoutFile: { locale: 'ko' } }).locale, 'ko');
  assert.equal(resolveSite({ env: { PORTBOARD_LOCALE: 'en' }, file: { locale: 'ko' } }).locale, 'en');
  assert.equal(resolveSite({ env: { PORTBOARD_LOCALE: 'xx' }, file: { locale: 'ko' } }).locale, 'ko');
  const bad = parseSiteFile('{"locale":"fr","host":"devbox"}');
  assert.equal(bad.file.locale, undefined);
  assert.equal(bad.file.host, 'devbox');
  assert.match(bad.error ?? '', /locale/);
  // this install's checked-in file keeps production Korean (the public tree leaves the file out)
  if (existsSync(join(ROOT, 'portboard.json'))) assert.equal(JSON.parse(read('portboard.json')).locale, 'ko');
});

test('a request is answered in its pb_locale cookie, else the server locale', () => {
  assert.equal(requestLocale({ cookie: 'a=1; pb_locale=en; b=2' }), 'en');
  assert.equal(requestLocale({ cookie: 'pb_locale=ko' }), 'ko');
  assert.equal(requestLocale({ cookie: 'pb_locale=fr' }), null);
  assert.equal(requestLocale({ cookie: 'xpb_locale=en' }), null);
  assert.equal(requestLocale({}), null);
  assert.equal(withLocale('en', () => st('shell.view.dev')), 'Dev');
  assert.equal(withLocale('ko', () => st('shell.view.dev')), '개발');
  assert.equal(withLocale('en', async () => { await new Promise((r) => setTimeout(r, 1)); return currentLocale(); }) instanceof Promise, true);
});

test('the pages are served in the server locale with every data-t filled; nothing Korean is left in en', () => {
  for (const page of ['index.html', 'devices.html', 'dev.html', 'service.html', 'settings.html']) {
    for (const locale of ['en', 'ko'] as const) {
      const html = expandShell(read(`public/${page}`), { hostname: 'devbox', boot: '', locale });
      assert.match(html, new RegExp(`<html lang="${locale}"`), `${page} ${locale}`);
      // an element with a key and nothing in it: a key that didn't fill
      assert.deepEqual([...html.matchAll(/<[^>]*\sdata-th?="([^"]+)"[^>]*><\//g)].map((m) => m[1]), [], `${page} ${locale}: empty data-t`);
      const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');
      if (locale === 'en') assert.ok(!HANGUL.test(visible), `${page}: Korean in the en page: ${visible.match(new RegExp(`.{0,40}${HANGUL.source}.{0,40}`))?.[0]}`);
    }
  }
  assert.equal(fillStrings('<b data-t="common.close"></b><i data-t-title="common.refresh"></i>', 'en'), '<b data-t="common.close">Close</b><i data-t-title="common.refresh" title="Refresh"></i>');
  assert.equal(fillStrings('<a data-t-title="x.missing"></a>', 'en'), '<a data-t-title="x.missing" title="x.missing"></a>');
});

test('the boot script picks the device choice, then a set server locale, then the browser, and relabels', () => {
  const boot = read('public/lib/shell-boot.js');
  const pick = (stored: string | null, opts: Record<string, unknown>, languages: string[]) => {
    const store = new Map<string, string>(stored ? [['pb.locale', stored]] : []);
    const win = fakeWindow(1440, store);
    const doc = new FakeDocument();
    let cookie = '';
    Object.defineProperty(doc, 'cookie', { get: () => cookie, set: (v: string) => { cookie = v.split(';')[0]; } });
    new Function('window', 'document', 'navigator', boot)(win, doc, { userAgent: 'node', languages });
    win.PortboardBoot.start({ inspector: false, locales: ['en', 'ko'], strings: { en: {}, ko: {} }, ...opts });
    return { lang: doc.documentElement.getAttribute('lang') ?? (doc.documentElement as any).lang, cookie };
  };
  assert.deepEqual(pick('en', { locale: 'ko', explicit: true }, ['ko-KR']), { lang: 'en', cookie: 'pb_locale=en' });
  assert.equal(pick(null, { locale: 'ko', explicit: true }, ['en-US']).lang, 'ko');
  assert.equal(pick(null, { locale: 'en', explicit: false }, ['ko-KR', 'en']).lang, 'ko');
  assert.equal(pick(null, { locale: 'en', explicit: false }, ['fr-FR']).lang, 'en');
  assert.equal(pick('xx', { locale: 'ko', explicit: false }, ['de']).lang, 'ko');

  // a ko server page on a device set to English: the shell's text and the page's markup in English before paint
  const html = expandShell(read('public/index.html'), { hostname: 'devbox', boot: '', locale: 'ko' });
  const doc = new FakeDocument();
  loadPage(doc, html);
  const win = fakeWindow(1440, new Map([['pb.locale', 'en']]));
  const b = runBoot(boot, doc, win);
  b.start({ inspector: true, locale: 'ko', explicit: true, locales: ['en', 'ko'], strings: { en: Object.fromEntries(Object.entries(en).filter(([k]) => /^(shell|page|boot|common)\./.test(k))), ko: {} } });
  b.relabel();
  assert.equal(doc.querySelector('#empty')!.textContent, 'No ports to show.');
  assert.equal(doc.querySelector('#q')!.getAttribute('placeholder'), 'Search ports, names, projects');
  assert.equal(doc.querySelector('#sideToggle')!.getAttribute('aria-label'), 'Sidebar (⌘\\)');
  // a <template>'s content too: the 서비스 row's 상세 summary
  const tpl = doc.createElement('template') as any;
  const content = doc.createElement('div');
  const summary = doc.createElement('summary');
  summary.dataset.t = 'page.row.more';
  summary.textContent = '상세';
  content.append(summary);
  tpl.content = content;
  doc.body.append(tpl);
  b.relabel();
  assert.equal(summary.textContent, 'Details');
});

test('the inlined boot strings are only the shell, page, boot and common keys', () => {
  const html = expandShell(read('public/dev.html'), { hostname: 'h', boot: '', locale: 'ko' });
  const opts = JSON.parse(html.match(/PortboardBoot\.start\((\{.*?\})\);<\/script>/s)![1]);
  assert.equal(opts.locale, 'ko');
  assert.deepEqual(opts.locales, ['en', 'ko']);
  for (const l of ['en', 'ko']) for (const k of Object.keys(opts.strings[l])) assert.match(k, /^(shell|page|boot|common)\./);
  assert.ok(JSON.stringify(opts).length < 40_000, 'small enough to inline in every page');
});

test('the catalogs are served as JSON', () => {
  assert.match(read('src/server.ts'), /'\.json': 'application\/json/);
  // the screenshot harness stays in the private repo
  if (existsSync(join(ROOT, 'docs/frontend-modules/serve-static.mjs'))) assert.match(read('docs/frontend-modules/serve-static.mjs'), /'\.json': 'application\/json/);
});
