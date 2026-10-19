// The 기기 tab's cards (GET /api/usage, src/features/usage.ts): one card per device with what it uses on this server
// right now, its last-used history, the idle chips and the list of services nobody uses.
//
// ctx: { data (the last /api/usage), showDetail(id), nameDevice(card) }

import { canWatchDevice, deviceBell, deviceWatched } from './alerts.js';
import { POOL_STATE } from './devices.js';
import { portsBox } from './host-ports.js';
import { short } from './known.js';
import { guestList, hostLine, pveRef, trendFor, trendRow } from './proxmox.js';
import { routedTitle } from '../lib/nettree.js';
import { el } from '../lib/dom.js';
import { bytes } from '../lib/format.js';
import { locale, t } from '../lib/i18n.js';
import { agoMonths as ago, usageMinutes as minutes } from '../lib/time.js';

const OS = { macOS: ['mac', 'Mac'], windows: ['win', 'Windows'], iOS: ['iOS', 'iPhone'], android: ['and', 'Android'], linux: ['lnx', 'Linux'] };

function glyph(c) {
  if (c.kind === 'lan') return c.guestOf ? (c.guestOf.type === 'lxc' ? 'CT' : 'VM') : c.vendor && /proxmox/i.test(c.vendor) ? 'VM' : 'LAN';
  if (c.kind === 'funnel') return 'www';
  if (c.kind === 'other') return '?';
  return OS[c.os]?.[0] ?? (c.pool ? 'pool' : '?');
}

export function osName(c) {
  return OS[c.os]?.[1] ?? c.os ?? null;
}

export function poolLine(p) {
  const [state] = POOL_STATE[p.state] ?? [p.state];
  const bits = [`compute-pool ${p.name} · ${state}`];
  if (p.cpuPct != null) bits.push(`CPU ${p.cpuPct}%`);
  else if (p.load1 != null && p.cores) bits.push(`load ${p.load1.toFixed(1)}/${p.cores}`);
  if (p.memTotalMb && p.memAvailMb != null) bits.push(t('usage.pool.mem', { pct: Math.round((1 - p.memAvailMb / p.memTotalMb) * 100) }));
  if (p.diskFreePct != null) bits.push(t('usage.pool.diskFree', { pct: p.diskFreePct }));
  if (p.busy) bits.push(t('usage.pool.jobs', { busy: p.busy, slots: p.slots }));
  return bits.join(' · ');
}

function tone(c) {
  if (c.pool) return POOL_STATE[c.pool.state]?.[1] ?? 'off';
  return c.online ? 'ok' : 'off';
}

/** Second line: what it is and how it reaches this server. */
function subLine(c) {
  const bits = [];
  if (c.kind === 'funnel') {
    // Tailscale Funnel: the public internet through tailscaled, so no device or address is known.
    const fronts = [...new Set(c.uses.map((u) => `:${u.servePort ?? '?'} → :${u.port}`))];
    return [t('usage.sub.funnel'), ...fronts].join(' · ');
  }
  if (c.kind === 'lan' || c.kind === 'other') {
    bits.push(c.addresses[0] ? `LAN ${c.addresses[0]}` : c.lanIps[0] ? `LAN ${c.lanIps[0]}` : c.id);
    if (c.nameSource === 'vendor') bits.push(t('usage.sub.vendor'));
    else if (c.nameSource === 'proxmox') bits.push(t('usage.sub.proxmox'));
    else if (c.nameSource === 'user') bits.push(c.vendor ? short(c.vendor) : t('usage.sub.userName'));
    else if (c.randomMac) bits.push(t('usage.sub.randomMac'));
    else bits.push(t('usage.sub.noName'));
    return bits.join(' · ');
  }
  const os = osName(c);
  if (os) bits.push(os);
  if (c.networks.includes('tailnet') || !c.networks.length) {
    if (c.kind === 'self') bits.push(t('common.thisServer'));
    else if (!c.online) bits.push(c.lastSeen ? t('usage.offlineAgo', { ago: ago(c.lastSeen) }) : t('usage.offline'));
    else if (c.path?.type === 'direct') bits.push(t('usage.sub.direct'));
    else if (c.path?.type === 'relay') bits.push(t('usage.sub.relay', { region: c.path.region }));
    else if (c.networks.includes('tailnet')) bits.push('Tailscale');
    else bits.push(t('usage.sub.online'));
  }
  if (c.networks.includes('lan')) bits.push(`LAN ${c.addresses.find((a) => !a.startsWith('100.')) ?? c.lanIps[0]}`);
  return bits.join(' · ');
}

/** The last-used history in /api/usage (empty before the first sample) */
export const hist = (d) => d.history ?? { startedAt: null, byPort: {}, byDevice: {} };

/** "최근 7일: SSH 3시간 · Portboard 20분" */
function recentLine(ctx, id, max = 3) {
  const r = hist(ctx.data).byDevice[id]?.recent ?? [];
  if (!r.length) return null;
  const parts = r.slice(0, max).map((x) => `${x.service} ${minutes(x.minutes)}`);
  return r.length > max ? t('usage.recentMore', { list: parts.join(' · '), n: r.length - max }) : t('usage.recent', { list: parts.join(' · ') });
}

/** "3일 전" → "3일" ("3d ago" → "3d"): the time.ago wrapper taken off again */
function withoutAgo(text) {
  const [pre, post] = t('time.ago').split('{t}');
  return text.startsWith(pre) && text.endsWith(post) && text.length > pre.length + post.length ? text.slice(pre.length, text.length - post.length) : text;
}

/** Idle services, one item per group (same compose project, unit or process), with who used it last. */
export function idleServices(ctx) {
  const items = [];
  const byKey = new Map();
  for (const s of ctx.data.idle ?? []) {
    const key = s.group?.key;
    if (key && byKey.has(key)) { byKey.get(key).ports.push(s.port); continue; }
    const it = { name: s.group?.name ?? s.service, ports: [s.port] };
    if (key) byKey.set(key, it);
    items.push(it);
  }
  const since = hist(ctx.data).startedAt;
  return items.map((it) => {
    const li = el('li');
    const name = el('span', 'use-name');
    name.append(el('span', null, it.name), el('span', 'use-port', it.ports.map((p) => `:${p}`).join(' ')));
    const last = it.ports.map((p) => hist(ctx.data).byPort[p]).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
    const meta = last
      ? t('usage.idle.lastUse', { ago: ago(last.at), name: last.name })
      : since && Date.now() - Date.parse(since) >= 60_000 ? t('usage.idle.noUseFor', { t: withoutAgo(ago(since)) }) : t('usage.idle.noUse');
    const m = el('span', `use-meta${last ? '' : ' none'}`, meta);
    if (last) m.title = new Date(last.at).toLocaleString(locale());
    li.append(name, m);
    return li;
  });
}

export function pastChip(id, d, ctx) {
  const b = el('span', 'chip off past');
  b.append(el('span', 'dot'), el('span', 'chip-name', d.name), el('span', 'chip-extra', t('usage.usedAgo', { ago: ago(d.lastSeen) })));
  b.title = [recentLine(ctx, id, 5), id].filter(Boolean).join('\n');
  return b;
}

export function card(c, ctx, isSelf = false) {
  const n = el('article', `card t-${tone(c)}${isSelf ? ' self' : ''}`);
  n.tabIndex = 0;
  n.dataset.id = c.id;

  const head = el('div', 'card-head');
  head.append(el('span', `glyph k-${c.kind}`, glyph(c)));
  const who = el('div', 'who');
  const nameLine = el('div', 'name-line');
  nameLine.append(el('span', 'dot'), el('strong', 'dev-name', isSelf ? t('usage.card.selfName', { name: c.name }) : c.name));
  if (canWatchDevice(c)) nameLine.append(deviceBell(c));
  who.append(nameLine, el('div', 'dev-sub', subLine(c)));
  const badges = badgesFor(c);
  if (badges.length) {
    const b = el('div', 'dev-badges');
    b.append(...badges);
    who.append(b);
  }
  if (c.pool && !isSelf) who.append(el('div', 'dev-pool', poolLine(c.pool)));
  if (c.pveHost) who.append(el('div', 'dev-pool', hostLine(c.pveHost)));
  head.append(who);

  if (c.nameKey) {
    const b = el('button', 'name-btn', c.nameSource === 'user' ? t('usage.card.rename') : t('usage.card.name'));
    b.dataset.write = '1';
    b.type = 'button';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.nameDevice(c); });
    head.append(b);
  }
  n.append(head);
  const ref = pveRef(c);
  const tr = ref && trendFor('hour', ref);
  if (tr) n.append(trendRow(tr, { title: t('usage.card.trend', { what: ref.vmid != null ? `${c.guestOf.type === 'lxc' ? 'CT' : 'VM'} ${ref.vmid}` : ref.node }) }));

  if (isSelf) {
    if (c.pool) n.append(el('div', 'dev-pool solo', poolLine(c.pool)));
    const loc = ctx.data.local;
    const d = el('details', 'local');
    const sum = el('summary');
    sum.append(el('strong', null, t('usage.card.localConns', { n: loc.connections })));
    const names = [...new Set(loc.uses.map(localText))];
    if (names.length) sum.append(document.createTextNode(` — ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}`));
    d.append(sum, useList(loc.uses, true));
    n.append(d);
  } else {
    const mine = c.uses.filter((u) => !u.routed);
    const via = c.uses.filter((u) => u.routed);
    if (mine.length) n.append(useList(mine));
    const recent = recentLine(ctx, c.id);
    if (recent) n.append(el('div', 'recent', recent));
    if (via.length) {
      const box = el('div', 'routed');
      const h = el('div', 'routed-h');
      h.append(el('strong', null, t('usage.card.via', { name: c.name })), document.createTextNode(` · ${t('usage.card.viaNote')}`));
      h.title = routedTitle(c.name, c.routes);
      box.append(h, useList(via));
      n.append(box);
    }
  }
  if (c.pveHost) n.append(guestList(c.pveHost, ctx));
  if (!isSelf) {
    const ports = portsBox(c, ctx.data);
    if (ports) n.append(ports);
  }

  n.addEventListener('click', () => ctx.showDetail(c.id));
  n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ctx.showDetail(c.id); });
  if (isSelf && ref) n.classList.add('tappable');
  return n;
}

/** How a guest was matched to its card (the badge's title) */
const MATCH = { mac: 'usage.match.mac', name: 'usage.match.name', ip: 'usage.match.ip' };

function badgesFor(c) {
  const out = [];
  if (c.newDevice) {
    const b = el('span', 'badge new', t('usage.badge.new'));
    b.title = `${c.newDevice.scope === 'neighbor' ? t('usage.badge.newNeighbor') : t('usage.badge.newSelf')} · ${new Date(c.newDevice.since).toLocaleString(locale())}`;
    out.push(b);
  }
  if (c.guestOf) {
    const type = c.guestOf.type === 'lxc' ? 'CT' : 'VM';
    const b = el('span', 'badge info', `${c.guestOf.node} · ${type} ${c.guestOf.vmid}`);
    const how = MATCH[c.guestOf.match] ? t(MATCH[c.guestOf.match]) : '';
    b.title = type === 'CT' ? t('usage.badge.guestCt', { node: c.guestOf.node, how }) : t('usage.badge.guestVm', { node: c.guestOf.node, how });
    out.push(b);
    if (c.guestOf.status !== 'running') out.push(el('span', 'badge warn', `Proxmox: ${c.guestOf.status}`));
  } else if (c.virt && c.virt.type !== 'none') {
    out.push(el('span', 'badge info', c.virt.proxmoxMac ? 'Proxmox VM' : `VM (${c.virt.type})`));
  }
  if (c.pveHost) out.push(el('span', 'badge', t('usage.badge.pveHost')));
  if (c.routes.length) {
    const b = el('span', 'badge', t('usage.badge.router', { routes: c.routes.join(', ') }));
    b.title = t('usage.badge.routerTitle');
    out.push(b);
  }
  return out;
}

export function localText(u) {
  const who = u.processes[0]?.replace(/ \(\d+\)$/, '');
  return who ? `${who} → ${u.service}` : u.service;
}

function useList(uses, local = false) {
  const ul = el('ul', 'uses');
  for (const u of uses) {
    const li = el('li');
    const name = el('span', 'use-name');
    name.append(el('span', null, local ? localText(u) : u.service));
    name.append(el('span', 'use-port', `:${u.port}`));
    if (u.via === 'serve') name.append(el('span', 'tag serve', 'serve'));
    li.append(name, el('span', 'use-meta', `${u.port === 22 ? t('usage.use.sessions', { n: u.connections }) : t('usage.use.conns', { n: u.connections })} · ${bytes(u.bytesSent + u.bytesReceived)}`));
    ul.append(li);
  }
  return ul;
}

export function idleChip(c, ctx) {
  const b = el('button', `chip t-${tone(c)}${c.online ? '' : ' off'}`);
  b.type = 'button';
  b.append(el('span', 'dot'), el('span', 'chip-name', c.name));
  if (c.newDevice) b.append(el('span', 'badge new', t('usage.badge.newShort')));
  const vmUp = c.guestOf?.status === 'running';
  const extra = !c.online
    ? vmUp ? t('usage.chip.vmUp', { type: c.guestOf.type === 'lxc' ? 'CT' : 'VM' }) : c.lastSeen ? t('usage.offlineAgo', { ago: ago(c.lastSeen) }) : t('usage.offline')
    : c.pool ? [POOL_STATE[c.pool.state]?.[0] ?? c.pool.state, c.ports ? t('usage.chip.ports', { n: c.ports.ports.length }) : null].filter(Boolean).join(' · ')
    : c.ports ? [osName(c), t('usage.chip.ports', { n: c.ports.ports.length })].filter(Boolean).join(' · ') : osName(c);
  const used = hist(ctx.data).byDevice[c.id]?.lastSeen;
  const text = [extra, used ? t('usage.usedAgo', { ago: ago(used) }) : null].filter(Boolean).join(' · ');
  if (text) b.append(el('span', 'chip-extra', text));
  const recent = recentLine(ctx, c.id, 5);
  if (recent) b.title = recent;
  if (deviceWatched(c.id)) b.append(el('span', 'chip-bell', '🔔'));
  b.addEventListener('click', () => ctx.showDetail(c.id));
  return b;
}
