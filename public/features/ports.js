// The 서비스 tab's rows (GET /api/ports, src/features/ports.ts): one <li class="row"> per port from the #row template,
// ports of the same compose project / unit / process grouped into one card, who uses each port (/api/usage) and the
// row's actions with its ⋯ menu.
//
// ctx: { tpl, usage, busy, openMenu, setOpenMenu(port|null), savePrefs(port, patch) (with undo), act(port, kind),
//        rename(p), confirmAct(p, kind, question), openLogs(p), selected (port|null) }
//
// Wider than a phone the shell (shell.css) shows each row as one dense line pair: the port, name, meta, the key
// badges (class key) and one primary action; the rest of the row (other badges, uptime, users, 상세) stays in the DOM
// for the phone layout and the decorating features, and the inspector (features/port-inspector.js) shows it.

import { portAlertBadge, portBell, portUptime } from './alerts.js';
import { controlText, reachButtons, restartQuestion, stopQuestion } from './control.js';
import { badge, usingChip } from '../lib/badge.js';
import { el } from '../lib/dom.js';
import { moreMenu } from '../lib/menu.js';
import { ago } from '../lib/time.js';

/** Ports of the same compose project / unit / process become one item, placed where its first shown port is. */
export function grouped(rows) {
  const items = [];
  const byKey = new Map();
  for (const p of rows) {
    const key = p.listening && p.group ? p.group.key : null;
    if (!key) { items.push(p); continue; }
    let it = byKey.get(key);
    if (!it) {
      it = { group: p.group, ports: [] };
      byKey.set(key, it);
      items.push(it);
    }
    it.ports.push(p);
  }
  // A group with only one port left after filtering is just that port
  return items.map((it) => (it.ports?.length === 1 ? it.ports[0] : it));
}

/** What the search box matches against */
export function haystack(p, usage) {
  const who = (usage?.byPort[p.port] ?? []).map((u) => u.name);
  return [p.port, p.name, p.detectedName, p.container, p.probe?.title, p.group?.name, p.role, ...who, ...p.processes.flatMap((x) => [x.project, x.unit, x.cwd, x.cmdline])]
    .filter(Boolean).join(' ').toLowerCase();
}

export function renderGroup(it, ctx) {
  const li = el('li', 'group');
  const ports = it.ports.sort((a, b) => a.port - b.port);
  li.classList.toggle('system', ports.every((p) => !p.visible));
  const head = el('div', 'group-head');
  const p0 = ports[0];
  const owner = p0.composeProject ? `docker compose · ${p0.composeProject}`
    : p0.container ? `docker: ${p0.container}`
    : p0.systemOwner ? `${p0.systemOwner} (시스템)`
    : [p0.processes[0]?.project, p0.processes[0]?.unit ?? `pid ${p0.processes[0]?.pid}`].filter(Boolean).join(' · ');
  const hiddenHere = it.group.ports.length - ports.length;
  head.append(
    el('strong', 'group-name', it.group.name),
    el('span', 'group-meta', [owner, `포트 ${ports.map((p) => p.port).join(' · ')}`, hiddenHere ? `숨은 포트 ${hiddenHere}개` : null].filter(Boolean).join(' · ')),
  );
  const sub = el('ul', 'sub');
  sub.append(...ports.map((p) => renderRow(p, ctx, true)));
  li.append(head, sub);
  return li;
}

/** "3시간 전 사용 · dev-mac" for a port nobody is using right now */
export function lastUsedText(port, usage) {
  const h = usage?.history?.byPort[port];
  if (!h) return null;
  return `${ago(h.at)}${ago(h.at) === '방금' ? '' : ' 전'} 사용 · ${h.name}`;
}

export function renderRow(p, ctx, sub = false) {
  const { usage } = ctx;
  const li = ctx.tpl.content.firstElementChild.cloneNode(true);
  li.dataset.port = String(p.port);
  li.classList.toggle('selected', ctx.selected === p.port);
  li.classList.toggle('system', !p.visible);
  li.classList.toggle('sub', sub);
  li.querySelector('.port').textContent = p.port;
  // In a group the header carries the shared name; each port shows its own part (kong, 웹 (HTTP), PeerAPI…)
  const nameEl = li.querySelector('.name');
  nameEl.textContent = sub ? (p.label ?? p.role ?? p.name) : p.name;
  nameEl.title = `${p.label ? `${p.label} (${p.detectedName})` : p.name} · 상세 보기`;
  nameEl.href = `service.html#${p.port}`;

  const pin = li.querySelector('.pin');
  pin.textContent = p.pinned ? '★' : '☆';
  pin.classList.toggle('on', p.pinned);
  pin.title = p.pinned ? '고정 해제' : '맨 위에 고정';
  pin.hidden = !p.listening;
  pin.addEventListener('click', () => ctx.savePrefs(p.port, { pinned: !p.pinned }));
  if (p.listening || p.alert) li.querySelector('.name-line').append(portBell(p));

  const proc = p.processes[0];
  const meta = [
    p.label ? p.detectedName : null,
    proc?.project,
    proc?.unit,
    proc && !proc.unit ? proc.cmdline.split(' ')[0].split('/').pop() : null,
  ].filter(Boolean).join(' · ');
  li.querySelector('.meta').textContent = sub
    ? (p.label && p.role ? p.role : '')
    : meta || (p.kind === 'system' ? (p.systemOwner ? `${p.systemOwner} · 시스템 서비스` : '다른 사용자/시스템 프로세스') : '');

  li.querySelector('.badges').append(...portBadges(p));
  const up = portUptime(p);
  if (up) li.querySelector('.main').append(up);

  const who = p.listening ? usage?.byPort[p.port] : null;
  if (who?.length) {
    const line = el('div', 'users');
    const total = who.reduce((a, u) => a + u.connections, 0);
    // dense rows: the count as a key badge (the chips are in the inspector)
    li.querySelector('.badges').append(badge(`사용 중 ${total}`, 'ok key dense-only'));
    line.append(badge(`사용 중 ${total}`, 'ok'));
    for (const u of who) line.append(usingChip(u, { title: true }));
    li.querySelector('.main').append(line);
    const meta = li.querySelector('.meta');
    meta.append(el('span', 'meta-use', `${meta.textContent ? ' · ' : ''}⇄ ${who.map((u) => u.name).join(', ')}`));
  } else if (p.listening) {
    const last = lastUsedText(p.port, usage);
    if (last) {
      const line = el('div', 'last-used', last);
      const h = usage.history.byPort[p.port];
      line.title = `${new Date(h.at).toLocaleString()}${h.devices7d > 1 ? ` · 최근 7일 기기 ${h.devices7d}대` : ''}`;
      li.querySelector('.main').append(line);
      const meta = li.querySelector('.meta');
      // gives way while the row is hovered or focused (shell.css)
      meta.append(el('span', 'meta-use meta-last', `${meta.textContent ? ' · ' : ''}◷ ${last}`));
    }
  }

  li.querySelector('.actions').append(...reachButtons(p, { busy: ctx.busy.has(p.port), act: (kind) => ctx.act(p.port, kind) }));
  if (p.listening) li.querySelector('.actions').append(rowMenu(p, ctx));

  const dl = li.querySelector('dl');
  for (const [k, v] of portFacts(p)) dl.append(el('dt', null, k), el('dd', null, String(v)));
  return li;
}

/**
 * Every badge of a port, in row order. The ones a dense row keeps are marked key: tailnet HTTPS, 리스닝 없음, local
 * only, and the down / quiet badge of a watched port.
 */
export function portBadges(p) {
  const out = [];
  const add = (text, tone = '', key = false) => out.push(badge(text, `${tone}${key ? ' key' : ''}`.trim()));
  if (p.served) add('tailnet HTTPS', 'ok', true);
  if (!p.listening) add('리스닝 없음', 'warn', true);
  else if (p.scope === 'loopback') add(p.served ? 'local' : 'local only', p.served ? '' : 'warn', !p.served);
  else if (p.scope === 'all') add('모든 인터페이스', 'info');
  else if (p.scope === 'tailnet') add('tailnet', 'info');
  else if (p.scope) add(p.addresses.join(', '));
  if (p.probe?.http) add(`HTTP ${p.probe.status}`);
  if (p.processes.length > 1) add(`${p.processes.length} procs`);
  if (p.kind === 'ephemeral') add('임시 포트');
  if (p.hidden) add('숨김');
  const alertBadge = portAlertBadge(p);
  if (alertBadge) {
    alertBadge.classList.add('key');
    out.push(alertBadge);
  }
  return out;
}

/** The facts a row's 상세 (and the inspector's 무엇인지 / 주소) list: [label, value], empty ones left out */
export function portFacts(p) {
  return [
    ['주소', p.addresses.join(', ')],
    ['페이지 제목', p.probe?.title],
    ['컨테이너', p.container],
    ['compose', p.composeProject],
    ['묶음', p.group ? `${p.group.name} (${p.group.ports.join(', ')})` : null],
    ...p.processes.flatMap((x) => [
      ['PID', x.pid],
      ['명령', x.cmdline],
      ['경로', x.cwd],
      ['systemd', x.unit && `${x.unit}${x.unitDescription ? ` — ${x.unitDescription}` : ''}`],
    ]),
    ['제어', controlText(p.control)],
    ['직접 URL', p.urls.direct],
    ['Tailnet URL', p.urls.served],
    ['SSH', p.urls.ssh],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
}

/**
 * ⋯ (also a right-click on the row): 이름 바꾸기, 숨기기, 🔔, 로그 보기, 재시작, then 중지 after a separator (both ask
 * first; hiding and alert off apply at once with 되돌리기). Stays open across the 10 s refresh.
 */
function rowMenu(p, ctx) {
  const items = [
    { label: '이름 바꾸기', onClick: () => ctx.rename(p), write: true },
    { label: p.hidden ? '다시 보이기' : '숨기기', onClick: () => ctx.savePrefs(p.port, { hidden: !p.hidden }), write: true },
    { label: p.alert ? '🔔 다운 알림 끄기' : '🔔 다운 알림 켜기', onClick: () => ctx.savePrefs(p.port, { alert: !p.alert }), write: true },
  ];
  if (p.control) items.push({ label: '로그 보기', onClick: () => ctx.openLogs(p) });
  if (p.canRestart) items.push({ label: '재시작', onClick: () => ctx.confirmAct(p, 'restart', restartQuestion(p)), write: true });
  if (p.canStop) items.push({ label: '중지', onClick: () => ctx.confirmAct(p, 'stop', stopQuestion(p)), danger: true, write: true });
  return moreMenu({
    ariaLabel: `${p.port} 더 보기`,
    items,
    open: ctx.openMenu === p.port,
    onToggle: (open) => {
      if (open) ctx.setOpenMenu(p.port);
      else if (ctx.openMenu === p.port) ctx.setOpenMenu(null);
    },
  });
}
