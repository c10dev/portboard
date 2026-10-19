// Down alerts (GET /api/alerts): the 🔔 header button and dialog, row/card bells, and rows for watched ports
// that are down (they are missing from /api/ports because nothing listens on them).
// Shared by the 서비스 tab (app.js), the 기기 tab (devices.js) and service.html.

import { errorText, post as write, tryJSON } from '../lib/api.js';
import { badge } from '../lib/badge.js';
import { modal } from '../lib/dialog.js';
import { $, el } from '../lib/dom.js';
import { locale, t, tn } from '../lib/i18n.js';
import { done } from '../lib/shell.js';
import { lasting as since } from '../lib/time.js';
import { toast } from '../lib/toast.js';
import { offerUndo, prefsUndo } from './undo.js';
import { uptimeLine } from './uptime.js';

/** Last GET /api/alerts */
let status = null;
let hooks = { render() {}, reload() {} };

export function alertStatus() {
  return status;
}

export async function refreshAlerts() {
  // the rest of the page works without it
  const next = await tryJSON('/api/alerts');
  // the 서비스 list waits for the watched-but-down rows once (shell.css [data-wait])
  if (!next) return done('alerts');
  status = next;
  paintButton();
  if ($('alertsDialog')?.open) paintDialog();
  hooks.render();
  done('alerts');
}

const DIALOG = `
<dialog id="alertsDialog" class="alerts-dlg">
  <header>
    <strong>${t('alerts.title')}</strong>
    <button type="button" id="alertsClose">${t('common.close')}</button>
  </header>
  <p id="alertsChannel" class="alerts-channel"></p>
  <h4>${t('alerts.watching')}</h4>
  <ul id="alertsList" class="alerts-list"></ul>
  <h4 id="alertsRecentH" hidden>${t('alerts.recent')}</h4>
  <ul id="alertsRecent" class="alerts-recent"></ul>
  <p class="alerts-help">${t('alerts.help')}</p>
  <footer><button type="button" id="alertsTest" data-write="1">${t('alerts.test')}</button></footer>
</dialog>`;

/** Wire the header button and dialog. render: repaint with the new status; reload: refetch the page's data after a toggle. */
export function initAlerts(h) {
  hooks = { ...hooks, ...h };
  const dialog = modal('alertsDialog', DIALOG, 'alertsClose');
  $('alertsBtn')?.addEventListener('click', () => {
    paintDialog();
    dialog.showModal();
    refreshAlerts();
  });
  $('alertsTest')?.addEventListener('click', sendTest);
  refreshAlerts();
  setInterval(() => { if (!document.hidden) refreshAlerts(); }, 15_000);
}

function watchOf(key) {
  return status?.watching.find((w) => w.key === key) ?? null;
}

function paintButton() {
  const btn = $('alertsBtn');
  if (!btn) return;
  const down = status.watching.filter((w) => w.down).length;
  const n = status.watching.length;
  $('alertsCount').textContent = down ? ` ${down}` : n ? ` ${n}` : '';
  btn.classList.toggle('alarm', down > 0);
  btn.classList.toggle('none', !status.channel.configured);
  btn.title = !status.channel.configured
    ? t('alerts.button.noChannel')
    : down ? t('alerts.button.down', { n: down }) : t('alerts.button.watching', { n });
}

function stateText(w) {
  if (w.down) return [`${t('alerts.state.down', { since: since(w.since) })}${w.alerted ? ` · ${t('alerts.state.alerted')}` : ''}`, 'bad'];
  if (w.quietUntil) return [t('alerts.state.quiet', { time: new Date(w.quietUntil).toLocaleTimeString(locale(),  { hour: '2-digit', minute: '2-digit' }) }), 'warn'];
  if (w.since) return [t('alerts.state.checking'), 'warn'];
  return [status.lastCheck ? t('alerts.state.ok') : t('alerts.state.pending'), 'ok'];
}

function paintDialog() {
  if (!status) return;
  const ch = status.channel;
  const chLine = $('alertsChannel');
  chLine.replaceChildren();
  chLine.className = `alerts-channel ${ch.configured ? 'ok' : 'bad'}`;
  if (ch.configured) {
    chLine.append(...tn('alerts.channel.on', { kinds: ch.kinds.join(' + ') }));
  } else {
    chLine.append(...tn('alerts.channel.off'));
  }
  $('alertsTest').disabled = !ch.configured;

  const list = $('alertsList');
  if (!status.watching.length) {
    list.replaceChildren(el('li', 'muted', t('alerts.none')));
  } else {
    list.replaceChildren(...status.watching.map((w) => {
      const li = el('li', 'alerts-item');
      const [text, tone] = stateText(w);
      li.append(el('span', `dot ${tone}`), el('span', 'alerts-port', w.kind === 'port' ? String(w.port) : t('alerts.device')),
        el('strong', null, w.name), el('span', `alerts-state ${tone}`, text));
      const off = el('button', 'alerts-off', t('alerts.off'));
      off.dataset.write = '1';
      off.type = 'button';
      off.title = t('alerts.off.title');
      off.addEventListener('click', () => (w.kind === 'port' ? setPortAlert(w.port, false) : setDeviceAlert(w.id, false)));
      li.append(off);
      return li;
    }));
  }

  const recent = $('alertsRecent');
  recent.replaceChildren(...status.recent.map((r) => {
    const li = el('li', r.ok ? '' : 'failed');
    li.append(el('time', null, new Date(r.t).toLocaleString(locale())), document.createTextNode(` ${r.title}${r.ok ? '' : ` (${t('alerts.sendFailed')})`}`));
    return li;
  }));
  $('alertsRecentH').hidden = !status.recent.length;
}

async function sendTest() {
  const b = $('alertsTest');
  b.disabled = true;
  try {
    const r = await write('/api/alerts/test');
    toast(r.body.message ?? errorText(r), !r.ok);
  } catch (err) {
    toast(err.message, true);
  } finally {
    b.disabled = false;
    refreshAlerts();
  }
}

/**
 * POST an alert toggle; undo: { key, text, prev } offers 되돌리기, which posts prev to the same url.
 * → the answer ({ ok, status, body }, as lib/api.js post; a network error is { ok: false, status: 0 })
 */
async function post(url, body, undo = null) {
  let r;
  try {
    r = await write(url, body);
    if (!r.ok) toast(errorText(r), true);
    else if (status && !status.channel.configured && (body.alert || body.on)) toast(t('alerts.onNoChannel'), true);
    else if (undo) offerUndo(undo.key, undo, async (prev) => (await post(url, prev)).ok);
  } catch (err) {
    toast(err.message, true);
    r = { ok: false, status: 0, body: { error: err.message } };
  }
  await refreshAlerts();
  hooks.reload();
  return r;
}

/** 🔔 on/off for a port; off (it was on: every off button is on a watched port) applies with 되돌리기 */
export const setPortAlert = (port, on) =>
  post(`/api/ports/${port}/prefs`, { alert: on }, on ? null : { key: port, ...prefsUndo({ port, alert: true }, { alert: false }) });
export const setDeviceAlert = (id, on) =>
  post(`/api/devices/${encodeURIComponent(id)}/alert`, { on }, on ? null : { key: `device:${id}`, text: t('alerts.deviceOff', { name: watchOf(`device:${id}`)?.name ?? t('alerts.device') }), prev: { on: true } });

/** 🔔 toggle for a port row (faint when off, like ☆) */
export function bell(on, label, toggle) {
  const b = el('button', `bell${on ? ' on' : ''}`, '🔔');
  b.dataset.write = '1';
  b.type = 'button';
  b.title = on ? t('alerts.bell.on', { label }) : t('alerts.bell.off', { label });
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(!on); });
  return b;
}

export function portBell(p) {
  return bell(p.alert, String(p.port), (on) => setPortAlert(p.port, on));
}

/** Badge for a listening row whose watch says down (HTTP not answering), or that is in a quiet window */
export function portAlertBadge(p) {
  const w = p.alert ? watchOf(`port:${p.port}`) : null;
  if (!w) return null;
  if (w.down) return badge(t('alerts.badge.down', { since: since(w.since) }), 'bad');
  if (w.quietUntil) return badge(t('alerts.badge.quiet'), 'warn');
  return null;
}

/** Recent-checks bar and 24 h / 7 d uptime for a watched port; null for ports without 🔔 */
export function portUptime(p) {
  const w = p.alert ? watchOf(`port:${p.port}`) : null;
  return w ? uptimeLine(w.uptime ?? null) : null;
}

/** Rows for watched ports that are not in the snapshot at all: nothing listens, so /api/ports doesn't know them. */
export function missingRows(ports, needle = '') {
  if (!status) return [];
  const known = new Set(ports.map((p) => p.port));
  return status.watching
    .filter((w) => w.kind === 'port' && !known.has(w.port))
    .filter((w) => !needle || `${w.port} ${w.name}`.toLowerCase().includes(needle))
    .map((w) => {
      const li = el('li', 'row missing');
      li.append(el('div', 'port', String(w.port)));
      const main = el('div', 'main');
      const nameLine = el('div', 'name-line');
      const name = el('a', 'name', w.name);
      name.href = `service.html#${w.port}`;
      name.title = t('inspector.title.port', { port: w.port });
      nameLine.append(name);
      const badges = el('div', 'badges');
      const [text, tone] = stateText(w);
      badges.append(badge(w.down || w.since ? t('ports.badge.notListening') : t('alerts.missing.checking'), 'warn'), badge(text, tone));
      main.append(nameLine, el('div', 'meta', t('alerts.missing.meta')), badges, uptimeLine(w.uptime ?? null));
      const actions = el('div', 'actions');
      const off = el('button', null, t('alerts.missing.off'));
      off.dataset.write = '1';
      off.type = 'button';
      off.addEventListener('click', () => setPortAlert(w.port, false));
      actions.append(off);
      li.append(main, actions);
      return li;
    });
}

/** Device card / detail toggle. compute-pool hosts and this server get none: cpool monitor already alerts on those. */
export function canWatchDevice(c) {
  return c.kind === 'tailnet' && !c.pool;
}

export function deviceWatched(id) {
  return !!watchOf(`device:${id}`);
}

export function deviceBell(c) {
  return bell(deviceWatched(c.id), c.name, (on) => setDeviceAlert(c.id, on));
}
