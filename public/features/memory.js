// 메모리 on the 기기 tab (src/features/memory.ts, GET /api/memory): under 이 서버, a bar of used / cache / free with swap
// and PSI, the hour's sparklines, suggestions, then tables: Claude sessions, MCP servers, services and dev servers,
// docker and the rest. Self-contained: it adds its own heading and section after #self and its own styles, so the
// page (devices.html / devices.js) is not edited. Read-only: suggestions say where to act (the Claude app, the 서비스
// tab's 정리); nothing here stops a process.

import { tryJSON } from '../lib/api.js';
import { $, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { sparkline } from '../lib/sparkline.js';
import { ago } from '../lib/time.js';

const STYLE = `
.mem { padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.mem-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.mem-head strong { font-size: 15px; }
.mem-head .muted { font-size: 12px; }
.mem-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--neutral-bg); margin: 10px 0 4px; }
.mem-bar span { display: block; height: 100%; min-width: 1px; }
.mem-bar .used { background: var(--accent); }
.mem-bar .cache { background: color-mix(in srgb, var(--accent) 35%, transparent); }
.mem-bar .free { background: transparent; }
.mem-bar.swap { height: 6px; margin-top: 6px; }
.mem-bar.swap .used { background: var(--warn); }
.mem-bar.alarm .used { background: var(--danger); }
.mem-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--muted); }
.mem-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.mem-legend .used i { background: var(--accent); }
.mem-legend .cache i { background: color-mix(in srgb, var(--accent) 35%, transparent); }
.mem-legend .free i { background: var(--neutral-bg); border: 1px solid var(--line); }
.mem-legend .swap i { background: var(--warn); }
.mem-sparks { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 10px 0 2px; font-size: 12px; color: var(--muted); }
.mem-sparks div { display: flex; align-items: center; gap: 8px; }
.mem-sparks .spark { width: 120px; height: 22px; }
.mem .spark .line { fill: none; stroke-width: 1.5; }
.mem .spark .area { stroke: none; opacity: .16; }
.mem .spark.avail .line { stroke: var(--ok); }
.mem .spark.avail .area { fill: var(--ok); }
.mem .spark.psi .line { stroke: var(--warn); }
.mem .spark.psi .area { fill: var(--warn); }
.mem-groups { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 2px; }
.mem-groups .chip { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--neutral-bg); }
.mem-groups .chip b { font-weight: 600; }
.mem-sugg { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.mem-sugg li { font-size: 13px; padding: 7px 10px; border-radius: 8px; background: var(--warn-bg); color: var(--text); }
.mem-sugg li a { margin-left: 6px; white-space: nowrap; }
.mem h4 { margin: 16px 0 6px; font-size: 13px; }
.mem h4 .muted { font-weight: 400; margin-left: 6px; }
.mem table { width: 100%; border-collapse: collapse; font-size: 13px; }
.mem th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 3px 6px; border-bottom: 1px solid var(--line); }
.mem td { padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.mem td.num, .mem th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.mem td .sub { display: block; font-size: 11px; color: var(--muted); }
.mem td .badge { margin-left: 6px; }
.mem .mem-more { margin-top: 6px; font-size: 12px; }
.mem .mem-note { font-size: 12px; color: var(--muted); margin: 12px 0 0; }
.mem .mem-wrap { overflow-x: auto; }
@media (max-width: 640px) { .mem .hide-sm { display: none; } }
`;

let view = null;
const showAll = { sessions: false, services: false };

const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
const size = (mb) => (mb >= 1024 ? gb(mb) : `${mb} MB`);
const hours = (sec) => (sec == null ? '' : sec >= 86400 ? t('memory.dayHour', { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) }) : sec >= 3600 ? t('time.hour', { n: Math.floor(sec / 3600) }) : t('time.min', { n: Math.max(1, Math.round(sec / 60)) }));
const idleText = (m) => (m == null ? '—' : m < 1 ? t('time.justNow') : m < 60 ? t('time.min', { n: m }) : m < 1440 ? t('time.hour', { n: Math.floor(m / 60) }) : t('time.day', { n: Math.floor(m / 1440) }));
const badge = (text, tone = '') => el('span', `badge${tone ? ` ${tone}` : ''}`, text);

function bar(parts, total, cls = '') {
  const b = el('div', `mem-bar ${cls}`);
  for (const [k, mb, title] of parts) {
    const s = el('span', k);
    s.style.width = `${total ? (mb / total) * 100 : 0}%`;
    s.title = title;
    b.append(s);
  }
  return b;
}

function head(v) {
  const m = v.mem;
  const p = v.pressure;
  const wrap = el('div', 'mem-head');
  wrap.append(el('strong', null, t('memory.available', { avail: gb(m.availableMb), total: gb(m.totalMb), pct: m.availablePct })));
  if (p.active) wrap.append(badge(t('memory.low', { reasons: p.reasonText.join(', ') }), 'warn'));
  else if (p.reasons.length && p.breachSince) wrap.append(badge(t('memory.lowFor', { min: Math.max(1, Math.round((Date.now() - p.breachSince) / 60000)), sustain: p.thresholds.sustainMin }), 'warn'));
  else wrap.append(badge(t('memory.ok'), 'ok'));
  wrap.append(el('span', 'muted', `${t('memory.swap', { pct: m.swapPct })}${m.swapTotalMb ? ` (${gb(m.swapUsedMb)} / ${gb(m.swapTotalMb)})` : ''}${v.psi ? ` · ${t('memory.psi', { a: v.psi.some.avg10, b: v.psi.some.avg60, c: v.psi.some.avg300 })}` : ''}`));
  return wrap;
}

function bars(v) {
  const m = v.mem;
  const low = v.pressure.active;
  const out = [
    bar([['used', m.usedMb, t('memory.used', { gb: gb(m.usedMb) })], ['cache', m.cacheMb, t('memory.cacheTitle', { gb: gb(m.cacheMb) })], ['free', m.freeMb, t('memory.free', { gb: gb(m.freeMb) })]], m.totalMb, low ? 'alarm' : ''),
  ];
  if (m.swapTotalMb) out.push(bar([['used', m.swapUsedMb, t('memory.swapUsed', { gb: gb(m.swapUsedMb) })]], m.swapTotalMb, 'swap'));
  const legend = el('div', 'mem-legend');
  const item = (cls, text) => {
    const s = el('span', cls);
    s.append(el('i'), text);
    return s;
  };
  legend.append(item('used', t('memory.used', { gb: gb(m.usedMb) })), item('cache', t('memory.cache', { gb: gb(m.cacheMb) })), item('free', t('memory.free', { gb: gb(m.freeMb) })));
  if (m.swapTotalMb) legend.append(item('swap', t('memory.swap', { pct: m.swapPct })));
  if (m.shmemMb > 1024) legend.append(el('span', null, t('memory.shmem', { gb: gb(m.shmemMb) })));
  out.push(legend);
  return out;
}

function sparks(v) {
  const hist = v.history ?? [];
  if (hist.length < 2) return null;
  const box = el('div', 'mem-sparks');
  const row = (label, vals, kind, scale, last) => {
    const d = el('div');
    d.append(el('span', null, label), sparkline(vals, { kind, scale, label }), el('span', null, last));
    return d;
  };
  const avail = hist.map((x) => x.availablePct);
  box.append(row(t('memory.spark.avail'), avail.map((x) => x / 100), 'avail', 1, `${avail.at(-1)}%`));
  const psi = hist.map((x) => x.psi60);
  if (psi.some((x) => x != null)) {
    const max = Math.max(10, ...psi.filter((x) => x != null));
    box.append(row(t('memory.spark.psi'), psi.map((x) => (x == null ? null : x / max)), 'psi', 1, `${psi.at(-1) ?? '—'}`));
  }
  box.append(el('span', null, t('memory.spark.span', { n: Math.round((hist.at(-1).t - hist[0].t) / 60000) })));
  return box;
}

function groups(v) {
  const box = el('div', 'mem-groups');
  for (const g of v.groups) {
    if (!g.mb) continue;
    const c = el('span', 'chip');
    c.append(el('b', null, g.label), ` ${size(g.mb)}`);
    c.title = t('memory.procs', { n: g.procs });
    box.append(c);
  }
  return box;
}

function suggestionList(v) {
  if (!v.suggestions.length) return null;
  const ul = el('ul', 'mem-sugg');
  for (const s of v.suggestions) {
    const li = el('li', null, s.text);
    if (s.href) li.append(h('a', { href: s.href, text: s.linkText ?? t('memory.sugg.view') }));
    ul.append(li);
  }
  return ul;
}

function table(cols, rows) {
  const tbl = el('table');
  const tr = el('tr');
  for (const [label, cls] of cols) tr.append(el('th', cls ?? null, label));
  tbl.append(h('thead', null, tr));
  const body = el('tbody');
  body.append(...rows);
  tbl.append(body);
  const wrap = el('div', 'mem-wrap');
  wrap.append(tbl);
  return wrap;
}

function td(content, cls) {
  const c = el('td', cls ?? null);
  c.append(...[content].flat().filter((x) => x != null));
  return c;
}

function sessionRows(v) {
  const list = showAll.sessions ? v.sessions : v.sessions.slice(0, 12);
  return list.map((s) => {
    const name = el('span', null, s.title ?? s.project ?? (s.id ? s.id.slice(0, 8) : `pid ${s.pid}`));
    const sub = el('span', 'sub', [s.title && s.project ? s.project : null, s.mcp.length ? `MCP ${s.mcp.join(', ')}` : null, s.helper ? t('memory.session.helper') : null].filter(Boolean).join(' · '));
    const ver = [el('span', null, s.version ?? '—')];
    if (s.stale) ver.push(badge(t('memory.session.stale'), 'warn'));
    const idle = [el('span', null, idleText(s.idleMin))];
    if (s.idle) idle.push(badge(t('memory.session.idle')));
    const tr = el('tr');
    tr.title = t('memory.session.title', { pid: s.pid, up: hours(s.uptimeSec), cpu: s.cpuPct != null ? ` · CPU ${s.cpuPct}%` : '', cli: s.breakdown.cli, mcp: s.breakdown.mcp, servers: s.breakdown.servers, tools: s.breakdown.tools });
    tr.append(td([name, sub]), td(ver, 'hide-sm'), td(idle), td(hours(s.uptimeSec), 'num hide-sm'), td([el('span', null, size(s.mb)), el('span', 'sub', s.breakdown.mcp ? `MCP ${size(s.breakdown.mcp)}` : null)], 'num'));
    return tr;
  });
}

function more(key, total, shown) {
  if (total <= shown && !showAll[key]) return null;
  const b = el('button', 'mem-more', showAll[key] ? t('memory.less') : t('memory.all', { n: total }));
  b.type = 'button';
  b.addEventListener('click', () => {
    showAll[key] = !showAll[key];
    paint();
  });
  return b;
}

function mcpRows(v) {
  const cli = v.sessions.filter((s) => !s.helper).length;
  return v.mcp.map((m) => {
    const name = [el('span', null, m.label)];
    if (m.instances >= 3 && m.sessions >= Math.max(3, cli / 2)) name.push(badge(t('memory.mcp.perSession')));
    if (m.orphans) name.push(badge(t('memory.mcp.orphans', { n: m.orphans }), 'warn'));
    const tr = el('tr');
    tr.title = `${t('memory.mcp.procs', { n: m.procs })} · ${t('memory.mcp.sessions', { n: m.sessions })}`;
    tr.append(td(name), td(String(m.instances), 'num'), td(size(Math.round(m.mb / Math.max(1, m.instances))), 'num hide-sm'), td(size(m.mb), 'num'));
    return tr;
  });
}

function serviceRows(v) {
  const list = showAll.services ? v.services : v.services.slice(0, 10);
  return list.map((s) => {
    const name = [el('span', null, s.name), el('span', 'sub', [s.ports.map((p) => `:${p}`).join(' '), s.session ? t('memory.svc.session', { id: s.session }) : null].filter(Boolean).join(' · '))];
    const kind = [el('span', null, s.dev ? t('memory.svc.dev') : t('memory.svc.service'))];
    if (s.dev && s.unused) kind.push(badge(t('memory.svc.unused')));
    const tr = el('tr');
    tr.append(td(name), td(kind, 'hide-sm'), td(hours(s.uptimeSec), 'num hide-sm'), td(size(s.mb), 'num'));
    return tr;
  });
}

function paint() {
  const box = $('memory');
  if (!box || !view) return;
  const v = view;
  const parts = [head(v), ...bars(v), sparks(v), groups(v), suggestionList(v)];

  parts.push(h('h4', null, t('memory.sessions.head', { n: v.sessions.length }), el('span', 'muted', `${t('memory.sessions.note')}${v.newestVersion ? ` · ${t('memory.sessions.newest', { v: v.newestVersion })}` : ''}`)));
  parts.push(table([[t('memory.col.session')], [t('memory.col.version'), 'hide-sm'], [t('memory.col.idle')], [t('memory.col.uptime'), 'num hide-sm'], [t('memory.col.mem'), 'num']], sessionRows(v)), more('sessions', v.sessions.length, 12));

  if (v.mcp.length) {
    parts.push(h('h4', null, t('memory.mcp.head'), el('span', 'muted', t('memory.mcp.note'))));
    parts.push(table([[t('memory.col.server')], [t('memory.col.count'), 'num'], [t('memory.col.each'), 'num hide-sm'], [t('memory.col.total'), 'num']], mcpRows(v)));
  }
  if (v.services.length) {
    parts.push(h('h4', null, t('memory.svc.head'), el('span', 'muted', t('memory.svc.note'))));
    parts.push(table([[t('memory.col.name')], [t('memory.col.kind'), 'hide-sm'], [t('memory.col.uptime'), 'num hide-sm'], [t('memory.col.mem'), 'num']], serviceRows(v)), more('services', v.services.length, 10));
  }
  const small = [...v.docker.slice(0, 6).map((d) => `${d.name} ${size(d.mb)}`)];
  if (small.length) parts.push(h('h4', null, t('memory.docker', { n: v.docker.length }), el('span', 'muted', small.join(' · '))));
  if (v.other.length) parts.push(h('h4', null, t('memory.other'), el('span', 'muted', v.other.slice(0, 8).map((o) => `${o.name}${o.count > 1 ? ` ×${o.count}` : ''} ${size(o.mb)}`).join(' · '))));

  const th = v.pressure.thresholds;
  parts.push(el('p', 'mem-note', t('memory.note', {
    every: v.sampleEverySec, ago: ago(v.at, { suffix: true, floor: true }) || t('time.justNow'),
    avail: th.availablePct, psi: th.psiSome60, swap: th.swapPct, sustain: th.sustainMin, reminder: th.reminderHours,
  })));

  box.replaceChildren(...parts.filter(Boolean));
  box.hidden = false;
  $('memoryH').hidden = false;
}

async function refresh() {
  const next = await tryJSON('/api/memory');
  if (!next) return;
  view = next;
  paint();
  if (location.hash === '#memory' && !scrolled) {
    scrolled = true;
    $('memory')?.scrollIntoView({ block: 'start' });
  }
}

let scrolled = false;

function init() {
  const self = $('self');
  if (!self || $('memory')) return;
  const style = el('style');
  style.textContent = STYLE;
  document.head.append(style);
  const heading = el('h3', 'sec-h', t('memory.title'));
  heading.id = 'memoryH';
  heading.hidden = true;
  const box = el('section', 'mem');
  box.id = 'memory';
  box.hidden = true;
  box.setAttribute('aria-label', t('memory.title'));
  self.after(heading, box);
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 60_000);
}

init();
