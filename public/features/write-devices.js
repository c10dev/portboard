// 설정 tab · 쓰기 허용 기기 (src/features/write-devices.ts): the owner's tailnet devices with a checkbox each, saved to
// access.json's writeDevices. The device in use can't be left out (the server refuses it too, 409), so nobody locks
// themselves out; loopback (the server itself) is always the owner whatever the list says.

import { errorText, post, tryJSON } from '../lib/api.js';
import { toggle } from '../lib/controls.js';
import { $, el, h } from '../lib/dom.js';
import { toast } from '../lib/toast.js';

let view = null;

const OS = { macOS: 'Mac', iOS: 'iPhone·iPad', android: 'Android', windows: 'Windows', linux: 'Linux' };

/** A device row: its name and what it is on the left, a switch (a real checkbox, which save() reads) on the right */
function box(name, checked, opts = {}) {
  const id = `wd-${name.replace(/[^\w-]/g, '_')}`;
  const sw = toggle({ id, value: name, checked, disabled: !!opts.locked, write: true, label: `${name}에서 바꾸기 허용` });
  return h(
    'li',
    { class: 'st-row' },
    h(
      'label',
      // data-write on the label: a read-only viewer can't toggle it by clicking the name either
      { class: 'st-row-text', for: id, title: opts.locked ? '지금 이 기기로 보고 있어요: 빼면 이 기기에서 더 바꿀 수 없어요' : null, dataset: { write: '1' } },
      h('span', { class: 'st-row-label' }, h('strong', null, name), opts.current ? h('span', { class: 'badge info' }, '지금 쓰는 기기') : null),
      opts.os || opts.other
        ? h('span', { class: 'st-row-desc' }, opts.os ? OS[opts.os] ?? opts.os : '', opts.other ? '목록에만 있음 (이름이 바뀌었거나 노드 ID)' : '')
        : null,
    ),
    h('div', { class: 'st-row-ctl' }, sw),
  );
}

function stateLine(v) {
  if (v.error) return `${v.path}을(를) 쓸 수 없어서 https 주소에서는 아무것도 바꿀 수 없어요: ${v.error}. 저장하면 새로 써요.`;
  if (!v.list && !v.env.length) return '아직 제한하지 않았어요: 소유자 계정으로 로그인한 기기는 모두 https 주소에서 바꿀 수 있어요. 쓸 기기만 고르고 저장하세요.';
  const n = (v.list ?? []).length;
  return `${n}대만 https 주소에서 바꿀 수 있어요 (${v.path}).`;
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
        ? h('p', { class: 'set-note' }, 'tailscale status를 읽지 못해 기기 목록을 만들 수 없어요.')
        : h('ul', { class: 'wd-list st-rows', id: 'wdList', 'aria-label': '쓰기 허용 기기' }, items),
      v.env.length ? h('p', { class: 'set-note' }, `환경 변수 PORTBOARD_WRITE_DEVICES로도 허용돼요 (여기서 바꿀 수 없어요): ${v.env.join(', ')}`) : null,
      h(
        'div',
        { class: 'ac-actions' },
        h('button', { type: 'button', class: 'btn primary', id: 'wdSave', dataset: { write: '1' }, onclick: save }, '저장'),
        h('span', { class: 'set-note', style: 'margin:0' }, current ? `지금 쓰는 기기(${current})는 뺄 수 없어요.` : v.source === 'loopback' ? '이 서버에서 직접 열었어요 (loopback은 항상 바꿀 수 있어요).' : ''),
      ),
      h('p', { class: 'set-note' }, '서버 자신(127.0.0.1로 직접 연결하는 Claude 세션·스크립트)은 이 목록과 상관없이 항상 바꿀 수 있어요. 목록에 없는 기기도 보기는 계속 돼요.'),
    ].filter(Boolean),
  );
}

async function save() {
  const picked = [...document.querySelectorAll('#wdList input[type=checkbox]')].filter((i) => i.checked).map((i) => i.value);
  const r = await post('/api/settings/write-devices', { writeDevices: picked });
  if (!r.ok) {
    toast(`저장하지 못했어요: ${errorText(r)}`, true, { ms: 7000 });
    return;
  }
  view = r.body;
  paint();
  toast(r.body.message ?? '저장했어요');
}

async function refresh() {
  const body = $('wdBody');
  if (!body) return;
  const next = await tryJSON('/api/settings/write-devices');
  if (!next) {
    body.replaceChildren(el('p', 'set-note', '쓰기 허용 기기를 읽지 못했어요.'));
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
