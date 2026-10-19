// The 설정 controls (public/lib/controls.js): toggle, segmented and menu-select keep the form-control contract the
// section scripts rely on (.value, .disabled, .checked, a change event, data-write), the menu's keys, and row().
// On the fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument } from './fixtures/fake-dom.ts';
import { menuSelect, row, segmented, toggle } from '../public/lib/controls.js';

const doc = new FakeDocument();
(globalThis as any).document = doc;

const key = (el: any, k: string) => {
  const e: any = { key: k, prevented: false, stopped: false };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  el.dispatch('keydown', e);
  return e;
};

test('toggle: a real checkbox with role=switch (so input[type=checkbox] queries and .checked work), the write mark on both', () => {
  const seen: boolean[] = [];
  const t: any = toggle({ id: 'wd-mac', value: 'mac', checked: true, label: 'mac에서 바꾸기 허용', write: true, onChange: (v: boolean) => seen.push(v) });
  doc.body.append(t);
  assert.equal(t.tagName, 'LABEL');
  assert.equal(t.className, 'ctl-toggle');
  const input = t.input;
  assert.equal(doc.querySelector('input[type="checkbox"]'), input);
  assert.equal(input.getAttribute('role'), 'switch');
  assert.equal(input.id, 'wd-mac');
  assert.equal(input.value, 'mac');
  assert.equal(input.checked, true);
  assert.equal(input.getAttribute('aria-label'), 'mac에서 바꾸기 허용');
  assert.equal(input.dataset.write, '1');
  assert.equal(t.dataset.write, '1');
  assert.ok(t.querySelector('.ctl-toggle-track'));
  input.checked = false;
  input.dispatch('change');
  assert.deepEqual(seen, [false]);
  const locked: any = toggle({ disabled: true });
  assert.equal(locked.input.disabled, true);
  assert.equal(locked.input.checked, false);
  assert.equal(locked.dataset.write, undefined, 'no write mark unless asked');
});

test('segmented: radios in a radiogroup; .value reads and sets the pick, .disabled all of them; change on a pick', () => {
  const seen: string[] = [];
  const s: any = segmented({ id: 'pr_pinned', label: '고정', value: '', write: true, onChange: (v: string) => seen.push(v), options: [{ value: '', label: '정하지 않음' }, { value: 'true', label: '예' }, { value: 'false', label: '아니오' }] });
  assert.equal(s.getAttribute('role'), 'radiogroup');
  assert.equal(s.getAttribute('aria-label'), '고정');
  assert.equal(s.dataset.write, '1');
  const radios = s.querySelectorAll('input');
  assert.equal(radios.length, 3);
  assert.ok(radios.every((r: any) => r.getAttribute('type') === 'radio' && r.getAttribute('name') === radios[0].getAttribute('name')), 'one group');
  assert.equal(s.value, '');
  radios[0].checked = false;
  radios[1].checked = true;
  radios[1].dispatch('change');
  assert.deepEqual(seen, ['true']);
  assert.equal(s.value, 'true');
  s.value = 'false';
  assert.deepEqual(radios.map((r: any) => r.checked), [false, false, true]);
  s.disabled = true;
  assert.ok(radios.every((r: any) => r.disabled));
  assert.equal(s.disabled, true);
  assert.ok(s.classList.contains('disabled'));
  // two controls never share a group
  const other: any = segmented({ options: [{ value: 'a', label: 'A' }], value: 'a' });
  assert.notEqual(other.querySelector('input').getAttribute('name'), radios[0].getAttribute('name'));
});

test('menuSelect: a borderless button with the current label; picking fires change and onChange; .value/.disabled like a select', () => {
  const seen: string[] = [];
  const changes: string[] = [];
  const m: any = menuSelect({
    id: 'digestMode', label: '요약 알림 주기', value: 'off', write: true, onChange: (v: string) => seen.push(v),
    options: [{ value: 'off', label: '끄기' }, { value: 'daily', label: '매일', desc: '매일 정한 시각에' }, { value: 'weekly', label: '매주 월요일' }],
  });
  doc.body.append(m);
  m.addEventListener('change', () => changes.push(m.value));
  assert.equal(doc.getElementById('digestMode'), m, 'the id the section looks up is the root');
  assert.equal(m.dataset.write, '1');
  const btn = m.querySelector('button');
  const list = m.querySelector('ul');
  assert.equal(btn.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(btn.getAttribute('aria-controls'), list.id);
  assert.equal(m.querySelector('.ctl-menu-text').textContent, '끄기');
  assert.equal(list.hidden, true);
  assert.equal(list.querySelectorAll('li').length, 3);
  assert.equal(list.querySelectorAll('.ctl-menu-desc').length, 1, 'a line under the options that have one');

  btn.click();
  assert.equal(list.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, list.querySelectorAll('li')[0], 'focus on the current option');
  key(list, 'ArrowDown');
  key(list, 'Enter');
  assert.deepEqual(seen, ['daily']);
  assert.deepEqual(changes, ['daily']);
  assert.equal(m.value, 'daily');
  assert.equal(list.hidden, true);
  assert.equal(doc.activeElement, btn, 'back on the button');
  assert.equal(m.querySelector('.ctl-menu-text').textContent, '매일');
  assert.equal(btn.title, '매일 정한 시각에');
  assert.deepEqual(list.querySelectorAll('li').map((li: any) => li.getAttribute('aria-selected')), ['false', 'true', 'false']);

  // the same option again: no change
  btn.click();
  key(list, 'Enter');
  assert.deepEqual(seen, ['daily']);

  // a click on an option
  btn.click();
  list.dispatch('click', { target: list.querySelectorAll('li')[2] });
  assert.equal(m.value, 'weekly');

  // Esc closes the menu only: the modal around it must not close (lib/modal.js skips a prevented Esc)
  key(btn, 'ArrowDown');
  assert.equal(list.hidden, false);
  const esc = key(list, 'Escape');
  assert.ok(esc.prevented && esc.stopped);
  assert.equal(list.hidden, true);

  // End / Home wrap, Tab closes without moving focus back
  btn.click();
  key(list, 'End');
  assert.equal(doc.activeElement, list.querySelectorAll('li')[2]);
  key(list, 'ArrowDown');
  assert.equal(doc.activeElement, list.querySelectorAll('li')[0], 'wraps');
  key(list, 'Tab');
  assert.equal(list.hidden, true);

  // a press outside closes it
  btn.click();
  for (const fn of doc.listeners.get('pointerdown') ?? []) fn({ target: doc.body });
  assert.equal(list.hidden, true);

  // set from the section's paint(), no change event
  m.value = 'off';
  assert.equal(m.querySelector('.ctl-menu-text').textContent, '끄기');
  assert.equal(changes.length, 2);
  m.disabled = true;
  assert.equal(btn.disabled, true);
  btn.click();
  assert.equal(list.hidden, true, 'a disabled menu does not open');
});

test('row: label and description left, control right; the 69 px class only with a description', () => {
  const r: any = row({ label: '목록 너비', desc: '이 기기만', control: doc.createElement('span'), id: 'r1' });
  assert.equal(r.className, 'st-row has-desc');
  assert.equal(r.id, 'r1');
  assert.equal(r.querySelector('.st-row-label').textContent, '목록 너비');
  assert.equal(r.querySelector('.st-row-desc').textContent, '이 기기만');
  assert.ok(r.querySelector('.st-row-ctl'));
  const bare: any = row({ label: 'x' });
  assert.equal(bare.className, 'st-row');
  assert.equal(bare.querySelector('.st-row-ctl'), null);
});

test('settings.css: the measured sizes, no fixed control widths, the 768 px step', () => {
  const css = readFileSync(new URL('../public/settings.css', import.meta.url), 'utf8');
  assert.match(css, /width: min\(1024px, calc\(100vw - 32px\)\)/);
  assert.match(css, /height: min\(800px, calc\(100dvh - 32px\)\)/);
  assert.match(css, /border-radius: 12px/);
  assert.match(css, /--st-backdrop: rgb\(0 0 0 \/ 40%\)/);
  assert.match(css, /--st-backdrop: rgb\(0 0 0 \/ 50%\)/);
  assert.ok(!/backdrop-filter/.test(css), 'no blur');
  assert.match(css, /grid-template-columns: 212px minmax\(0, 1fr\)/);
  assert.match(css, /\.st-tab \{[^}]*height: 32px[^}]*font-size: 14px/);
  assert.match(css, /\.st-tab\[aria-current\] \{[^}]*font-weight: 500/);
  assert.match(css, /\.st-row \{[^}]*min-height: 57px/);
  assert.match(css, /\.st-row\.has-desc, \.st-row:has\(\.st-row-desc\) \{ min-height: 69px; \}/);
  assert.match(css, /--st-divider: rgb\(0 0 0 \/ 5%\)/);
  assert.match(css, /\.st-sec-title \{[^}]*font-size: 15px; font-weight: 600/);
  assert.match(css, /\.ctl-toggle \{[^}]*width: 36px; height: 20px/);
  assert.match(css, /\.ctl-toggle-input:checked \+ \.ctl-toggle-track \{ background: var\(--accent\); \}/, "Portboard's accent");
  assert.match(css, /\.ctl-seg \{[^}]*height: 32px/);
  assert.match(css, /@media \(max-width: 767\.98px\)/, '768 keeps the menu');
  // the bug the measurement found in Claude: a fixed 252 px dropdown crushing the label at 390 px
  for (const rule of css.match(/\.ctl-[\w-]+[^{]*\{[^}]*\}/g) ?? []) assert.ok(!/(^|[\s;{])width: \d+px/.test(rule.replace(/\.ctl-toggle[^{]*\{[^}]*\}/, '')), rule);
  assert.match(css, /\.st-row-text \{ flex: 1 1 240px; min-width: 0;/);
});
