// The one shortcut registry (public/lib/keys.js, docs/research/rea-references.md #3): parsing and matching keys, how
// they read on a Mac and elsewhere, the dispatch and its scopes, the palette's 명령 rows, the ⌘/ dialog's sections,
// and no clash with the Mac app's own menu keys (mac-app/Sources/Portboard/PortboardApp.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, make } from './fixtures/fake-dom.ts';
// @ts-expect-error plain browser module, no types
import { ariaKeys, keyLabel, keysOf, MAC_APP_KEYS, matchKey, on, paletteEntries, parseKey, run, shortcutFor, shortcutSections, SHORTCUTS, typingIn } from '../public/lib/keys.js';

const ev = (key: string, mods: Record<string, boolean> = {}, target: any = null) => ({ key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('registry: unique ids, every entry has a label, a group and a known scope', () => {
  const ids = SHORTCUTS.map((s: any) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SHORTCUTS) {
    assert.ok(s.label && s.group, s.id);
    assert.ok(['any', 'page', 'list', 'native', 'hint'].includes(s.scope), s.id);
  }
  // today's keys are all in it
  const all = SHORTCUTS.flatMap((s: any) => [...keysOf(s, true), ...keysOf(s, false)]);
  for (const k of ['Mod+K', '/', 'Mod+\\', 'Escape', 'ArrowDown', 'ArrowUp', 'Mod+/']) assert.ok(all.includes(k), k);
});

test('parseKey / matchKey: Mod is ⌘ or Ctrl, Shift and Alt must match, "/" alone tolerates Shift', () => {
  assert.deepEqual(parseKey('Mod+Shift+K'), { mod: true, ctrl: false, meta: false, alt: false, shift: true, key: 'K' });
  assert.ok(matchKey(ev('k', { metaKey: true }), 'Mod+K'));
  assert.ok(matchKey(ev('K', { ctrlKey: true }), 'Mod+K'));
  assert.ok(!matchKey(ev('k'), 'Mod+K'));
  assert.ok(!matchKey(ev('k', { metaKey: true, shiftKey: true }), 'Mod+K'));
  assert.ok(!matchKey(ev('k', { metaKey: true, altKey: true }), 'Mod+K'));
  assert.ok(!matchKey(ev('k', { metaKey: true, ctrlKey: true }), 'Mod+K'));
  assert.ok(matchKey(ev('\\', { metaKey: true }), 'Mod+\\'));
  assert.ok(matchKey(ev('/'), '/'));
  assert.ok(matchKey(ev('/', { shiftKey: true }), '/'), 'a layout that needs Shift for /');
  assert.ok(!matchKey(ev('/', { metaKey: true }), '/'));
  assert.ok(matchKey(ev('/', { metaKey: true }), 'Mod+/'));
  assert.ok(matchKey(ev('ArrowLeft', { altKey: true }), 'Alt+ArrowLeft'));
  assert.ok(!matchKey(ev('ArrowLeft', { altKey: true, shiftKey: true }), 'Alt+ArrowLeft'));
  assert.ok(matchKey(ev('o', { metaKey: true, shiftKey: true }), 'Meta+Shift+O'));
  assert.ok(!matchKey(ev('o', { ctrlKey: true, shiftKey: true }), 'Meta+Shift+O'), 'Meta is ⌘ only');
});

test('keyLabel / ariaKeys: glyphs on a Mac (⌃ ⌥ ⇧ ⌘ order), words elsewhere', () => {
  assert.equal(keyLabel('Mod+K', true), '⌘K');
  assert.equal(keyLabel('Mod+K', false), 'Ctrl K');
  assert.equal(keyLabel('Mod+\\', true), '⌘\\');
  assert.equal(keyLabel('Mod+\\', false), 'Ctrl \\');
  assert.equal(keyLabel('Meta+Shift+O', true), '⇧⌘O');
  assert.equal(keyLabel('Control+Alt+Shift+Mod+X', true), '⌃⌥⇧⌘X');
  assert.equal(keyLabel('Alt+ArrowLeft', false), 'Alt ←');
  assert.equal(keyLabel('Escape', true), 'Esc');
  assert.equal(keyLabel('ArrowDown', false), '↓');
  const palette = SHORTCUTS.find((s: any) => s.id === 'palette');
  assert.equal(ariaKeys(palette, true), 'Meta+K /');
  assert.equal(ariaKeys(palette, false), 'Control+K /');
  // 뒤로 is ⌘[ on a Mac, Alt ← elsewhere
  const back = SHORTCUTS.find((s: any) => s.id === 'back');
  assert.deepEqual(keysOf(back, true), ['Mod+[']);
  assert.deepEqual(keysOf(back, false), ['Alt+ArrowLeft']);
});

test('Mac app: the registry never takes its menu keys, and MAC_APP_KEYS says what PortboardApp.swift binds', () => {
  const swift = readFileSync(new URL('../mac-app/Sources/Portboard/PortboardApp.swift', import.meta.url), 'utf8');
  const bound = [...swift.matchAll(/\.keyboardShortcut\("(.)", modifiers: (\.command|\[[^\]]+\])\)/g)].map(([, k, m]) =>
    `Meta+${m.includes('.shift') ? 'Shift+' : ''}${k.toUpperCase()}`);
  assert.match(swift, /KeyEquivalent\(Character\(String\(i \+ 1\)\)\), modifiers: \.command/, '⌘1… for the tabs');
  const appKeys = MAC_APP_KEYS.flatMap((s: any) => s.keys);
  for (const k of [...bound, 'Meta+1', 'Meta+2', 'Meta+3', 'Meta+4']) assert.ok(appKeys.includes(k), `${k} listed for the app`);
  // the page's own keys (any / page scope) on a Mac: none is an app key. 뒤로 ⌘[ is 'native': the same action, never intercepted
  const norm = (k: string) => { const c = parseKey(k); return `${c.ctrl ? 'Control+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${c.mod || c.meta ? 'Meta+' : ''}${c.key.toUpperCase()}`; };
  const app = new Set(appKeys.map(norm));
  // app: false entries (⌘, 설정) step aside in the app: the app's own key there
  for (const s of SHORTCUTS.filter((x: any) => (x.scope === 'any' || x.scope === 'page') && x.app !== false)) {
    for (const k of keysOf(s, true)) assert.ok(!app.has(norm(k)), `${s.id} ${k} is the Mac app's`);
  }
});

test('dispatch: one listener per document; handlers by id; "/" not in a field; native keys are left alone', () => {
  const doc = new FakeDocument();
  const calls: string[] = [];
  on('palette', () => { calls.push('palette'); }, doc as any);
  on('sidebar', () => { calls.push('sidebar'); }, doc as any);
  on('back', () => { calls.push('back'); }, doc as any);
  on('close', () => { calls.push('close'); return false; }, doc as any);
  assert.throws(() => on('nope', () => {}, doc as any), /no shortcut nope/);
  assert.ok(doc.key('k', { metaKey: true }));
  assert.ok(doc.key('/'));
  const field = make(doc, 'input');
  doc.body.append(field);
  assert.equal(doc.key('/', {}, field), false, '"/" types in a field');
  assert.ok(doc.key('k', { ctrlKey: true }, field), '⌘K works in a field');
  assert.equal(doc.key('[', { metaKey: true }), false, '⌘[ stays the browser\'s / the app\'s');
  assert.equal(doc.key('Escape'), false, 'a handler that returns false does not take the key');
  assert.deepEqual(calls, ['palette', 'palette', 'palette', 'close']);
  // IME composition belongs to the IME
  let prevented = false;
  for (const fn of doc.listeners.get('keydown')!) fn({ key: 'k', metaKey: true, isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(doc.listeners.get('keydown')!.length, 1, 'one listener for every entry');
  // a dialog open: "/" waits
  const dlg = make(doc, 'dialog');
  dlg.open = true;
  doc.body.append(dlg);
  assert.ok(typingIn(doc.body, doc));
  assert.equal(shortcutFor(ev('/', {}, doc.body), doc, true), null);
  assert.equal(shortcutFor(ev('\\', { metaKey: true }, doc.body), doc, true).id, 'sidebar');
  // the palette runs the same handler
  assert.ok(run('back', doc as any));
  assert.equal(calls.at(-1), 'back');
  assert.equal(run('inspector', doc as any), false, 'no handler on this page');
  // off() removes it
  const off = on('inspector', () => { calls.push('insp'); }, doc as any);
  off();
  assert.equal(run('inspector', doc as any), false);
});

test('palette rows: entries marked palette with a handler here, their keys as the platform says them', () => {
  const doc = new FakeDocument();
  on('sidebar', () => {}, doc as any);
  on('shortcuts', () => {}, doc as any);
  on('palette', () => {}, doc as any);
  const mac = paletteEntries(doc as any, true);
  assert.deepEqual(mac.map((e: any) => [e.id, e.title, e.keys]), [
    ['cmd:key:shortcuts', '키보드 단축키', ['⌘/']],
    ['cmd:key:sidebar', '사이드바 열기·닫기', ['⌘\\']],
  ]);
  assert.equal(mac[0].kind, 'cmd');
  assert.equal(mac[0].actions[0].key, 'go');
  assert.deepEqual(paletteEntries(doc as any, false).map((e: any) => e.keys), [['Ctrl /'], ['Ctrl \\']]);
});

test('dialog sections: 전체 · 목록 · 패널, and Mac 앱 (in place of the browser\'s 뒤로 / 앞으로) only in the app', () => {
  const web = shortcutSections({ mac: false, app: false });
  assert.deepEqual(web.map((s: any) => s.label), ['전체', '목록', '패널']);
  const general = web[0].rows.map((r: any) => `${r.label} ${r.keys.join('/')}`);
  assert.ok(general.includes('검색·명령 Ctrl K//'));
  assert.ok(general.includes('뒤로 Alt ←'));
  assert.ok(web[1].rows.some((r: any) => r.label === '다음 행 선택' && r.keys[0] === '↓'));
  assert.ok(web[2].rows.some((r: any) => r.keys[0] === '가장자리 끌기'), 'the drag hint');
  assert.ok(!web[2].rows.some((r: any) => r.label === '상세 패널 열기·닫기'), 'no key, no row (it is in the palette)');
  const app = shortcutSections({ mac: true, app: true });
  assert.deepEqual(app.map((s: any) => s.label), ['전체', '목록', '패널', 'Mac 앱']);
  assert.ok(!app[0].rows.some((r: any) => r.label === '뒤로'), 'the app section says ⌘[');
  assert.deepEqual(app[3].rows.find((r: any) => r.label === '브라우저에서 열기').keys, ['⇧⌘O']);
  assert.deepEqual(app[3].rows[0].keys, ['⌘1', '⌘2', '⌘3', '⌘4']);
});

test('platform: a Mac by navigator.platform or the Mac app\'s User-Agent; the app\'s keys always read as a Mac\'s', async () => {
  // @ts-expect-error plain browser module, no types
  const { isMacPlatform } = await import('../public/lib/keys.js');
  assert.equal(isMacPlatform({ platform: 'MacIntel', userAgent: '' }), true);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 portboard-mac/1.0' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false);
  assert.equal(isMacPlatform(undefined), false);
  const app = shortcutSections({ mac: false, app: true });
  assert.deepEqual(app.at(-1).rows.find((r: any) => r.label === '새로고침').keys, ['⌘R']);
});

test('⌘, opens 설정 in a browser; in the Mac app it is the app\'s own settings, so the page leaves it and the dialog says so', () => {
  const s = SHORTCUTS.find((x: any) => x.id === 'settings')!;
  assert.deepEqual(keysOf(s, true), ['Mod+,']);
  assert.equal(keyLabel('Mod+,', true), '⌘,');
  assert.equal(keyLabel('Mod+,', false), 'Ctrl ,');
  const doc = new FakeDocument();
  let opened = 0;
  on('settings', () => { opened++; }, doc as any);
  assert.ok(doc.key(',', { metaKey: true }));
  assert.equal(opened, 1);
  doc.documentElement.dataset.app = 'mac';
  assert.equal(doc.key(',', { metaKey: true }), false, 'the app\'s key');
  assert.equal(opened, 1);
  const rows = (o: any) => shortcutSections(o).flatMap((sec: any) => sec.rows.map((r: any) => `${r.label} ${r.keys.join('/')}`));
  assert.ok(rows({ mac: true, app: false }).includes('설정 ⌘,'));
  assert.ok(!rows({ mac: true, app: true }).includes('설정 ⌘,'));
  assert.ok(rows({ mac: true, app: true }).includes('Mac 앱 설정 ⌘,'));
  assert.match(readFileSync(new URL('../mac-app/Sources/Portboard/PortboardApp.swift', import.meta.url), 'utf8'), /Settings \{/, 'the app has a Settings scene (⌘,)');
});
