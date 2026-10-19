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
import { ago as agoText, hoursMinutes as minutes, when } from './lib/time.js';

let port = null;
let d = null;
let busy = false;
const logs = logsDialog();

const ago = (iso) => agoText(iso, { suffix: ' 전' });

function portFromHash() {
  const n = Number(location.hash.replace(/^#/, ''));
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

async function load(fresh = false) {
  port = portFromHash();
  if (port === null) {
    setStatus('주소 끝에 #포트번호 가 필요해요 (예: service.html#8790).', true);
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
    setStatus(`${new Date(d.at).toLocaleTimeString()} 기준`);
    // service.html?logs#<port>: the palette's 로그 from a page without the logs dialog
    if (new URLSearchParams(location.search).has('logs')) {
      history.replaceState(null, '', `service.html#${port}`);
      if (d.entry?.control) logs.show({ port: d.port, name: d.name });
    }
  } catch (err) {
    setStatus(`불러오기 실패: ${err.message}`, true);
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
  $('name').textContent = '알 수 없는 포트';
  $('sub').textContent = '리스닝하지 않고, 다운 알림도 없고, 사용 기록도 없어요.';
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
    : '지금 리스닝하는 프로세스가 없어요.';

  const b = $('badges');
  b.replaceChildren();
  if (!d.listening) b.append(badge('리스닝 없음', 'warn'));
  if (e?.served) b.append(badge('tailnet HTTPS', 'ok'));
  if (d.listening && e.scope === 'loopback') b.append(badge(e.served ? 'local' : 'local only', e.served ? '' : 'warn'));
  else if (e?.scope === 'all') b.append(badge('모든 인터페이스', 'info'));
  else if (e?.scope === 'tailnet') b.append(badge('tailnet', 'info'));
  if (e?.probe?.http) b.append(badge(`HTTP ${e.probe.status}`));
  if (d.watch?.down) b.append(badge('응답 없음', 'bad'));
  else if (d.watch?.quietUntil) b.append(badge('알림 2분 멈춤', 'warn'));
  if (e?.pinned) b.append(badge('★ 고정'));
  if (e?.hidden) b.append(badge('숨김'));

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
    return d.watched ? [button('🔔 알림 끄기', () => setPortAlert(d.port, false), { write: true })] : [];
  }
  const out = reachButtons(e, { busy, act });
  if (e.control) out.push(button('로그 보기', () => logs.show(d)));
  if (e.canRestart) out.push(button('재시작', () => confirmAct('restart', restartQuestion(e)), { disabled: busy, write: true }));
  if (e.canStop) out.push(button('중지', () => confirmAct('stop', stopQuestion(e)), { disabled: busy, danger: true, write: true }));
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
    dl.append(el('dt', null, '상태'), el('dd', null, '리스닝 없음. 다시 리스닝하면 여기에 주인과 주소가 나와요.'));
    return;
  }
  const scope = { loopback: '이 서버 안에서만 (127.0.0.1)', all: '모든 인터페이스', tailnet: 'tailnet 주소만', other: e.addresses.join(', ') }[e.scope] ?? '—';
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
    ['이름', e.label ? `${e.label} (자동: ${e.detectedName})` : e.name],
    ['묶음', groupLinks],
    ['제어', controlText(e.control)],
    ['systemd', e.processes.map((p) => p.unit && `${p.unit}${p.unitDescription ? ` — ${p.unitDescription}` : ''}`).filter(Boolean).join(', ')],
    ['컨테이너', e.container],
    ['compose', e.composeProject],
    ['범위', scope],
    ['주소', e.addresses.join(', ')],
    ['직접 URL', url(e.urls.direct)],
    ['Tailnet URL', url(e.urls.served)],
    ['페이지 제목', e.probe?.title],
    ...e.processes.flatMap((p) => [['PID', p.pid], ['명령', p.cmdline], ['경로', p.cwd]]),
    ['SSH', e.scope === 'loopback' && !e.served ? e.urls.ssh : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  for (const [k, v] of facts) {
    const dd = el('dd', k === '명령' || k === '경로' || k === 'SSH' || k === '주소' ? 'mono' : '');
    if (v instanceof Node) dd.append(v);
    else dd.textContent = String(v);
    dl.append(el('dt', null, k), dd);
  }
}

function renderNow() {
  const box = $('now');
  if (!d.usingNow.length) {
    box.replaceChildren(el('p', 'muted', d.listening ? '지금 연결된 기기가 없어요.' : '리스닝하지 않아서 아무도 못 써요.'));
    return;
  }
  const ul = el('ul', 'who');
  for (const u of d.usingNow) {
    const li = el('li');
    li.append(usingChip(u), el('span', 'muted', u.since ? `${ago(u.since).replace(' 전', '')}째 · ${when(u.since)}부터` : ''));
    ul.append(li);
  }
  box.replaceChildren(ul);
}

function renderUptime() {
  const box = $('uptime');
  const u = d.uptime;
  if (!d.watched && !u) {
    const p = el('p', 'muted', '🔔 다운 알림을 켜면 30초마다 확인해서 업/다운 이력을 남겨요.');
    box.replaceChildren(p, button('🔔 다운 알림 켜기', () => setPortAlert(d.port, true), { write: true }));
    return;
  }
  if (!u) {
    box.replaceChildren(el('p', 'muted', '아직 확인 기록이 없어요. 30초 안에 첫 확인을 해요.'));
    return;
  }
  const tiles = el('div', 'tiles');
  for (const [label, pct] of [['24시간', u.pct24h], ['7일', u.pct7d], ['30일', u.pct30d]]) {
    const t = el('div', `tile${pct !== null && pct < 99 ? ' low' : ''}`);
    t.append(el('span', 'tile-v', pctText(pct)), el('span', 'tile-k', label));
    tiles.append(t);
  }
  const hour = (x) => x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => x.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  const rows = el('div', 'bars');
  const barRow = (label, node, note) => {
    const r = el('div', 'bar-row');
    r.append(el('span', 'bar-k', label), node, el('span', 'bar-note', note));
    rows.append(r);
  };
  barRow('최근 확인', uptimeLine(u).querySelector('.ubar'), '30초 × 30');
  barRow('24시간', slotBar(u.day, hour, 'wide'), '30분 × 48');
  barRow('30일', slotBar(u.month, day, 'wide'), '하루 × 30');
  const note = el('p', 'muted small', `${when(u.since)}부터 기록 · 마지막 확인 ${ago(u.lastCheck)} · 확인하지 않은 시간(Portboard 꺼짐)은 빼고 계산해요. 노랑은 Portboard에서 재시작·중지한 직후예요.`);

  const out = el('div', 'outages');
  out.append(el('h4', null, '다운 기록'));
  if (!u.outages.length) out.append(el('p', 'muted', '기록된 다운이 없어요.'));
  else {
    const ul = el('ul', 'outage-list');
    for (const o of u.outages) {
      const li = el('li', o.to ? '' : 'open');
      li.append(
        el('span', 'o-when', `${when(o.from)} – ${o.to ? when(o.to).replace(/^.*? (?=\d{1,2}:)/, '') : '지금'}`),
        el('span', 'o-len', o.to ? minutes(o.minutes) : `${minutes(o.minutes)}째`),
        el('span', 'muted', o.reason === 'http' ? 'HTTP 응답 없음' : '리스닝 없음'),
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
    box.replaceChildren(el('p', 'muted', d.historySince ? `${when(d.historySince)} 이후 사용 기록이 없어요.` : '사용 기록이 없어요.'));
    return;
  }
  const table = el('table', 'used');
  const head = el('tr');
  for (const h of ['기기', '마지막 사용', '7일', '30일', '처음']) head.append(el('th', null, h));
  table.append(el('thead'));
  table.tHead.append(head);
  const body = el('tbody');
  const live = new Set(d.usingNow.map((u) => u.id));
  for (const r of d.lastUsed) {
    const tr = el('tr');
    const name = el('td', 'dev');
    name.append(userChip(r.name, r.kind, deviceHref(r.device === 'local' ? null : r.device.replace(/~routed$/, '')), r.kind === 'routed' ? USER_KIND.routed : undefined));
    const last = el('td', null, live.has(r.device) ? '지금 사용 중' : ago(r.lastSeen));
    last.title = new Date(r.lastSeen).toLocaleString();
    if (live.has(r.device)) last.className = 'live';
    tr.append(name, last, el('td', 'num', minutes(r.minutes7d)), el('td', 'num', minutes(r.minutes30d)), el('td', 'muted', when(r.firstSeen)));
    body.append(tr);
  }
  table.append(body);
  const note = el('p', 'muted small', `30초마다 본 연결 기준${d.historySince ? ` · ${when(d.historySince)}부터 기록` : ''}. 30초보다 짧은 연결은 빠질 수 있어요.`);
  box.replaceChildren(table, note);
}

function renderEvents() {
  const ul = $('events');
  if (!d.events.length) {
    ul.replaceChildren(el('li', 'muted', d.watched ? '아직 보낸 알림이 없어요.' : '다운 알림이 꺼져 있어요.'));
    return;
  }
  ul.replaceChildren(...d.events.map((x) => {
    const li = el('li', x.ok ? x.kind : `${x.kind} failed`);
    li.append(el('time', null, when(x.t)), el('span', null, x.title), x.ok ? '' : el('span', 'muted', ' (보내기 실패)'));
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
    ul.replaceChildren(el('li', 'muted', '기록을 불러오지 못했어요.'));
    return;
  }
  if (!doc.entries.length) {
    ul.replaceChildren(el('li', 'muted', '이 포트에 대한 변경 기록이 없어요.'));
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
