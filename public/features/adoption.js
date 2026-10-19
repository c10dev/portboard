// 개발 tab: "Claude 세션 포트 사용" (GET /api/adoption, src/features/adoption.ts, c10dev/portboard#40) — this week vs
// last week of how Claude Code sessions handled ports: Portboard MCP calls against raw ss/lsof, kill-by-port and
// servers started on a hard-coded port. Self-contained like digest.js: its own section and style.

import { tryJSON } from '../lib/api.js';
import { $, el, h } from '../lib/dom.js';
import { t, tn } from '../lib/i18n.js';
import { ago } from '../lib/time.js';

const STYLE = `
.adopt { margin: 0 0 22px; }
.adopt h3 { margin: 0 0 4px; font-size: 15px; }
.adopt table { border-collapse: collapse; font-size: 13px; margin: 6px 0 8px; min-width: min(100%, 420px); }
.adopt th, .adopt td { padding: 4px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
.adopt th:first-child, .adopt td:first-child { text-align: left; padding-left: 0; }
.adopt thead th { color: var(--muted); font-weight: 500; font-size: 12px; }
.adopt td.num { font-variant-numeric: tabular-nums; }
.adopt .good { color: var(--ok); }
.adopt .bad { color: var(--danger); }
.adopt .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 16px; vertical-align: middle; }
.adopt .bars i { display: block; width: 5px; background: var(--muted); opacity: .55; border-radius: 1px; min-height: 1px; }
.adopt .more-line { color: var(--muted); font-size: 12px; margin: 2px 0; }
.adopt .more-line code { color: var(--text); }
.adopt-wrap { overflow-x: auto; }
`;

// [key, label, better when it goes up?]
const ROWS = [
  ['sessions', t('adoption.row.sessions'), null],
  ['mcp', t('adoption.row.mcp'), true],
  ['inspect', t('adoption.row.inspect'), false],
  ['kill', t('adoption.row.kill'), false],
  ['hardcoded', t('adoption.row.hardcoded'), false],
  ['nudges', t('adoption.row.nudges'), null],
  ['followed', t('adoption.row.followed'), true],
];

function bars(byDay, key) {
  const max = Math.max(1, ...byDay.map((d) => d[key]));
  const box = el('span', 'bars');
  box.title = byDay.map((d) => `${d.day.slice(5)} ${d[key]}`).join('\n');
  for (const d of byDay) {
    const i = el('i');
    i.style.height = `${Math.round((d[key] / max) * 16)}px`;
    box.append(i);
  }
  return box;
}

function change(cur, prev, upIsGood) {
  if (prev === undefined) return el('td', 'num', '');
  const d = cur - prev;
  const td = el('td', 'num', d === 0 ? '–' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`);
  if (d !== 0 && upIsGood !== null) td.classList.add((d > 0) === upIsGood ? 'good' : 'bad');
  return td;
}

function render(box, doc) {
  box.replaceChildren(h('h3', {}, t('adoption.title')));
  const help = el('p', 'wt-help');
  help.append(...tn('adoption.help'));
  box.append(help);
  const cur = doc?.current;
  if (!cur) {
    box.append(el('p', 'more-line', doc?.scanning ? t('adoption.scanning') : t('adoption.notYet')));
    return;
  }
  const prev = doc.previous?.totals;
  const table = h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('adoption.thisWeek', { from: cur.from.slice(5), to: cur.to.slice(5) })), h('th', {}, t('adoption.lastWeek')), h('th', {}, t('adoption.change')), h('th', {}, t('adoption.daily')))),
  );
  const body = el('tbody');
  for (const [key, label, upIsGood] of ROWS) {
    if ((key === 'nudges' || key === 'followed') && !cur.totals.nudges && !prev?.nudges) continue;
    body.append(h('tr', {}, h('td', {}, label), el('td', 'num', String(cur.totals[key])), el('td', 'num', prev ? String(prev[key]) : '–'), change(cur.totals[key], prev?.[key], upIsGood), h('td', {}, bars(cur.byDay, key))));
  }
  table.append(body);
  box.append(h('div', { class: 'adopt-wrap' }, table));

  if (cur.topPorts.length) {
    const p = el('p', 'more-line', t('adoption.topPorts'));
    cur.topPorts.slice(0, 6).forEach((x, i) => {
      if (i) p.append(' · ');
      const c = h('code', { title: t('adoption.portTitle', { start: x.start, inspect: x.inspect, kill: x.kill }) }, String(x.port));
      p.append(c, ` ${x.total}`);
    });
    box.append(p);
  }
  const projects = cur.byProject.filter((x) => x.mcp || x.inspect || x.kill || x.hardcoded).slice(0, 5);
  if (projects.length) {
    box.append(el('p', 'more-line', t('adoption.byProject', { list: projects.map((x) => `${x.project} ${x.mcp}/${x.inspect + x.kill}/${x.hardcoded}`).join(' · ') })));
  }
  const files = doc.files ? ` · ${t('adoption.files', { n: doc.files.read, mb: Math.round(doc.files.bytes / 1e6) })}` : '';
  box.append(el('p', 'more-line', `${t('adoption.scannedAt', { when: ago(doc.at, { suffix: true }) || t('time.justNow') })}${files}${doc.scanning ? ` · ${t('adoption.rescanning')}` : ''}`));
}

async function load(box, tries = 0) {
  const doc = await tryJSON('/api/adoption');
  render(box, doc);
  // while a scan runs, and right after a start, before the job's first scan has begun (about 2 minutes at most)
  if (doc && (doc.scanning || doc.at === null) && tries < 24) setTimeout(() => load(box, tries + 1), 5000);
}

function init() {
  if ($('adoption')) return;
  if (!$('adoptionStyle')) document.head.append(h('style', { id: 'adoptionStyle', text: STYLE }));
  const box = h('section', { id: 'adoption', class: 'adopt', 'aria-label': t('adoption.title') });
  const anchor = document.querySelector('main .resv') ?? document.querySelector('main .wt-h');
  if (anchor) anchor.before(box);
  else document.querySelector('main')?.append(box);
  load(box);
}

init();
