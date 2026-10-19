// 설정 tab · 쓰기 허용 기기 (src/features/write-devices.ts): the owner's tailnet devices with a checkbox each, saved to
// access.json's writeDevices. The device in use can't be left out (the server refuses it too, 409), so nobody locks
// themselves out; loopback (the server itself) is always the owner whatever the list says.

import { errorText, post, tryJSON } from '../lib/api.js';
import { toggle } from '../lib/controls.js';
import { $, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';

let view = null;

const OS = { macOS: 'Mac', iOS: 'iPhone·iPad', android: 'Android', windows: 'Windows', linux: 'Linux' };

/** A device row: its name and what it is on the left, a switch (a real checkbox, which save() reads) on the right */
function box(name, checked, opts = {}) {
  const id = `wd-${name.replace(/[^\w-]/g, '_')}`;
  const sw = toggle({ id, value: name, checked, disabled: !!opts.locked, write: true, label: t('writeDevices.allow', { name }) });
  return h(
    'li',
    { class: 'st-row' },
    h(
      'label',
      // data-write on the label: a read-only viewer can't toggle it by clicking the name either
      { class: 'st-row-text', for: id, title: opts.locked ? t('writeDevices.locked') : null, dataset: { write: '1' } },
      h('span', { class: 'st-row-label' }, h('strong', null, name), opts.current ? h('span', { class: 'badge info' }, t('writeDevices.current')) : null),
      opts.os || opts.other
        ? h('span', { class: 'st-row-desc' }, opts.os ? OS[opts.os] ?? opts.os : '', opts.other ? t('writeDevices.other') : '')
        : null,
    ),
    h('div', { class: 'st-row-ctl' }, sw),
  );
}

function stateLine(v) {
  if (v.error) return t('writeDevices.state.error', { path: v.path, error: v.error });
  if (!v.list && !v.env.length) return t('writeDevices.state.open');
  const n = (v.list ?? []).length;
  return t('writeDevices.state.limited', { n, path: v.path });
}

function paint() {
  const body = $('wdBody');
  if (!body || !view) return;
  const v = view;
  const current = v.current?.name ?? null;
  const items = [];
  for (const d of v.devices ?? []) {
    // unset list: start from the device in use and the personal ones the checklist suggests
    const checked = v.list ? d.listed : d.current || /^(macos|ios|android|windows)$/i.test(d.os ?? '');
    items.push(box(d.name, checked || d.current, { os: d.os, current: d.current, locked: d.current }));
  }
  for (const o of v.others) items.push(box(o, true, { other: true }));
  // replaceChildren() would print a null as text: leave the empty parts out
  body.replaceChildren(
    ...[
      h('p', { class: 'set-note', style: 'margin-top:0' }, stateLine(v)),
      v.devices === null
        ? h('p', { class: 'set-note' }, t('writeDevices.noTailscale'))
        : h('ul', { class: 'wd-list st-rows', id: 'wdList', 'aria-label': t('writeDevices.title') }, items),
      v.env.length ? h('p', { class: 'set-note' }, t('writeDevices.env', { list: v.env.join(', ') })) : null,
      h(
        'div',
        { class: 'ac-actions' },
        h('button', { type: 'button', class: 'btn primary', id: 'wdSave', dataset: { write: '1' }, onclick: save }, t('writeDevices.save')),
        h('span', { class: 'set-note', style: 'margin:0' }, current ? t('writeDevices.keepCurrent', { name: current }) : v.source === 'loopback' ? t('writeDevices.loopback') : ''),
      ),
      h('p', { class: 'set-note' }, t('writeDevices.serverNote')),
    ].filter(Boolean),
  );
}

async function save() {
  const picked = [...document.querySelectorAll('#wdList input[type=checkbox]')].filter((i) => i.checked).map((i) => i.value);
  const r = await post('/api/settings/write-devices', { writeDevices: picked });
  if (!r.ok) {
    toast(t('writeDevices.saveFailed', { error: errorText(r) }), true, { ms: 7000 });
    return;
  }
  view = r.body;
  paint();
  toast(r.body.message ?? t('writeDevices.saved'));
}

async function refresh() {
  const body = $('wdBody');
  if (!body) return;
  const next = await tryJSON('/api/settings/write-devices');
  if (!next) {
    body.replaceChildren(el('p', 'set-note', t('writeDevices.loadFailed')));
    return;
  }
  view = next;
  paint();
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('wdBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
