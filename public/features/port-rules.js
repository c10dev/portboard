// 설정 tab · 포트 규칙 (src/features/port-rules.ts, docs/config.md#port-rules): labels, pins, hiding and new-port
// notices for many ports at once — a range (3000-3010), host:port (localhost:5173) or a command-line regex
// (vite|next dev), with 나머지 포트 (otherPorts) as the default. GET /api/port-rules lists them in the order they are
// consulted; POST /api/port-rules {key, rule|null} saves or removes one. A port's own entry (a rename) always wins.
// The 서비스 tab's inspector shows which rule a port matched (ruleFacts, below).

import { errorText, post, tryJSON } from '../lib/api.js';
import { menuSelect, row, segmented } from '../lib/controls.js';
import { $, button, el, h } from '../lib/dom.js';
import { toast } from '../lib/toast.js';

export const ON_NEW_TEXT = {
  notify: '알림 (토스트 + 푸시)',
  openBrowserOnce: '토스트만 (열기)',
  silent: '조용히',
  ignore: '무시 (숨김)',
};

export const KIND_TEXT = { port: '포트', host: '호스트:포트', range: '범위', command: '명령', otherPorts: '나머지 포트' };

/** Where a field came from (port | rule:<key> | otherPorts | default), in Korean */
export function sourceText(src) {
  if (!src || src === 'default') return '기본값';
  if (src === 'port') return '이 포트의 항목';
  if (src === 'otherPorts') return '나머지 포트';
  return `규칙 ${src.replace(/^rule:/, '')}`;
}

/**
 * The inspector's 규칙 rows for a port: the rules that matched in precedence order, and where the name, 고정, 숨김
 * and 새 포트 알림 came from. Empty when the snapshot has no rule info (an older server).
 */
export function ruleFacts(p) {
  const r = p?.rules;
  if (!r?.from) return [];
  const rows = [['맞는 규칙', r.matched?.length ? r.matched.map((k) => (k === 'otherPorts' ? '나머지 포트' : k)).join(' → ') + (r.matched.length > 1 ? ' (앞이 우선)' : '') : '없음']];
  if (r.from.label !== 'default') rows.push(['이름', `${p.label} · ${sourceText(r.from.label)}`]);
  rows.push(['새 포트', `${ON_NEW_TEXT[p.onNew] ?? p.onNew} · ${sourceText(r.from.onNew)}`]);
  if (r.from.pinned !== 'default') rows.push(['고정', `${p.pinned ? '예' : '아니오'} · ${sourceText(r.from.pinned)}`]);
  if (r.from.hidden !== 'default') rows.push(['숨김', `${p.hidden ? '예' : '아니오'} · ${sourceText(r.from.hidden)}`]);
  return rows;
}

let view = null;
/** The rule being edited (its key), or null for a new one */
let editing = null;

function summary(rule) {
  const parts = [];
  if (rule.label) parts.push(`이름 “${rule.label}”`);
  if (rule.pinned !== undefined) parts.push(rule.pinned ? '고정' : '고정 안 함');
  if (rule.hidden !== undefined) parts.push(rule.hidden ? '숨김' : '숨기지 않음');
  if (rule.onNew) parts.push(`새 포트: ${ON_NEW_TEXT[rule.onNew]}`);
  return parts.join(' · ') || '아무것도 정하지 않음';
}

function ruleRow(r, i) {
  return h('li', null,
    h('span', { class: 'badge info', title: `${i + 1}번째로 확인` }, `${i + 1}`),
    h('span', null, h('code', { class: 'set-cmd' }, r.key === 'otherPorts' ? '나머지 포트' : r.key), ' ', h('span', { class: 'wd-os' }, KIND_TEXT[r.kind] ?? r.kind)),
    h('span', { class: 'ac-actions', style: 'margin-top:0' },
      button('수정', () => edit(r)),
      button('삭제', () => save(r.key, null), { danger: true, write: true })),
    h('p', { class: 'set-detail' }, summary(r.rule)));
}

function edit(r) {
  editing = r?.key ?? null;
  paintForm(r ?? null);
  $('prKey')?.focus();
}

function paintForm(r) {
  const form = $('prForm');
  if (!form) return;
  const rule = r?.rule ?? {};
  // segmented and menu-select (lib/controls.js) have .value like the <select>s they replaced: submit() reads them as before
  const tri = (name, label, v) =>
    row({
      label,
      control: segmented({
        id: `pr_${name}`, label, write: true, value: v === undefined ? '' : String(v),
        options: [{ value: '', label: '정하지 않음' }, { value: 'true', label: '예' }, { value: 'false', label: '아니오' }],
      }),
    });
  form.replaceChildren(
    h('h3', null, r ? `수정: ${r.key === 'otherPorts' ? '나머지 포트' : r.key}` : '규칙 추가'),
    h('div', { class: 'st-rows' },
      row({ label: '키', desc: '범위, 호스트:포트, 명령 정규식, 또는 otherPorts', control: h('input', { id: 'prKey', class: 'ctl-text', value: r?.key ?? '', placeholder: '18891-18899, localhost:5173, vite|next dev', 'aria-label': '키', readonly: !!r, dataset: { write: '1' } }) }),
      row({ label: '이름', control: h('input', { id: 'prLabel', class: 'ctl-text', value: rule.label ?? '', maxlength: 80, placeholder: '비우면 정하지 않음', 'aria-label': '이름', dataset: { write: '1' } }) }),
      row({
        label: '새 포트',
        control: menuSelect({
          id: 'prOnNew', label: '새 포트', write: true, value: rule.onNew ?? '',
          options: [{ value: '', label: '정하지 않음' }, ...Object.entries(ON_NEW_TEXT).map(([value, label]) => ({ value, label }))],
        }),
      }),
      tri('pinned', '고정', rule.pinned),
      tri('hidden', '숨김', rule.hidden)),
    h('div', { class: 'ac-actions' },
      button('저장', () => submit(), { write: true }),
      r ? button('취소', () => edit(null)) : null),
  );
}

function submit() {
  const key = $('prKey').value.trim();
  if (!key) return toast('키를 적어 주세요: 범위(3000-3010), 호스트:포트(localhost:5173), 명령 정규식, 또는 otherPorts', true);
  const tri = (v) => (v === '' ? null : v === 'true');
  const rule = {
    label: $('prLabel').value.trim() || null,
    onNew: $('prOnNew').value || null,
    pinned: tri($('pr_pinned').value),
    hidden: tri($('pr_hidden').value),
  };
  save(key, rule);
}

async function save(key, rule) {
  const r = await post('/api/port-rules', { key, rule });
  if (!r.ok) return toast(`저장하지 못했어요: ${errorText(r)}`, true);
  toast(rule === null ? `규칙 ${key}을(를) 지웠어요` : r.body.where === 'ports' ? `${key} 포트의 항목에 저장했어요` : `규칙 ${key}을(를) 저장했어요`);
  view = r.body.view ?? view;
  editing = null;
  paint();
}

function paint() {
  const body = $('rulesBody');
  if (!body || !view) return;
  const exact = view.exact ?? [];
  body.replaceChildren(
    ...[
      view.problems?.length ? h('p', { class: 'set-ro' }, `prefs.json에서 무시한 규칙: ${view.problems.join(' · ')}`) : null,
      view.rules.length
        ? h('ul', { class: 'set-list', 'aria-label': '포트 규칙 (확인하는 순서)' }, view.rules.map(ruleRow))
        : h('p', { class: 'set-note', style: 'margin-top:0' }, '아직 규칙이 없어요. 예: 18891-18899 → 이름 “스크래치패드 미리보기”, vite|next dev → 새 포트 알림.'),
      h('p', { class: 'set-note' },
        '확인 순서: ① 포트마다 저장한 이름·고정·숨김(이 포트의 항목, 항상 우선) ② 호스트:포트 ③ 범위(좁은 것 먼저) ④ 명령 정규식(적은 순서) ⑤ 나머지 포트(아무 규칙도 안 맞을 때) ⑥ 기본값. ',
        '항목마다 먼저 정한 쪽이 이겨요. 새 포트 기본값은 vite·next dev·astro·npm run dev 같은 개발 서버만 알림, 나머지는 조용히예요.'),
      exact.length
        ? h('details', null,
          h('summary', { class: 'set-note' }, `포트별 항목 ${exact.length}개 (규칙보다 우선)`),
          h('ul', { class: 'set-howto' }, exact.map((x) => h('li', null, h('b', null, String(x.port)), ' ', [x.label && `“${x.label}”`, x.onNew && `새 포트: ${ON_NEW_TEXT[x.onNew]}`].filter(Boolean).join(' · ')))))
        : null,
      h('div', { id: 'prForm', class: 'ac' }),
    ].filter(Boolean), // replaceChildren() would print a null as text
  );
  paintForm(editing ? view.rules.find((r) => r.key === editing) ?? null : null);
}

async function refresh() {
  const body = $('rulesBody');
  if (!body) return;
  const next = await tryJSON('/api/port-rules');
  if (!next) return body.replaceChildren(el('p', 'set-note', '포트 규칙을 읽지 못했어요.'));
  view = next;
  paint();
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount; the 서비스
 * page loads this module early, for the inspector's ruleFacts) */
function mount() {
  const body = $('rulesBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

if (typeof document !== 'undefined') {
  mount();
  document.addEventListener('settings:mount', mount);
}
