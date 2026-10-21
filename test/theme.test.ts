// 설정 › 화면 › 테마 (public/lib/theme.js): 시스템 · 라이트 · 다크 kept per device, put on <html data-theme> by the
// settings control and, before the first paint, by lib/shell-boot.js; the stylesheets' forced-dark blocks match their
// prefers-color-scheme blocks; the Mac app hears the choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootLocale } from '../src/core/shell.ts';
import { FakeDocument, fakeWindow, runBoot } from './fixtures/fake-dom.ts';
// @ts-expect-error plain browser module, no types
import { applyTheme, loadTheme, saveTheme, THEME_KEY } from '../public/lib/theme.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('theme: remembered per device, 시스템 stores nothing, junk and blocked storage read as 시스템', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  assert.equal(loadTheme(storage), 'system');
  saveTheme('dark', storage);
  assert.equal(store.get(THEME_KEY), 'dark');
  assert.equal(loadTheme(storage), 'dark');
  saveTheme('purple', storage);
  assert.equal(loadTheme(storage), 'dark', 'an unknown value is not saved');
  saveTheme('system', storage);
  assert.equal(store.has(THEME_KEY), false);
  store.set(THEME_KEY, 'junk');
  assert.equal(loadTheme(storage), 'system');
  assert.equal(loadTheme({ getItem() { throw new Error('blocked'); } }), 'system');
  saveTheme('light', { setItem() { throw new Error('full'); } } as any);
});

test('applyTheme: data-theme on <html> (none for 시스템), no transitions while it switches, the Mac app is told', () => {
  const root = new FakeDocument().documentElement as any;
  const sent: unknown[] = [];
  const frames: (() => void)[] = [];
  const win = { requestAnimationFrame: (fn: () => void) => frames.push(fn), webkit: { messageHandlers: { portboard: { postMessage: (m: unknown) => sent.push(m) } } } };
  applyTheme('dark', root, win);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themeSwitching, '');
  while (frames.length) frames.shift()!();
  assert.equal(root.dataset.themeSwitching, undefined, 'transitions come back two frames later');
  applyTheme('system', root, win);
  assert.equal(root.dataset.theme, undefined);
  applyTheme('nonsense', root, {});
  assert.equal(root.dataset.theme, undefined);
  assert.deepEqual(sent, [{ type: 'theme', theme: 'dark' }, { type: 'theme', theme: 'system' }]);
});

test('theme before the first paint: lib/shell-boot.js puts pb.theme on <html> and tells the Mac app', () => {
  const boot = read('public/lib/shell-boot.js');
  for (const [stored, want] of [['dark', 'dark'], ['light', 'light'], [null, undefined], ['junk', undefined]] as const) {
    const doc = new FakeDocument();
    const win: any = fakeWindow(1440, new Map(stored ? [[THEME_KEY, stored]] : []));
    const sent: unknown[] = [];
    win.webkit = { messageHandlers: { portboard: { postMessage: (m: unknown) => sent.push(m) } } };
    runBoot(boot, doc, win, 'node').start({ inspector: false, ...bootLocale('ko') });
    assert.equal((doc.documentElement as any).dataset.theme, want, String(stored));
    assert.deepEqual(sent, [{ type: 'theme', theme: want ?? 'system' }]);
  }
  // no Mac app, storage that throws: still boots, 시스템
  const doc = new FakeDocument();
  const win: any = fakeWindow(1440);
  win.localStorage = { getItem() { throw new Error('blocked'); }, setItem() {} };
  runBoot(boot, doc, win, 'node').start({ inspector: false, ...bootLocale('ko') });
  assert.equal((doc.documentElement as any).dataset.theme, undefined);
});

/** The declarations of the first rule block after `from` in css, normalised */
function block(css: string, from: string): string[] {
  const at = css.indexOf(from);
  assert.ok(at >= 0, from);
  const open = css.indexOf('{', at + from.length - 1);
  return css.slice(open + 1, css.indexOf('}', open)).split(';').map((d) => d.trim()).filter(Boolean);
}

test('stylesheets: the forced-dark block equals the prefers-color-scheme block, which stays out under data-theme="light"', () => {
  for (const [file, rule] of [['public/style.css', ''], ['public/settings.css', ''], ['public/devices.css', ' .tag.serve']] as const) {
    const css = read(file);
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    assert.deepEqual(block(css, `:root[data-theme="dark"]${rule} {`), block(media, `:root:not([data-theme="light"])${rule} {`), file);
    assert.equal(css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root \{/), null, `${file}: no unscoped dark :root`);
  }
});
