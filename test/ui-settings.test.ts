// The 설정 modal (docs/settings/): its route (lib/settings-route.js), the settings.html redirect, 목록 너비
// (lib/list-width.js and its copy in lib/shell-boot.js), the sections against the registry's #settings scripts, and
// the modal's history on the fake DOM: open pushes, sections push, × goes back over our entries, back/forward follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, fakeWindow, make, runBoot } from './fixtures/fake-dom.ts';
import { DEFAULT_SECTION, isSettingsHash, legacySection, linkSection, settingsHash, settingsSection, SETTINGS_IDS, SETTINGS_LABELS } from '../public/lib/settings-route.js';
import { applyListWidth, LIST_WIDTH_KEY, LIST_WIDTHS, loadListWidth, saveListWidth } from '../public/lib/list-width.js';
import { REGISTRY } from '../src/features/registry.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('route: #settings/<id>; #settings alone and unknown ids are 시작하기; other hashes are not ours', () => {
  assert.deepEqual(SETTINGS_IDS, ['start', 'remote', 'write-devices', 'port-rules', 'notify', 'claude', 'secrets', 'display', 'about']);
  assert.equal(SETTINGS_LABELS['write-devices'], '쓰기 허용 기기');
  assert.equal(DEFAULT_SECTION, 'start');
  assert.equal(settingsHash('remote'), '#settings/remote');
  assert.equal(settingsSection('#settings/remote'), 'remote');
  assert.equal(settingsSection('#settings'), 'start');
  assert.equal(settingsSection('#settings/'), 'start');
  assert.equal(settingsSection('#settings/nope'), 'start');
  for (const h of ['', '#', '#8790', '#settingsx', '#remote', null, undefined]) assert.equal(settingsSection(h as any), null, String(h));
  assert.ok(isSettingsHash('#settings/about'));
  assert.ok(!isSettingsHash('#5173'));
});

test('links: settings.html and its old anchors on this origin, #settings on this page; the rest is not a settings link', () => {
  const base = 'https://box.ts.net:8443/devices.html#mac';
  assert.equal(legacySection('#remote'), 'remote');
  assert.equal(legacySection('#settings/notify'), 'notify');
  assert.equal(legacySection(''), 'start');
  assert.equal(linkSection('settings.html#remote', base), 'remote');
  assert.equal(linkSection('settings.html', base), 'start');
  assert.equal(linkSection('/settings.html#write-devices', base), 'write-devices');
  assert.equal(linkSection('#settings/port-rules', base), 'port-rules');
  assert.equal(linkSection('https://box.ts.net:8443/settings.html#about', base), 'about');
  assert.equal(linkSection('https://elsewhere/settings.html#remote', base), null, 'another origin');
  assert.equal(linkSection('dev.html#settings/remote', base), null, 'another page: a navigation');
  assert.equal(linkSection('#mac', base), null);
  assert.equal(linkSection('', base), null);
  assert.equal(linkSection('./', base), null);
});

test('settings.html: only a redirect to ./#settings/<section> over 서비스, with the same section list', () => {
  const html = read('public/settings.html');
  assert.match(html, /<script src="settings\.js"><\/script>\s*<\/head>/, 'a classic script in <head>, before anything paints');
  assert.ok(!html.includes('<!--#shell:'), 'no shell: nothing to show before it moves on');
  const js = read('public/settings.js');
  const ids = JSON.parse(js.match(/var IDS = (\[[^\]]+\])/)![1].replace(/'/g, '"'));
  assert.deepEqual(ids, SETTINGS_IDS);
  for (const [hash, want] of [['#remote', './#settings/remote'], ['', './#settings/start'], ['#settings/notify', './#settings/notify'], ['#bogus', './#settings/start']]) {
    let to = '';
    new Function('location', js)({ hash, search: '', replace: (u: string) => { to = u; } });
    assert.equal(to, want, hash);
  }
  let kept = '';
  new Function('location', js)({ hash: '#about', search: '?x=1', replace: (u: string) => { kept = u; } });
  assert.equal(kept, './?x=1#settings/about');
});

test('목록 너비: 좁게·보통·넓게, kept per browser; 보통 sets nothing inline; storage that throws is 보통', () => {
  assert.deepEqual(LIST_WIDTHS, { narrow: [680, 808], normal: [808, 960], wide: [1080, 1280] });
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  assert.equal(loadListWidth(storage), 'normal');
  saveListWidth('wide', storage);
  assert.equal(store.get(LIST_WIDTH_KEY), 'wide');
  assert.equal(loadListWidth(storage), 'wide');
  saveListWidth('huge', storage);
  assert.equal(loadListWidth(storage), 'wide', 'unknown values are not saved');
  saveListWidth('normal', storage);
  assert.equal(store.has(LIST_WIDTH_KEY), false);
  store.set(LIST_WIDTH_KEY, 'junk');
  assert.equal(loadListWidth(storage), 'normal');
  assert.equal(loadListWidth({ getItem() { throw new Error('blocked'); } }), 'normal');
  saveListWidth('wide', { setItem() { throw new Error('full'); } } as any);

  const doc = new FakeDocument();
  const root = doc.documentElement as any;
  root.style.removeProperty = (k: string) => { delete root.style[k]; };
  applyListWidth('narrow', root);
  assert.equal(root.dataset.listWidth, 'narrow');
  assert.equal(root.style['--col-max'], '680px');
  assert.equal(root.style['--col-wide'], '808px');
  applyListWidth('normal', root);
  assert.equal(root.dataset.listWidth, undefined);
  assert.equal(root.style['--col-max'], undefined);
  // the shell's own widths are 보통's
  assert.match(read('public/shell.css'), /--col-max: 808px;\s*--col-wide: 960px;/);
});

test('목록 너비 before the first paint: lib/shell-boot.js has the same widths and puts them on <html> from pb.listWidth', () => {
  const boot = read('public/lib/shell-boot.js');
  const table = JSON.parse(boot.match(/var LIST_WIDTHS = (\{[^;]+\});/)![1].replace(/(\w+):/g, '"$1":'));
  const { normal, ...others } = LIST_WIDTHS;
  assert.deepEqual(table, others, '보통 is the stylesheet\'s: the boot leaves it out');
  assert.deepEqual(normal, [808, 960]);
  for (const [stored, want] of [['wide', ['wide', '1080px', '1280px']], ['narrow', ['narrow', '680px', '808px']], [null, [undefined, undefined, undefined]], ['junk', [undefined, undefined, undefined]]] as const) {
    const doc = new FakeDocument();
    const store = new Map<string, string>(stored ? [[LIST_WIDTH_KEY, stored]] : []);
    runBoot(boot, doc, fakeWindow(1440, store), 'node').start({ inspector: false });
    const root = doc.documentElement as any;
    assert.deepEqual([root.dataset.listWidth, root.style['--col-max'], root.style['--col-wide']], want, String(stored));
  }
  // storage that throws: the page still boots with the stylesheet's widths
  const doc = new FakeDocument();
  const win: any = fakeWindow(1440);
  win.localStorage = { getItem() { throw new Error('blocked'); }, setItem() {} };
  runBoot(boot, doc, win, 'node').start({ inspector: false });
  assert.equal((doc.documentElement as any).dataset.listWidth, undefined);
});

test('sections: the modal imports exactly the registry\'s #settings scripts, each fills its own container', async () => {
  (globalThis as any).__PB_NO_AUTO__ = true;
  const { SECTIONS } = await import('../public/features/settings-modal.js');
  assert.deepEqual(SECTIONS.map((s: any) => s.id), SETTINGS_IDS, 'menu order');
  assert.deepEqual(SECTIONS.map((s: any) => s.label), SETTINGS_IDS.map((id) => SETTINGS_LABELS[id as keyof typeof SETTINGS_LABELS]));
  const scripts = SECTIONS.filter((s: any) => s.script).map((s: any) => `features/${s.script}`).sort();
  const declared = REGISTRY.ui.filter((u) => u.pages.includes('#settings')).map((u) => u.script).sort();
  assert.deepEqual(scripts, declared);
  for (const s of SECTIONS.filter((x: any) => x.script)) {
    const src = read(`public/features/${s.script}`);
    assert.match(src, new RegExp(`\\$\\('${s.body}'\\)`), `${s.script} fills #${s.body}`);
    assert.match(src, /document\.addEventListener\('settings:mount', \w+\)/, `${s.script} mounts when the modal builds its section`);
  }
  // write sections are the ones with data-write controls (they get the read-only line)
  for (const s of SECTIONS.filter((x: any) => x.write)) assert.match(read(`public/features/${s.script}`), /write: (true|'1')|data-write|dataset: \{ write/, s.id);
  // the modal is on the pages; settings.html only redirects
  const pages = REGISTRY.ui.filter((u) => u.script === 'features/settings-modal.js').flatMap((u) => u.pages);
  for (const p of ['index.html', 'devices.html', 'dev.html', 'service.html']) assert.ok(pages.includes(p), p);
});

test('the pages that read their own hash leave #settings alone', () => {
  assert.match(read('public/app.js'), /hashchange', \(\) => \{ if \(!isSettingsHash\(location\.hash\)\) select\(/);
  assert.match(read('public/service.js'), /hashchange', \(\) => \{ if \(isSettingsHash\(location\.hash\)\) return;/);
  assert.match(read('public/dev.js'), /!isSettingsHash\(location\.hash\)/);
  const devices = read('public/devices.js');
  assert.match(devices, /location\.hash\.length > 1 && !isSettingsHash\(location\.hash\)/, 'not opened as a device on load');
  assert.match(devices, /hashchange', \(\) => \{\n  if \(isSettingsHash\(location\.hash\)\) return;/, 'nor on a hash change');
});

// ---- the modal's history on the fake DOM ----

function browser(path = '/', hash = '') {
  const doc = new FakeDocument();
  const head = make(doc, 'head', {}, make(doc, 'link', { rel: 'stylesheet', href: 'settings.css' }));
  doc.documentElement.prepend(head);
  (doc as any).head = head;
  doc.body.append(make(doc, 'a', { id: 'side', href: 'settings.html' }), make(doc, 'div', { id: 'toast' }));
  const entries = [{ url: path + hash, state: null as any }];
  let at = 0;
  const listeners = new Map<string, ((e: any) => void)[]>();
  const loc: any = {};
  const sync = () => {
    const u = new URL(entries[at].url, 'https://box');
    loc.pathname = u.pathname;
    loc.search = u.search;
    loc.hash = u.hash;
    loc.href = u.href;
  };
  sync();
  const fire = (type: string, e: any = {}) => { for (const fn of listeners.get(type) ?? []) fn({ type, ...e }); };
  const history: any = {
    get state() { return entries[at].state; },
    get length() { return entries.length; },
    pushState(state: any, _t: string, url: string) { entries.splice(at + 1); entries.push({ url: new URL(url, loc.href).pathname + new URL(url, loc.href).search + new URL(url, loc.href).hash, state }); at++; sync(); },
    replaceState(state: any, _t: string, url: string) { const u = new URL(url, loc.href); entries[at] = { url: u.pathname + u.search + u.hash, state }; sync(); },
    go(n: number) { const old = loc.href; at = Math.max(0, Math.min(entries.length - 1, at + n)); sync(); fire('popstate', { state: entries[at].state }); if (old.split('#')[1] !== loc.href.split('#')[1]) fire('hashchange', { oldURL: old, newURL: loc.href }); },
    back() { history.go(-1); },
    forward() { history.go(1); },
  };
  Object.assign(globalThis, {
    document: doc, location: loc, history,
    window: { addEventListener: (t: string, fn: any) => listeners.set(t, [...(listeners.get(t) ?? []), fn]) },
    sessionStorage: { getItem: () => null, setItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  return { doc, entries: () => entries.map((e) => e.url), at: () => at, history, loc, fire };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('history: open pushes #settings/start, a section pushes, × goes back over them to the page as it was', async () => {
  const b = browser('/', '#8790');
  (globalThis as any).__PB_NO_AUTO__ = true;
  const m = await import('../public/features/settings-modal.js');
  m.initSettings();
  // a click on a settings.html link (the sidebar) opens it in place
  let prevented = false;
  for (const fn of b.doc.listeners.get('click') ?? []) fn({ target: b.doc.getElementById('side'), button: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented, 'no navigation');
  await tick();
  const dialog: any = b.doc.getElementById('settingsModal');
  assert.ok(dialog.open);
  assert.deepEqual(b.entries(), ['/#8790', '/#settings/start']);
  assert.equal(dialog.querySelector('section[data-section="start"]').hidden, false);
  assert.equal(dialog.querySelector('section[data-section="remote"]').hidden, true);
  assert.equal(dialog.querySelector('a[data-section="start"]').getAttribute('aria-current'), 'page');
  assert.ok(b.doc.getElementById('startBody') && b.doc.getElementById('remoteBody') && b.doc.getElementById('displayBody'), 'the containers the section scripts fill');
  assert.ok(b.doc.getElementById('listWidth'), '화면 has the 목록 너비 control');

  await m.openSettings('remote');
  assert.deepEqual(b.entries(), ['/#8790', '/#settings/start', '/#settings/remote']);
  assert.equal(dialog.querySelector('section[data-section="remote"]').hidden, false);
  await m.openSettings('remote');
  assert.equal(b.entries().length, 3, 'the same section again: no entry');

  // back moves between sections
  b.history.back();
  await tick();
  assert.equal(b.loc.hash, '#settings/start');
  assert.ok(dialog.open);
  assert.equal(dialog.querySelector('section[data-section="start"]').hidden, false);
  b.history.forward();
  await tick();
  assert.equal(dialog.querySelector('section[data-section="remote"]').hidden, false);

  // ×: back over our two entries, to the selected port
  dialog.querySelector('.st-close').click();
  await tick();
  assert.equal(dialog.open, false);
  assert.equal(b.loc.hash, '#8790');
  assert.equal(b.at(), 0);
  // forward reopens it where it was
  b.history.forward();
  b.history.forward();
  await tick();
  assert.ok(dialog.open);
  assert.equal(b.loc.hash, '#settings/remote');
  // Esc from there
  const e: any = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
  dialog.dispatch('keydown', e);
  await tick();
  assert.equal(dialog.open, false);
  assert.equal(b.loc.hash, '#8790');

  // opened by a typed hash (no entry of ours): × replaces it with the URL before
  b.history.pushState(null, '', '#settings/about');
  b.fire('hashchange', { oldURL: 'https://box/#8790', newURL: 'https://box/#settings/about' });
  await tick();
  assert.ok(dialog.open);
  assert.equal(dialog.querySelector('section[data-section="about"]').hidden, false);
  dialog.querySelector('.st-close').click();
  await tick();
  assert.equal(dialog.open, false);
  assert.equal(b.loc.hash, '#8790');
  assert.deepEqual(b.entries().slice(-1), ['/#8790']);
});
