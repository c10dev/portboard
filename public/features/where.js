// "어디서 돌릴까" (where to run): a dialog that asks GET /api/where-to-run?task=… (src/features/machines.ts) and
// shows the recommended machine, why, its caveats, how to open the session there, the alternatives and the machines
// left out. Opened from the 기기 tab's machine strip (features/machines.js) and the command palette. It never starts
// anything: the person opens the session.

import { readJSON } from '../lib/api.js';
import { modal } from '../lib/dialog.js';
import { $, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const DIALOG = `
<dialog id="whereDlg" class="alerts-dlg where-dlg">
  <header>
    <strong>${t('where.title')}</strong>
    <button type="button" id="whereClose">${t('common.close')}</button>
  </header>
  <form id="whereForm" class="where-form">
    <input id="whereTask" type="search" maxlength="500" autocomplete="off" placeholder="${t('where.placeholder')}">
    <button type="submit" class="btn primary">${t('where.ask')}</button>
  </form>
  <div id="whereOut" class="where-out" aria-live="polite"></div>
  <p class="alerts-help">${t('where.note')}</p>
</dialog>`;

/** how.via → what the person opens */
export const VIA = {
  local: t('where.via.local'),
  'desktop-ssh': t('where.via.desktopSsh'),
  'remote-control': t('where.via.remoteControl'),
  cloud: t('where.via.cloud'),
  teleport: t('where.via.teleport'),
};

const list = (items, cls) => (items?.length ? h('ul', { class: cls }, items.map((x) => h('li', {}, x))) : null);

/** The answer as DOM: recommendation first, then the alternatives and the excluded machines. Exported for the tests. */
export function answerView(a) {
  const out = [];
  if (a.repo) out.push(el('p', 'muted', t('where.repoFromTask', { repo: a.repo })));
  const r = a.recommendation;
  if (!r) out.push(el('p', 'where-none', t('where.none')));
  else {
    out.push(h('div', { class: 'where-rec' },
      h('div', { class: 'where-head' }, h('strong', { text: r.machine }), h('span', { class: 'muted', text: t('where.score', { score: r.score }) })),
      list(r.why, 'where-why'),
      list(r.caveats.map((c) => `⚠ ${c}`), 'where-caveats'),
      h('div', { class: 'where-how' },
        h('div', {}, h('span', { class: 'muted', text: t('where.how') }), ' ', VIA[r.how.via] ?? r.how.via),
        r.how.cwd ? h('code', { text: r.how.cwd }) : null,
        list(r.how.steps, 'where-steps'))));
  }
  if (a.alternatives?.length) {
    out.push(el('h4', null, t('where.alternatives')));
    out.push(list(a.alternatives.map((x) => `${x.machine} (${x.score})${x.caveats.length ? ` · ${x.caveats.join(' · ')}` : ''}`), 'where-alt'));
  }
  if (a.excluded?.length) {
    out.push(el('h4', null, t('where.excluded')));
    out.push(list(a.excluded.map((x) => `${x.machine}: ${x.reason}`), 'where-ex'));
  }
  return out.filter(Boolean);
}

async function ask(task) {
  const out = $('whereOut');
  out.replaceChildren(el('p', 'muted', t('where.asking')));
  try {
    const a = await readJSON(`/api/where-to-run?task=${encodeURIComponent(task)}`);
    out.replaceChildren(...answerView(a));
  } catch (err) {
    out.replaceChildren(el('p', 'error', t('where.failed', { error: err.message ?? String(err) })));
  }
}

/** Open the dialog; with a task, ask at once */
export function openWhere(task = '') {
  const d = modal('whereDlg', DIALOG, 'whereClose');
  const form = $('whereForm');
  if (!form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('whereTask').value.trim();
      if (v) ask(v);
    });
  }
  $('whereTask').value = task;
  if (!d.open) d.showModal();
  $('whereTask').focus();
  if (task) ask(task);
}
