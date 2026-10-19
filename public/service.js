// service.html#<port>: one service in full (GET /api/ports/:port/detail). Same actions and guards as the 서비스 rows:
// the server decides what restart/stop act on, POSTs carry X-Portboard: 1, restart and stop ask first.

import { done, shell } from './lib/shell.js';
import { bell, initAlerts, setPortAlert } from './features/alerts.js';
import { controlText, logsDialog, portAction, reachButtons, restartQuestion, stopQuestion } from './features/control.js';
import { initCommandPalette } from './features/palette.js';
import { pctText, slotBar, uptimeLine } from './features/uptime.js';
import { badge, deviceHref, USER_KIND, userChip, usingChip } from './lib/badge.js';
import { $, button, el, extLink } from './lib/dom.js';
import { showProfile } from './lib/profile.js';
import { showAccess } from './lib/access.js';
import { tryJSON } from './lib/api.js';
import { isSettingsHash } from './lib/settings-route.js';
import { auditRow } from './lib/audit.js';
import { locale, t } from './lib/i18n.js';
import { ago as agoText, hoursMinutes as minutes, isJustNow, when } from './lib/time.js';

let port = null;
let d = null;
let busy = false;
const logs = logsDialog();

const ago = (iso) => agoText(iso, { suffix: true });

function portFromHash() {
  const n = Number(location.hash.replace(/^#/, ''));
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

async function load(fresh = false) {
  port = portFromHash();
  if (port === null) {
    setStatus(t('service.status.noPort'), true);
    return;
  }
  try {
    if (fresh) await fetch('/api/ports?fresh').catch(() => {});
    const res = await fetch(`/api/ports/${port}/detail`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      d = null;
      render404();
      return;
    }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    d = body;
    render();
    setStatus(t('service.status.asOf', { time: new Date(d.at).toLocaleTimeString(locale()) }));
    // service.html?logs#<port>: the palette's 로그 from a page without the logs dialog
    if (new URLSearchParams(location.search).has('logs')) {
      history.replaceState(null, '', `service.html#${port}`);
      if (d.entry?.control) logs.show({ port: d.port, name: d.name });
    }
  } catch (err) {
    setStatus(t('service.status.loadFailed', { error: err.message }), true);
  } finally {
    // shown or failed: the main column may show (shell.css [data-wait])
    done('page');
  }
}

function setStatus(text, error = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function render404() {
  document.title = `${port} · Portboard`;
  $('port').textContent = port;
  $('name').textContent = t('service.unknown');
  $('sub').textContent = t('service.unknown.sub');
  for (const id of ['badges', 'actions', 'bell', 'what', 'now', 'uptime', 'used', 'events']) $(id).replaceChildren();
  setStatus('');
  void renderAudit();
}

function render() {
  const e = d.entry;
  document.title = `${d.port} ${d.name} · Portboard`;
  shell()?.setContext(el('span', null, `${d.port} ${d.name}`));
  $('port').textContent = d.port;
  $('name').textContent = d.name;
  $('bell').replaceChildren(bell(!!e?.alert || d.watched, String(d.port), (on) => setPortAlert(d.port, on)));

  const proc = e?.processes[0];
  $('sub').textContent = e
    ? [e.label ? e.detectedName : null, e.group ? `${e.group.name}${e.role ? ` · ${e.role}` : ''}` : null, proc?.project, controlText(e.control)].filter(Boolean).join(' · ')
    : t('service.sub.none');

  const b = $('badges');
  b.replaceChildren();
  if (!d.listening) b.append(badge(t('service.notListening'), 'warn'));
  if (e?.served) b.append(badge('tailnet HTTPS', 'ok'));
  if (d.listening && e.scope === 'loopback') b.append(badge(e.served ? 'local' : 'local only', e.served ? '' : 'warn'));
  else if (e?.scope === 'all') b.append(badge(t('service.scope.all'), 'info'));
  else if (e?.scope === 'tailnet') b.append(badge('tailnet', 'info'));
  if (e?.probe?.http) b.append(badge(`HTTP ${e.probe.status}`));
  if (d.watch?.down) b.append(badge(t('service.badge.down'), 'bad'));
  else if (d.watch?.quietUntil) b.append(badge(t('service.badge.quiet'), 'warn'));
  if (e?.pinned) b.append(badge(t('service.badge.pinned')));
  if (e?.hidden) b.append(badge(t('service.badge.hidden')));

  $('actions').replaceChildren(...actions(e));
  renderWhat(e);
  renderNow();
  renderUptime();
  renderUsed();
  renderEvents();
  void renderAudit();
}

// ---- actions (the 서비스 rows' ones, features/control.js) ----

function actions(e) {
  if (!e?.listening) {
    return d.watched ? [button(t('service.alertOff'), () => setPortAlert(d.port, false), { write: true })] : [];
  }
  const out = reachButtons(e, { busy, act });
  if (e.control) out.push(button(t('service.logs'), () => logs.show(d)));
  if (e.canRestart) out.push(button(t('service.restart'), () => confirmAct('restart', restartQuestion(e)), { disabled: busy, write: true }));
  if (e.canStop) out.push(button(t('service.stop'), () => confirmAct('stop', stopQuestion(e)), { disabled: busy, danger: true, write: true }));
  return out;
}

function confirmAct(kind, question) {
  if (window.confirm(question)) act(kind);
}

async function act(kind) {
  busy = true;
  render();
  try {
    await portAction(d.port, kind, () => d.watched);
  } finally {
    busy = false;
    await load(true);
  }
}

// ---- sections ----

function renderWhat(e) {
  const dl = $('what');
  dl.replaceChildren();
  if (!e) {
    dl.append(el('dt', null, t('service.what.status')), el('dd', null, t('service.what.none')));
    return;
  }
  const scope = { loopback: t('service.scope.loopback'), all: t('service.scope.all'), tailnet: t('service.scope.tailnet'), other: e.addresses.join(', ') }[e.scope] ?? '—';
  const groupLinks = e.group
    ? (() => {
        const span = el('span');
        span.append(document.createTextNode(`${e.group.name} · `));
        e.group.ports.forEach((p, i) => {
          if (i) span.append(document.createTextNode(' · '));
          if (p === e.port) span.append(el('strong', null, String(p)));
          else {
            const a = el('a', null, String(p));
            a.href = `service.html#${p}`;
            span.append(a);
          }
        });
        return span;
      })()
    : null;
  const url = (u) => (!u ? null : u.startsWith('http') ? extLink(u, u) : u);
  const facts = [
    [t('service.what.name'), e.label ? t('service.what.labelAuto', { label: e.label, detected: e.detectedName }) : e.name],
    [t('service.what.group'), groupLinks],
    [t('service.what.control'), controlText(e.control)],
    ['systemd', e.processes.map((p) => p.unit && `${p.unit}${p.unitDescription ? ` — ${p.unitDescription}` : ''}`).filter(Boolean).join(', ')],
    [t('service.what.container'), e.container],
    ['compose', e.composeProject],
    [t('service.what.scope'), scope],
    [t('service.what.addresses'), e.addresses.join(', '), true],
    [t('service.what.directUrl'), url(e.urls.direct)],
    ['Tailnet URL', url(e.urls.served)],
    [t('service.what.title'), e.probe?.title],
    ...e.processes.flatMap((p) => [['PID', p.pid], [t('service.what.cmd'), p.cmdline, true], [t('service.what.path'), p.cwd, true]]),
    ['SSH', e.scope === 'loopback' && !e.served ? e.urls.ssh : null, true],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  for (const [k, v, mono] of facts) {
    const dd = el('dd', mono ? 'mono' : '');
    if (v instanceof Node) dd.append(v);
    else dd.textContent = String(v);
    dl.append(el('dt', null, k), dd);
  }
}

function renderNow() {
  const box = $('now');
  if (!d.usingNow.length) {
    box.replaceChildren(el('p', 'muted', d.listening ? t('service.now.empty') : t('service.now.notListening')));
    return;
  }
  const ul = el('ul', 'who');
  for (const u of d.usingNow) {
    const li = el('li');
    li.append(usingChip(u), el('span', 'muted', !u.since ? '' : isJustNow(u.since) ? t('service.now.sinceJust', { since: when(u.since) }) : t('service.now.since', { for: agoText(u.since), since: when(u.since) })));
    ul.append(li);
  }
  box.replaceChildren(ul);
}

function renderUptime() {
  const box = $('uptime');
  const u = d.uptime;
  if (!d.watched && !u) {
    const p = el('p', 'muted', t('service.up.off'));
    box.replaceChildren(p, button(t('service.up.turnOn'), () => setPortAlert(d.port, true), { write: true }));
    return;
  }
  if (!u) {
    box.replaceChildren(el('p', 'muted', t('service.up.none')));
    return;
  }
  const tiles = el('div', 'tiles');
  for (const [label, pct] of [[t('service.period.24h'), u.pct24h], [t('service.period.7d'), u.pct7d], [t('service.period.30d'), u.pct30d]]) {
    const t = el('div', `tile${pct !== null && pct < 99 ? ' low' : ''}`);
    t.append(el('span', 'tile-v', pctText(pct)), el('span', 'tile-k', label));
    tiles.append(t);
  }
  const hour = (x) => x.toLocaleTimeString(locale(),  { hour: '2-digit', minute: '2-digit' });
  const day = (x) => x.toLocaleDateString(locale(),  { month: 'numeric', day: 'numeric' });
  const rows = el('div', 'bars');
  const barRow = (label, node, note) => {
    const r = el('div', 'bar-row');
    r.append(el('span', 'bar-k', label), node, el('span', 'bar-note', note));
    rows.append(r);
  };
  barRow(t('service.up.recent'), uptimeLine(u).querySelector('.ubar'), t('service.up.recentNote'));
  barRow(t('service.period.24h'), slotBar(u.day, hour, 'wide'), t('service.up.dayNote'));
  barRow(t('service.period.30d'), slotBar(u.month, day, 'wide'), t('service.up.monthNote'));
  const note = el('p', 'muted small', t('service.up.note', { since: when(u.since), last: ago(u.lastCheck) }));

  const out = el('div', 'outages');
  out.append(el('h4', null, t('service.outages')));
  if (!u.outages.length) out.append(el('p', 'muted', t('service.outages.none')));
  else {
    const ul = el('ul', 'outage-list');
    for (const o of u.outages) {
      const li = el('li', o.to ? '' : 'open');
      li.append(
        el('span', 'o-when', `${when(o.from)} – ${o.to ? when(o.to).replace(/^.*? (?=\d{1,2}:)/, '') : t('service.outages.now')}`),
        el('span', 'o-len', o.to ? minutes(o.minutes) : t('service.outages.ongoing', { t: minutes(o.minutes) })),
        el('span', 'muted', o.reason === 'http' ? t('service.outages.http') : t('service.notListening')),
      );
      ul.append(li);
    }
    out.append(ul);
  }
  box.replaceChildren(tiles, rows, note, out);
}

function renderUsed() {
  const box = $('used');
  if (!d.lastUsed.length) {
    box.replaceChildren(el('p', 'muted', d.historySince ? t('service.used.noneSince', { since: when(d.historySince) }) : t('service.used.none')));
    return;
  }
  const table = el('table', 'used');
  const head = el('tr');
  for (const h of [t('service.used.device'), t('service.used.last'), t('service.period.7d'), t('service.period.30d'), t('service.used.first')]) head.append(el('th', null, h));
  table.append(el('thead'));
  table.tHead.append(head);
  const body = el('tbody');
  const live = new Set(d.usingNow.map((u) => u.id));
  for (const r of d.lastUsed) {
    const tr = el('tr');
    const name = el('td', 'dev');
    name.append(userChip(r.name, r.kind, deviceHref(r.device === 'local' ? null : r.device.replace(/~routed$/, '')), r.kind === 'routed' ? USER_KIND.routed : undefined));
    const last = el('td', null, live.has(r.device) ? t('service.used.now') : ago(r.lastSeen));
    last.title = new Date(r.lastSeen).toLocaleString(locale());
    if (live.has(r.device)) last.className = 'live';
    tr.append(name, last, el('td', 'num', minutes(r.minutes7d)), el('td', 'num', minutes(r.minutes30d)), el('td', 'muted', when(r.firstSeen)));
    body.append(tr);
  }
  table.append(body);
  const note = el('p', 'muted small', d.historySince ? t('service.used.noteSince', { since: when(d.historySince) }) : t('service.used.note'));
  box.replaceChildren(table, note);
}

function renderEvents() {
  const ul = $('events');
  if (!d.events.length) {
    ul.replaceChildren(el('li', 'muted', d.watched ? t('service.events.none') : t('service.events.off')));
    return;
  }
  ul.replaceChildren(...d.events.map((x) => {
    const li = el('li', x.ok ? x.kind : `${x.kind} failed`);
    li.append(el('time', null, when(x.t)), el('span', null, x.title), x.ok ? '' : el('span', 'muted', ` (${t('service.events.sendFailed')})`));
    return li;
  }));
}

// 기록 (#30): who restarted, stopped, exposed or changed this port, from where, and whether it was allowed.
async function renderAudit() {
  const at = port;
  const doc = await tryJSON(`/api/audit?port=${at}&limit=20`);
  if (at !== port) return;
  const ul = $('audit');
  if (!doc) {
    ul.replaceChildren(el('li', 'muted', t('audit.loadFailed')));
    return;
  }
  if (!doc.entries.length) {
    ul.replaceChildren(el('li', 'muted', t('service.audit.empty')));
    return;
  }
  ul.replaceChildren(...doc.entries.map((e) => auditRow(e, { port: false })));
}

$('refresh').addEventListener('click', () => load(true));
// #settings/… is the 설정 modal over this page (features/settings-modal.js), not another port
window.addEventListener('hashchange', () => { if (isSettingsHash(location.hash)) return; window.scrollTo(0, 0); load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden && !logs.open) load(); }, 10_000);

initAlerts({ reload: () => load(true) });
initCommandPalette({ refresh: () => load(true), openLogs: (p) => logs.show(p) });
void showProfile();
void showAccess();
load();
