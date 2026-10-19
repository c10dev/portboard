// Proxmox on the 기기 tab (src/features/proxmox.ts): CPU/memory trends (GET /api/proxmox/trends) as inline SVG
// sparklines for cards and guest rows and the 24 h chart in the detail panel, the host line, the guest list and a
// guest's own detail. No libraries. Values are fractions (0..1); null is a gap, never 0.

import { dl, el } from '../lib/dom.js';
import { gib, pct } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { paths, sparkline, svg } from '../lib/sparkline.js';

/** Last answers per timeframe */
const cache = { hour: null, day: null };
const loading = {};

export async function loadTrends(timeframe = 'hour', { force = false } = {}) {
  if (loading[timeframe]) return loading[timeframe];
  if (!force && cache[timeframe] && Date.now() - cache[timeframe].fetched < 55_000) return cache[timeframe];
  loading[timeframe] = fetch(`/api/proxmox/trends?timeframe=${timeframe}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((res) => {
      if (res) cache[timeframe] = { ...res, fetched: Date.now() };
      return cache[timeframe];
    })
    .catch(() => cache[timeframe])
    .finally(() => (loading[timeframe] = null));
  return loading[timeframe];
}

export const trendsOf = (timeframe) => cache[timeframe];

/** The trend for a host card (pveHost) or a guest ({node, vmid}), or null */
export function trendFor(timeframe, ref) {
  const tr = cache[timeframe];
  if (!tr?.ok) return null;
  const s = ref.vmid != null ? tr.guests[`${ref.node}/${ref.vmid}`] : tr.nodes[ref.node];
  return s && !s.error && s.cpu.some((v) => v !== null) ? s : null;
}

/** Why there are no trends (shown in the detail), or null */
export function trendProblem(timeframe, ref) {
  const tr = cache[timeframe];
  if (!tr) return null;
  if (!tr.ok) return tr.configured ? t('proxmox.trend.error', { error: tr.error ?? t('proxmox.trend.unknownError') }) : null;
  const s = ref.vmid != null ? tr.guests[`${ref.node}/${ref.vmid}`] : tr.nodes[ref.node];
  if (s?.error) return t('proxmox.trend.error', { error: s.error });
  return null;
}

const last = (vals) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return vals[i]; return null; };
const finite = (vals) => vals.filter((v) => v !== null);
export const pctText = (v) => (v === null || v === undefined ? '–' : v < 0.01 && v > 0 ? '<1%' : `${Math.round(v * 100)}%`);

/** CPU on a fixed ladder so a 5 % line is visible but the scale stays honest (and labelled in the 24 h view) */
export function cpuScale(vals) {
  const max = Math.max(0, ...finite(vals));
  return [0.05, 0.1, 0.25, 0.5, 1].find((s) => max <= s * 0.95) ?? 1;
}

/** "CPU ▁▂▅ 8% · 메모리 ▇▇▇ 85%" for a card; the last hour */
export function trendRow(series, { title = t('proxmox.lastHour') } = {}) {
  const row = el('div', 'trend');
  row.title = t('proxmox.trend.tap', { title });
  const cpuS = cpuScale(series.cpu);
  for (const [kind, label, vals, scale] of [['cpu', 'CPU', series.cpu, cpuS], ['mem', t('proxmox.mem'), series.mem, 1]]) {
    const cell = el('span', `trend-cell ${kind}`);
    const now = last(vals);
    cell.append(el('span', 'trend-k', label), sparkline(vals, { kind, scale, label: t('proxmox.trend.label', { label, title, now: pctText(now), max: pctText(Math.max(...finite(vals))) }) }), el('span', 'trend-v', pctText(now)));
    row.append(cell);
  }
  return row;
}

function hhmm(sec) {
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One 24 h chart with a scale label, avg/max and a tap/hover readout */
function chart(series, kind, label) {
  const vals = series[kind];
  const scale = kind === 'cpu' ? cpuScale(vals) : 1;
  const nums = finite(vals);
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  const max = nums.length ? Math.max(...nums) : null;
  const box = el('div', `tchart ${kind}`);
  const head = el('div', 'tchart-h');
  const read = el('span', 'tchart-read', t('proxmox.chart.now', { v: pctText(last(vals)) }));
  head.append(el('strong', null, label), el('span', 'tchart-stat', t('proxmox.chart.stat', { avg: pctText(avg), max: pctText(max) })), read);
  const w = 300, h = 64;
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: `spark big ${kind}`, role: 'img', 'aria-label': t('proxmox.chart.aria', { label, avg: pctText(avg), max: pctText(max) }) });
  s.append(svg('line', { x1: 0, x2: w, y1: h / 2, y2: h / 2, class: 'grid', 'vector-effect': 'non-scaling-stroke' }));
  const { line, area } = paths(vals, w, h, scale);
  const cursor = svg('line', { x1: 0, x2: 0, y1: 0, y2: h, class: 'cursor', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  s.append(svg('path', { d: area, class: 'area' }), svg('path', { d: line, class: 'line', 'vector-effect': 'non-scaling-stroke' }), cursor);
  const plot = el('div', 'tchart-plot');
  plot.append(s, el('span', 'tchart-scale', pctText(scale)), el('span', 'tchart-mid', pctText(scale / 2)));
  const at = (ev) => {
    const r = s.getBoundingClientRect();
    const i = Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (vals.length - 1));
    cursor.setAttribute('x1', String((i / Math.max(1, vals.length - 1)) * w));
    cursor.setAttribute('x2', cursor.getAttribute('x1'));
    cursor.setAttribute('visibility', 'visible');
    read.textContent = `${hhmm(series.start + i * series.step)} · ${pctText(vals[i])}`;
  };
  s.addEventListener('pointermove', at);
  s.addEventListener('pointerdown', at);
  s.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); read.textContent = t('proxmox.chart.now', { v: pctText(last(vals)) }); });
  const axis = el('div', 'tchart-x');
  axis.append(el('span', null, t('proxmox.chart.ago24')), el('span', null, t('proxmox.chart.ago12')), el('span', null, t('proxmox.chart.nowAxis')));
  box.append(head, plot, axis);
  return box;
}

/** The detail panel's 24 h block for a host or guest; fetches the day series on first use, then calls redraw. */
export function dayBlock(ref, sub, redraw) {
  const box = el('div', 'd-trend');
  const h = el('div', 'd-recent-h', t('proxmox.day.head'));
  box.append(h);
  const day = trendFor('day', ref);
  // the 24 h series is fetched when a detail first needs it, and again once it is a minute old
  const cached = trendsOf('day');
  if (!cached || Date.now() - cached.fetched > 60_000) loadTrends('day').then(redraw);
  if (day) {
    box.append(chart(day, 'cpu', `CPU${day.maxcpu ? ` · ${t('proxmox.cores', { n: day.maxcpu })}` : ''}`), chart(day, 'mem', `${t('proxmox.mem')}${day.maxmem ? ` · ${gib(day.maxmem)}` : ''}`));
    box.append(el('p', 'muted small', t('proxmox.day.note', { min: Math.round(day.step / 60), sub: sub ? ` · ${sub}` : '' })));
  } else {
    const problem = trendProblem('day', ref);
    box.append(el('p', 'muted', problem ?? (cached ? t('proxmox.day.empty') : t('common.loading'))));
  }
  return box;
}

// ---- hosts and guests ----

/** Proxmox ref of a card: its host node, or the guest it is */
export function pveRef(c) {
  if (c.pveHost) return { node: c.pveHost.node };
  if (c.guestOf) return { node: c.guestOf.node, vmid: c.guestOf.vmid };
  return null;
}

/** Uptime in seconds as "3일" or "5시간" */
function upText(s) {
  if (!s) return null;
  const d = Math.floor(s / 86400);
  return d ? t('time.day', { n: d }) : t('time.hour', { n: Math.floor(s / 3600) });
}

/** "Proxmox pve1 · CPU 3%/8코어 · 메모리 40% · 디스크 12% · 가동 9일" */
export function hostLine(h) {
  return [
    `Proxmox ${h.node}`,
    h.status !== 'online' ? h.status : null,
    h.cpu != null ? `CPU ${Math.round(h.cpu * 100)}%${h.maxcpu ? `/${t('proxmox.cores', { n: h.maxcpu })}` : ''}` : null,
    pct(h.mem, h.maxmem) && t('proxmox.host.mem', { pct: pct(h.mem, h.maxmem) }),
    pct(h.disk, h.maxdisk) && t('proxmox.host.disk', { pct: pct(h.disk, h.maxdisk) }),
    upText(h.uptime) && t('proxmox.host.up', { up: upText(h.uptime) }),
  ].filter(Boolean).join(' · ');
}

/** The host card's guests: each opens its device card, or its own 24 h detail when it has none. ctx: { data, showDetail } */
export function guestList(h, ctx) {
  const ul = el('ul', 'guests');
  for (const g of h.guests) {
    const li = el('li', `guest ${g.status === 'running' ? 'on' : 'off'}`);
    const card = g.device ? ctx.data.cards.find((x) => x.id === g.device) : null;
    const target = card ? card.id : `guest:${h.node}/${g.vmid}`;
    const name = el('button', 'guest-name');
    name.type = 'button';
    name.title = card ? t('proxmox.guest.view') : t('proxmox.guest.viewTrend');
    name.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.showDetail(target); });
    name.append(el('span', `gtype ${g.type}`, g.type === 'lxc' ? 'CT' : 'VM'), el('span', 'vmid', g.vmid), el('span', 'gname', g.name));
    if (card?.kind === 'self') name.append(el('span', 'tag', t('proxmox.guest.self')));
    else if (card && card.kind !== 'lan' && !card.online && g.status === 'running') name.append(el('span', 'tag warn', t('proxmox.guest.tsOff')));
    const meta = [
      g.status === 'running' ? null : g.status,
      g.status === 'running' && g.cpu != null ? `CPU ${Math.round(g.cpu * 100)}%` : null,
      g.status === 'running' && g.mem != null ? `${gib(g.mem)}/${gib(g.maxmem)}` : null,
      g.ports ? t('proxmox.ports', { n: g.ports.ports.length }) : null,
    ].filter(Boolean).join(' · ');
    li.append(el('span', 'gdot'), name);
    const tr = trendFor('hour', { node: h.node, vmid: g.vmid });
    if (tr) {
      const sp = sparkline(tr.cpu, { kind: 'cpu', scale: cpuScale(tr.cpu), label: t('proxmox.guest.spark', { name: g.name }) });
      sp.classList.add('mini');
      const b = el('button', 'guest-spark');
      b.type = 'button';
      b.title = t('proxmox.guest.sparkTap', { name: g.name });
      b.append(sp);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.showDetail(target); });
      li.append(b);
    }
    li.append(el('span', 'guest-meta', meta));
    ul.append(li);
  }
  return ul;
}

/** A guest from the tree by "guest:<node>/<vmid>", or null */
export function findGuest(id, data) {
  const [node, vmidStr] = id.slice(6).split('/');
  const vmid = Number(vmidStr);
  const host = data.cards.map((c) => c.pveHost).find((h) => h?.node === node);
  const g = host?.guests.find((x) => x.vmid === vmid);
  return g ? { node, vmid, g } : null;
}

/** The detail of a Proxmox guest with no card of its own (jellyfin): its line from the tree and the 24 h trend */
export function guestDetail({ node, vmid, g }, redraw) {
  const type = g.type === 'lxc' ? 'CT' : 'VM';
  return [
    el('div', 'd-kicker', type === 'CT' ? t('proxmox.guest.kickerCt', { node }) : t('proxmox.guest.kickerVm', { node })),
    el('h3', 'd-title', g.name),
    dl([
      ['Proxmox', `${node} · ${type} ${vmid} · ${g.status}`],
      ['CPU', g.status === 'running' && g.cpu != null ? `${pctText(g.cpu)}${g.maxcpu ? ` / ${t('proxmox.cores', { n: g.maxcpu })}` : ''}` : null],
      [t('proxmox.mem'), g.mem != null ? `${gib(g.mem)} / ${gib(g.maxmem)}` : null],
      [t('proxmox.uptime'), upText(g.uptime)],
      ['LAN IP', g.lanIp ?? (g.ips.join(', ') || null)],
      ['MAC', g.macs.join('\n')],
    ]),
    dayBlock({ node, vmid }, t('proxmox.guest.sub', { node, type, vmid }), redraw),
    el('p', 'muted small', t('proxmox.guest.noCard')),
  ];
}
