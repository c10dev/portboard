// Self-watch (GET /api/health?detail): a small header chip "수집 정상" / "2개 실패" and a dialog with each collector's
// state and the credentials that can expire. Self-contained: a page only loads this script; the chip goes in the shell's
// sidebar footer (lib/shell.js #shellFoot), or a header .controls on a page without the shell.

import { tryJSON } from '../lib/api.js';
import { modal } from '../lib/dialog.js';
import { $, el, extLink } from '../lib/dom.js';
import { locale, t } from '../lib/i18n.js';
import { ago as agoText, lasting as lastingText } from '../lib/time.js';

let status = null;

const DIALOG = `
<dialog id="swDialog" class="alerts-dlg sw-dlg">
  <header>
    <strong>${t('selfwatch.title')}</strong>
    <button type="button" id="swClose">${t('common.close')}</button>
  </header>
  <h4>${t('selfwatch.collectors')}</h4>
  <ul id="swList" class="alerts-list"></ul>
  <p id="swMemory" class="alerts-help" hidden></p>
  <h4>${t('selfwatch.expiryHead')}</h4>
  <ul id="swExpiry" class="alerts-list"></ul>
  <p id="swHelp" class="alerts-help"></p>
</dialog>`;

const ago = (iso) => agoText(iso, { suffix: true, floor: true });
const lasting = (iso) => lastingText(iso, t('selfwatch.sinceJustNow'));

/** "실패 5분째" (failing for 5m) */
const failing = (c) => (c.failingSince ? t('selfwatch.failingFor', { for: lasting(c.failingSince) }) : t('selfwatch.failing'));

function collectorText(c) {
  const err = c.lastError ? ` · ${c.lastError}` : '';
  switch (c.view) {
    case 'ok': return [c.lastOk ? t('selfwatch.okAt', { ago: ago(c.lastOk) }) : t('selfwatch.ok'), 'ok'];
    case 'down': return [`${failing(c)}${c.alerted ? ` · ${t('selfwatch.alerted')}` : ''}${err}`, 'bad'];
    case 'failing': return [`${failing(c)}${err}`, 'warn'];
    case 'setup': return [`${t('selfwatch.setup')}${err}`, 'muted'];
    case 'off': return [`${t('selfwatch.off')}${err}`, 'muted'];
    default: return [t('selfwatch.firstCheck'), 'muted'];
  }
}

function expiryText(i) {
  const left = i.expiresAt ? Math.round((Date.parse(i.expiresAt) - Date.now()) / 86400000) : null;
  const note = i.note ? ` · ${i.note}` : '';
  switch (i.status) {
    case 'never': return [`${t('selfwatch.never')}${note}`, 'ok'];
    case 'ok': return [`${t('selfwatch.left', { n: left, date: new Date(i.expiresAt).toLocaleDateString(locale()) })}${note}`, 'ok'];
    case 'soon': return [`${t('selfwatch.soon', { n: Math.max(0, left) })}${note}`, 'warn'];
    case 'expired': return [`${t('selfwatch.expired')}${note}`, 'bad'];
    default: return [`${t('selfwatch.unknown')}${note}`, 'muted'];
  }
}

function paintChip() {
  const b = $('swChip');
  if (!b || !status) return;
  const bad = status.failing > 0;
  const soon = status.expiry.items.filter((i) => i.status === 'soon' || i.status === 'expired').length;
  // memory pressure (features/memory.ts): a warn tone, below a failing collector
  const mem = status.memory?.pressure ? status.memory : null;
  b.hidden = false;
  b.classList.toggle('alarm', bad);
  b.classList.toggle('warn', !bad && (soon > 0 || !!mem));
  $('swText').textContent = bad ? status.summary : mem ? t('selfwatch.chip.lowMem') : soon ? t('selfwatch.chip.expiring', { n: soon }) : status.summary;
  b.title = bad
    ? t('selfwatch.chip.failTitle', { labels: status.collectors.filter((c) => c.view === 'failing' || c.view === 'down').map((c) => c.label).join(', ') })
    : mem ? t('selfwatch.chip.memTitle', { reasons: mem.reasons.join(', '), avail: mem.availablePct, swap: mem.swapPct })
    : t('selfwatch.chip.okTitle');
}

function paintDialog() {
  if (!status) return;
  $('swList').replaceChildren(...status.collectors.map((c) => {
    const li = el('li', 'alerts-item');
    const [text, tone] = collectorText(c);
    li.append(el('span', `dot ${tone}`), el('strong', null, c.label), el('span', `alerts-state ${tone}`, text));
    return li;
  }));
  const mem = status.memory;
  const memLine = $('swMemory');
  memLine.hidden = !mem?.pressure;
  if (mem?.pressure) memLine.replaceChildren(t('selfwatch.memLine', { reasons: mem.reasons.join(', '), avail: mem.availablePct, swap: mem.swapPct }), Object.assign(el('a', 'sw-runbook', t('selfwatch.memLink')), { href: 'devices.html#memory' }));
  if (!status.collectors.length) $('swList').replaceChildren(el('li', 'muted', t('selfwatch.noCollectors')));
  const items = status.expiry.items;
  $('swExpiry').replaceChildren(...(items.length ? items : [null]).map((i) => {
    if (!i) return el('li', 'muted', status.expiry.checkedAt ? t('selfwatch.noTokens') : t('selfwatch.notChecked'));
    const li = el('li', 'alerts-item');
    const [text, tone] = expiryText(i);
    li.append(el('span', `dot ${tone}`), el('strong', null, i.name), el('span', `alerts-state ${tone}`, text));
    if (i.runbook) li.append(extLink(t('selfwatch.runbook'), i.runbook, 'sw-runbook'));
    return li;
  }));
  $('swHelp').textContent = t('selfwatch.help', { every: status.checkEverySec / 60, threshold: status.thresholdMin });
}

async function refresh() {
  // the page works without it
  const next = await tryJSON('/api/health?detail');
  if (!next) return;
  status = next;
  paintChip();
  if ($('swDialog')?.open) paintDialog();
}

function init() {
  // the shell's sidebar footer carries the chip already (src/core/shell.ts); a page without the shell gets one
  let b = $('swChip');
  if (!b) {
    const controls = $('shellFoot') ?? document.querySelector('header.top .controls');
    if (!controls) return;
    b = el('button', 'sw-chip');
    b.id = 'swChip';
    b.type = 'button';
    b.hidden = true;
    b.setAttribute('aria-label', t('selfwatch.title'));
    b.append(el('span', 'sw-dot'), el('span', 'sw-text'));
    b.lastElementChild.id = 'swText';
    if (controls.id === 'shellFoot') controls.insertBefore(b, $('obChip')?.nextSibling ?? controls.firstChild);
    else controls.insertBefore(b, $('alertsBtn') ?? controls.lastElementChild);
  }
  const dialog = modal('swDialog', DIALOG, 'swClose');
  b.addEventListener('click', () => {
    paintDialog();
    dialog.showModal();
    refresh();
  });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
}

init();
