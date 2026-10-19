// 설정 tab · 포트 규칙 (src/features/port-rules.ts, docs/config.md#port-rules): labels, pins, hiding and new-port
// notices for many ports at once — a range (3000-3010), host:port (localhost:5173) or a command-line regex
// (vite|next dev), with 나머지 포트 (otherPorts) as the default. GET /api/port-rules lists them in the order they are
// consulted; POST /api/port-rules {key, rule|null} saves or removes one. A port's own entry (a rename) always wins.
// The 서비스 tab's inspector shows which rule a port matched (ruleFacts, below).

import { errorText, post, tryJSON } from '../lib/api.js';
import { menuSelect, row, segmented } from '../lib/controls.js';
import { $, button, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';

export const ON_NEW_TEXT = {
  notify: t('rules.onNew.notify'),
  openBrowserOnce: t('rules.onNew.openBrowserOnce'),
  silent: t('rules.onNew.silent'),
  ignore: t('rules.onNew.ignore'),
};

export const KIND_TEXT = { port: t('rules.kind.port'), host: t('rules.kind.host'), range: t('rules.kind.range'), command: t('rules.kind.command'), otherPorts: t('rules.otherPorts') };

/** Where a field came from (port | rule:<key> | otherPorts | default), in Korean */
export function sourceText(src) {
  if (!src || src === 'default') return t('rules.src.default');
  if (src === 'port') return t('rules.src.port');
  if (src === 'otherPorts') return t('rules.otherPorts');
  return t('rules.src.rule', { key: src.replace(/^rule:/, '') });
}

/**
 * The inspector's 규칙 rows for a port: the rules that matched in precedence order, and where the name, 고정, 숨김
 * and 새 포트 알림 came from. Empty when the snapshot has no rule info (an older server).
 */
export function ruleFacts(p) {
  const r = p?.rules;
  if (!r?.from) return [];
  const list = r.matched?.length ? r.matched.map((k) => (k === 'otherPorts' ? t('rules.otherPorts') : k)).join(' → ') : null;
  const rows = [[t('rules.fact.matched'), list ? (r.matched.length > 1 ? t('rules.fact.firstWins', { list }) : list) : t('rules.fact.none')]];
  if (r.from.label !== 'default') rows.push([t('rules.label'), `${p.label} · ${sourceText(r.from.label)}`]);
  rows.push([t('rules.onNew'), `${ON_NEW_TEXT[p.onNew] ?? p.onNew} · ${sourceText(r.from.onNew)}`]);
  if (r.from.pinned !== 'default') rows.push([t('rules.pinned'), `${p.pinned ? t('rules.yes') : t('rules.no')} · ${sourceText(r.from.pinned)}`]);
  if (r.from.hidden !== 'default') rows.push([t('rules.hidden'), `${p.hidden ? t('rules.yes') : t('rules.no')} · ${sourceText(r.from.hidden)}`]);
  return rows;
}

let view = null;
/** The rule being edited (its key), or null for a new one */
let editing = null;

function summary(rule) {
  const parts = [];
  if (rule.label) parts.push(t('rules.sum.label', { label: rule.label }));
  if (rule.pinned !== undefined) parts.push(rule.pinned ? t('rules.pinned') : t('rules.sum.notPinned'));
  if (rule.hidden !== undefined) parts.push(rule.hidden ? t('rules.hidden') : t('rules.sum.notHidden'));
  if (rule.onNew) parts.push(t('rules.sum.onNew', { what: ON_NEW_TEXT[rule.onNew] }));
  return parts.join(' · ') || t('rules.sum.nothing');
}

function ruleRow(r, i) {
  return h('li', null,
    h('span', { class: 'badge info', title: t('rules.position', { n: i + 1 }) }, `${i + 1}`),
    h('span', null, h('code', { class: 'set-cmd' }, r.key === 'otherPorts' ? t('rules.otherPorts') : r.key), ' ', h('span', { class: 'wd-os' }, KIND_TEXT[r.kind] ?? r.kind)),
    h('span', { class: 'ac-actions', style: 'margin-top:0' },
      button(t('rules.edit'), () => edit(r)),
      button(t('rules.delete'), () => save(r.key, null), { danger: true, write: true })),
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
        options: [{ value: '', label: t('rules.unset') }, { value: 'true', label: t('rules.yes') }, { value: 'false', label: t('rules.no') }],
      }),
    });
  form.replaceChildren(
    h('h3', null, r ? t('rules.form.edit', { key: r.key === 'otherPorts' ? t('rules.otherPorts') : r.key }) : t('rules.form.add')),
    h('div', { class: 'st-rows' },
      row({ label: t('rules.key'), desc: t('rules.key.desc'), control: h('input', { id: 'prKey', class: 'ctl-text', value: r?.key ?? '', placeholder: '18891-18899, localhost:5173, vite|next dev', 'aria-label': t('rules.key'), readonly: !!r, dataset: { write: '1' } }) }),
      row({ label: t('rules.label'), control: h('input', { id: 'prLabel', class: 'ctl-text', value: rule.label ?? '', maxlength: 80, placeholder: t('rules.label.placeholder'), 'aria-label': t('rules.label'), dataset: { write: '1' } }) }),
      row({
        label: t('rules.onNew'),
        control: menuSelect({
          id: 'prOnNew', label: t('rules.onNew'), write: true, value: rule.onNew ?? '',
          options: [{ value: '', label: t('rules.unset') }, ...Object.entries(ON_NEW_TEXT).map(([value, label]) => ({ value, label }))],
        }),
      }),
      tri('pinned', t('rules.pinned'), rule.pinned),
      tri('hidden', t('rules.hidden'), rule.hidden)),
    h('div', { class: 'ac-actions' },
      button(t('rules.save'), () => submit(), { write: true }),
      r ? button(t('rules.cancel'), () => edit(null)) : null),
  );
}

function submit() {
  const key = $('prKey').value.trim();
  if (!key) return toast(t('rules.keyMissing'), true);
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
  if (!r.ok) return toast(t('rules.saveFailed', { error: errorText(r) }), true);
  toast(rule === null ? t('rules.removed', { key }) : r.body.where === 'ports' ? t('rules.savedPort', { key }) : t('rules.saved', { key }));
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
      view.problems?.length ? h('p', { class: 'set-ro' }, t('rules.problems', { list: view.problems.join(' · ') })) : null,
      view.rules.length
        ? h('ul', { class: 'set-list', 'aria-label': t('rules.list') }, view.rules.map(ruleRow))
        : h('p', { class: 'set-note', style: 'margin-top:0' }, t('rules.empty')),
      h('p', { class: 'set-note' },
        t('rules.order'),
        t('rules.order.defaults')),
      exact.length
        ? h('details', null,
          h('summary', { class: 'set-note' }, t('rules.exact', { n: exact.length })),
          h('ul', { class: 'set-howto' }, exact.map((x) => h('li', null, h('b', null, String(x.port)), ' ', [x.label && `“${x.label}”`, x.onNew && t('rules.sum.onNew', { what: ON_NEW_TEXT[x.onNew] })].filter(Boolean).join(' · ')))))
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
  if (!next) return body.replaceChildren(el('p', 'set-note', t('rules.loadFailed')));
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
