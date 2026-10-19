// Proxmox on the 기기 tab (src/features/proxmox.ts): CPU/memory trends (GET /api/proxmox/trends) as inline SVG
// sparklines for cards and guest rows and the 24 h chart in the detail panel, the host line, the guest list and a
// guest's own detail. No libraries. Values are fractions (0..1); null is a gap, never 0.

import { dl, el } from '../lib/dom.js';
import { gib, pct } from '../lib/format.js';
import { paths, sparkline, svg } from '../lib/sparkline.js';

/** Last answers per timeframe */
const cache = { hour: null, day: null };
const loading = {};

export async function loadTrends(timeframe = 'hour', { force = false } = {}) {
  if (loading[timeframe]) return loading[timeframe];
  if (!force && cache[timeframe] && Date.now() - cache[timeframe].fetched < 55_000) return cache[timeframe];
  loading[timeframe] = fetch(`/api/proxmox/trends?timeframe=${timeframe}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((t) => {
      if (t) cache[timeframe] = { ...t, fetched: Date.now() };
      return cache[timeframe];
    })
    .catch(() => cache[timeframe])
    .finally(() => (loading[timeframe] = null));
  return loading[timeframe];
}

export const trendsOf = (timeframe) => cache[timeframe];

/** The trend for a host card (pveHost) or a guest ({node, vmid}), or null */
export function trendFor(timeframe, ref) {
  const t = cache[timeframe];
  if (!t?.ok) return null;
  const s = ref.vmid != null ? t.guests[`${ref.node}/${ref.vmid}`] : t.nodes[ref.node];
  return s && !s.error && s.cpu.some((v) => v !== null) ? s : null;
}

/** Why there are no trends (shown in the detail), or null */
export function trendProblem(timeframe, ref) {
  const t = cache[timeframe];
  if (!t) return null;
  if (!t.ok) return t.configured ? `추이를 못 읽었어요: ${t.error ?? '알 수 없는 오류'}` : null;
  const s = ref.vmid != null ? t.guests[`${ref.node}/${ref.vmid}`] : t.nodes[ref.node];
  if (s?.error) return `추이를 못 읽었어요: ${s.error}`;
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
export function trendRow(series, { title = '지난 1시간' } = {}) {
  const row = el('div', 'trend');
  row.title = `${title} · 눌러서 24시간 보기`;
  const cpuS = cpuScale(series.cpu);
  for (const [kind, label, vals, scale] of [['cpu', 'CPU', series.cpu, cpuS], ['mem', '메모리', series.mem, 1]]) {
    const cell = el('span', `trend-cell ${kind}`);
    const now = last(vals);
    cell.append(el('span', 'trend-k', label), sparkline(vals, { kind, scale, label: `${label} ${title} · 지금 ${pctText(now)} · 최대 ${pctText(Math.max(...finite(vals)))}` }), el('span', 'trend-v', pctText(now)));
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
  const read = el('span', 'tchart-read', `지금 ${pctText(last(vals))}`);
  head.append(el('strong', null, label), el('span', 'tchart-stat', `평균 ${pctText(avg)} · 최대 ${pctText(max)}`), read);
  const w = 300, h = 64;
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: `spark big ${kind}`, role: 'img', 'aria-label': `${label} 최근 24시간 · 평균 ${pctText(avg)} · 최대 ${pctText(max)}` });
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
  s.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); read.textContent = `지금 ${pctText(last(vals))}`; });
  const axis = el('div', 'tchart-x');
  axis.append(el('span', null, '24시간 전'), el('span', null, '12시간 전'), el('span', null, '지금'));
  box.append(head, plot, axis);
  return box;
}

/** The detail panel's 24 h block for a host or guest; fetches the day series on first use, then calls redraw. */
export function dayBlock(ref, sub, redraw) {
  const box = el('div', 'd-trend');
  const h = el('div', 'd-recent-h', '최근 24시간');
  box.append(h);
  const day = trendFor('day', ref);
  // the 24 h series is fetched when a detail first needs it, and again once it is a minute old
  const cached = trendsOf('day');
  if (!cached || Date.now() - cached.fetched > 60_000) loadTrends('day').then(redraw);
  if (day) {
    box.append(chart(day, 'cpu', `CPU${day.maxcpu ? ` · ${day.maxcpu}코어` : ''}`), chart(day, 'mem', `메모리${day.maxmem ? ` · ${gib(day.maxmem)}` : ''}`));
    box.append(el('p', 'muted small', `Proxmox가 기록한 ${Math.round(day.step / 60)}분 평균${sub ? ` · ${sub}` : ''}. CPU 눈금은 값에 맞춰 바뀌어요.`));
  } else {
    const problem = trendProblem('day', ref);
    box.append(el('p', 'muted', problem ?? (cached ? '기록이 없어요 (꺼져 있었거나 새로 만든 게스트).' : '불러오는 중…')));
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
  return d ? `${d}일` : `${Math.floor(s / 3600)}시간`;
}

/** "Proxmox pve1 · CPU 3%/8코어 · 메모리 40% · 디스크 12% · 가동 9일" */
export function hostLine(h) {
  return [
    `Proxmox ${h.node}`,
    h.status !== 'online' ? h.status : null,
    h.cpu != null ? `CPU ${Math.round(h.cpu * 100)}%${h.maxcpu ? `/${h.maxcpu}코어` : ''}` : null,
    pct(h.mem, h.maxmem) && `메모리 ${pct(h.mem, h.maxmem)}`,
    pct(h.disk, h.maxdisk) && `디스크 ${pct(h.disk, h.maxdisk)}`,
    upText(h.uptime) && `가동 ${upText(h.uptime)}`,
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
    name.title = card ? '이 기기 보기' : '24시간 추이 보기';
    name.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.showDetail(target); });
    name.append(el('span', `gtype ${g.type}`, g.type === 'lxc' ? 'CT' : 'VM'), el('span', 'vmid', g.vmid), el('span', 'gname', g.name));
    if (card?.kind === 'self') name.append(el('span', 'tag', '이 서버'));
    else if (card && card.kind !== 'lan' && !card.online && g.status === 'running') name.append(el('span', 'tag warn', 'Tailscale 꺼짐'));
    const meta = [
      g.status === 'running' ? null : g.status,
      g.status === 'running' && g.cpu != null ? `CPU ${Math.round(g.cpu * 100)}%` : null,
      g.status === 'running' && g.mem != null ? `${gib(g.mem)}/${gib(g.maxmem)}` : null,
      g.ports ? `포트 ${g.ports.ports.length}` : null,
    ].filter(Boolean).join(' · ');
    li.append(el('span', 'gdot'), name);
    const tr = trendFor('hour', { node: h.node, vmid: g.vmid });
    if (tr) {
      const sp = sparkline(tr.cpu, { kind: 'cpu', scale: cpuScale(tr.cpu), label: `${g.name} CPU 지난 1시간` });
      sp.classList.add('mini');
      const b = el('button', 'guest-spark');
      b.type = 'button';
      b.title = `${g.name} CPU 지난 1시간 · 눌러서 24시간 보기`;
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
  const t = g.type === 'lxc' ? 'CT' : 'VM';
  return [
    el('div', 'd-kicker', `Proxmox ${node}의 ${t === 'CT' ? '컨테이너' : '가상 머신'}`),
    el('h3', 'd-title', g.name),
    dl([
      ['Proxmox', `${node} · ${t} ${vmid} · ${g.status}`],
      ['CPU', g.status === 'running' && g.cpu != null ? `${pctText(g.cpu)}${g.maxcpu ? ` / ${g.maxcpu}코어` : ''}` : null],
      ['메모리', g.mem != null ? `${gib(g.mem)} / ${gib(g.maxmem)}` : null],
      ['가동', upText(g.uptime)],
      ['LAN IP', g.lanIp ?? (g.ips.join(', ') || null)],
      ['MAC', g.macs.join('\n')],
    ]),
    dayBlock({ node, vmid }, `${node}의 ${t} ${vmid}`, redraw),
    el('p', 'muted small', '이 서버에 접속한 적이 없어서 따로 기기 카드는 없어요.'),
  ];
}
