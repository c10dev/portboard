// 설정 tab · 시작하기: the setup checklist (GET /api/onboarding, src/core/onboarding.ts) — what is left first, each with
// its next step (a command to copy, or a link), then what is done. The 서비스 tab's "설정 n/m" chip links here.

import { tryJSON } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { copy } from '../lib/toast.js';

const TONE = { ok: 'ok', warn: 'warn', missing: 'todo' };
const LABEL = { ok: 'start.status.ok', warn: 'start.status.warn', missing: 'start.status.missing' };

/** A dashboard page (settings.html#remote) opens here; a doc in a new tab. */
const linkTo = (label, href) => (/^https?:/.test(href) ? extLink(`${label} ↗`, href) : h('a', { href }, `${label} →`));

function action(a) {
  if (!a) return null;
  if (a.kind === 'link') return linkTo(a.label, a.href);
  return h('span', { class: 'set-row' }, a.label ? h('span', null, `${a.label}:`) : null, h('code', { class: 'set-cmd' }, a.text), button(t('start.copy'), () => copy(a.text), { title: t('start.copy.title') }));
}

function row(i) {
  return h(
    'li',
    { dataset: { key: i.key } },
    el('span', `dot ${TONE[i.status]}`),
    h('strong', null, i.title),
    h('span', { class: `set-state ${TONE[i.status]}` }, t(LABEL[i.status])),
    h('p', { class: 'set-detail' }, i.detail),
    i.action || i.links?.length ? h('div', { class: 'set-extra' }, action(i.action), (i.links ?? []).map((l) => linkTo(l.label, l.href))) : null,
  );
}

async function refresh() {
  const box = $('startBody');
  if (!box) return;
  const list = await tryJSON('/api/onboarding');
  if (!list) {
    box.replaceChildren(el('p', 'set-note', t('start.loadFailed')));
    return;
  }
  const todo = list.items.filter((i) => i.status !== 'ok');
  const done = list.items.filter((i) => i.status === 'ok');
  // replaceChildren() would print a null as text: leave the empty parts out
  box.replaceChildren(
    ...[
      h('p', { class: 'set-note' }, todo.length ? t('start.progress', { total: list.total, ok: list.ok, left: todo.length }) : t('start.allDone', { n: list.total })),
      todo.length ? h('ul', { class: 'set-list', 'aria-label': t('start.todo') }, todo.map(row)) : null,
      done.length ? h('details', { open: !todo.length }, h('summary', { class: 'set-note' }, t('start.doneCount', { n: done.length })), h('ul', { class: 'set-list', 'aria-label': t('start.done') }, done.map(row))) : null,
      h('p', { class: 'set-note' }, t('start.note')),
    ].filter(Boolean),
  );
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('startBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
