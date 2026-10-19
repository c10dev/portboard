// Down alerts (GET /api/alerts): the 🔔 header button and dialog, row/card bells, and rows for watched ports
// that are down (they are missing from /api/ports because nothing listens on them).
// Shared by the 서비스 tab (app.js), the 기기 tab (devices.js) and service.html.

import { errorText, post as write, tryJSON } from '../lib/api.js';
import { badge } from '../lib/badge.js';
import { modal } from '../lib/dialog.js';
import { $, el } from '../lib/dom.js';
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
    <strong>다운 알림</strong>
    <button type="button" id="alertsClose">닫기</button>
  </header>
  <p id="alertsChannel" class="alerts-channel"></p>
  <h4>감시 중</h4>
  <ul id="alertsList" class="alerts-list"></ul>
  <h4 id="alertsRecentH" hidden>최근 보낸 알림</h4>
  <ul id="alertsRecent" class="alerts-recent"></ul>
  <p class="alerts-help">30초마다 확인해요. 두 번 연속 리스닝이 없거나 (HTTP 포트는) 응답이 없으면 한 번 알리고, 다시 살아나면 얼마나 꺼져 있었는지 알려요. 같은 포트는 10분에 한 번까지만 보내요. Portboard에서 재시작·중지한 포트는 2분 동안 알리지 않아요. compute-pool 호스트는 compute-pool이 직접 알려요.</p>
  <footer><button type="button" id="alertsTest" data-write="1">테스트 알림 보내기</button></footer>
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
    ? '다운 알림 · 알림 채널 없음'
    : down ? `다운 알림 · ${down}개 응답 없음` : `다운 알림 · ${n}개 감시 중`;
}

function stateText(w) {
  if (w.down) return [`응답 없음 · ${since(w.since)}${w.alerted ? ' · 알림 보냄' : ''}`, 'bad'];
  if (w.quietUntil) return [`Portboard가 재시작·중지 · ${new Date(w.quietUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}까지 알림 멈춤`, 'warn'];
  if (w.since) return ['확인 중 (한 번 응답 없음)', 'warn'];
  return [status.lastCheck ? '정상' : '첫 확인 전', 'ok'];
}

function paintDialog() {
  if (!status) return;
  const ch = status.channel;
  const chLine = $('alertsChannel');
  chLine.replaceChildren();
  chLine.className = `alerts-channel ${ch.configured ? 'ok' : 'bad'}`;
  if (ch.configured) {
    chLine.append(el('strong', null, 'compute-pool 알림 채널'), document.createTextNode(` (${ch.kinds.join(' + ')})로 보내요.`));
  } else {
    chLine.append(el('strong', null, '알림 채널 없음'),
      document.createTextNode(' — compute-pool의 ~/.local/state/compute-pool/alerts.json에 ntfy topic이나 webhook이 있어야 해요. 그 전에는 아무것도 보내지 않아요.'));
  }
  $('alertsTest').disabled = !ch.configured;

  const list = $('alertsList');
  if (!status.watching.length) {
    list.replaceChildren(el('li', 'muted', '아직 고른 게 없어요. 포트 줄의 🔔이나 ⋯ → 다운 알림 켜기, 기기 탭의 기기 상세에서 고르세요.'));
  } else {
    list.replaceChildren(...status.watching.map((w) => {
      const li = el('li', 'alerts-item');
      const [text, tone] = stateText(w);
      li.append(el('span', `dot ${tone}`), el('span', 'alerts-port', w.kind === 'port' ? String(w.port) : '기기'),
        el('strong', null, w.name), el('span', `alerts-state ${tone}`, text));
      const off = el('button', 'alerts-off', '끄기');
      off.dataset.write = '1';
      off.type = 'button';
      off.title = '이 알림 끄기';
      off.addEventListener('click', () => (w.kind === 'port' ? setPortAlert(w.port, false) : setDeviceAlert(w.id, false)));
      li.append(off);
      return li;
    }));
  }

  const recent = $('alertsRecent');
  recent.replaceChildren(...status.recent.map((r) => {
    const li = el('li', r.ok ? '' : 'failed');
    li.append(el('time', null, new Date(r.t).toLocaleString()), document.createTextNode(` ${r.title}${r.ok ? '' : ' (보내기 실패)'}`));
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
    else if (status && !status.channel.configured && (body.alert || body.on)) toast('켜 두었어요. 다만 알림 채널 없음이라 아직 보내지 않아요.', true);
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
  post(`/api/devices/${encodeURIComponent(id)}/alert`, { on }, on ? null : { key: `device:${id}`, text: `${watchOf(`device:${id}`)?.name ?? '기기'} 다운 알림을 껐어요`, prev: { on: true } });

/** 🔔 toggle for a port row (faint when off, like ☆) */
export function bell(on, label, toggle) {
  const b = el('button', `bell${on ? ' on' : ''}`, '🔔');
  b.dataset.write = '1';
  b.type = 'button';
  b.title = on ? `${label}: 다운 알림 켜짐 (누르면 끄기)` : `${label}: 다운되면 알림 받기`;
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
  if (w.down) return badge(`응답 없음 ${since(w.since)}`, 'bad');
  if (w.quietUntil) return badge('알림 2분 멈춤', 'warn');
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
      name.title = `${w.port} 상세`;
      nameLine.append(name);
      const badges = el('div', 'badges');
      const [text, tone] = stateText(w);
      badges.append(badge(w.down || w.since ? '리스닝 없음' : '리스닝 없음 · 확인 중', 'warn'), badge(text, tone));
      main.append(nameLine, el('div', 'meta', '다운 알림을 켠 포트예요. 다시 리스닝하면 원래 줄로 돌아와요.'), badges, uptimeLine(w.uptime ?? null));
      const actions = el('div', 'actions');
      const off = el('button', null, '알림 끄기');
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
