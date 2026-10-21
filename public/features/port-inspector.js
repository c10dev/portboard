// The 서비스 tab's inspector (lib/shell.js's right panel): everything about the selected port that the dense row leaves
// out — command, path, PID, unit/container, owner (features/owners.js fills .insp-owner), addresses and SSH, the
// uptime bars, who uses it and when it was last used, suggestions (features/suggestions.js decorates .insp-port like
// a row), the actions and a live tail of its logs (the logs dialog's fetch, every 15 s while it shows).
//
// ctx: the rows' ctx (features/ports.js) plus { shown(): the inspector is on screen }

import { portAlertBadge, portBell, portUptime } from './alerts.js';
import { controlText, fetchLogs, reachButtons, restartQuestion, stopQuestion } from './control.js';
import { lastUsedText, portBadges } from './ports.js';
import { ruleFacts } from './port-rules.js';
import { usingChip } from '../lib/badge.js';
import { button, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const TAIL_LINES = 40;
const TAIL_MS = 15_000;

/** [label, value] rows of 무엇인지 and 주소 for a port; empty values left out */
export function inspectorFacts(p) {
  const keep = (rows) => rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const procs = p.processes.flatMap((x, i) => {
    const n = p.processes.length > 1 ? ` ${i + 1}` : '';
    return [
      [`${t('ports.fact.command')}${n}`, x.cmdline],
      [`${t('ports.fact.path')}${n}`, x.cwd],
      [`PID${n}`, x.pid],
      [`systemd${n}`, x.unit && `${x.unit}${x.unitDescription ? ` — ${x.unitDescription}` : ''}`],
    ];
  });
  return {
    what: keep([
      ...procs,
      [t('ports.fact.container'), p.container],
      ['compose', p.composeProject],
      [t('ports.fact.group'), p.group ? `${p.group.name} (${p.group.ports.join(', ')})` : null],
      [t('ports.fact.control'), controlText(p.control)],
      [t('ports.fact.title'), p.probe?.title],
      [t('inspector.fact.system'), p.kind === 'system' ? (p.systemOwner ?? t('ports.meta.otherUser')) : null],
    ]),
    reach: keep([
      [t('ports.fact.address'), p.addresses.join(', ')],
      [t('ports.fact.directUrl'), p.urls.direct],
      ['Tailnet URL', p.urls.served],
      ['SSH', p.urls.ssh],
    ]),
  };
}

const facts = (rows) => h('dl', null, rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, String(v))]));
const section = (title, ...body) => h('section', { class: 'insp-sec' }, el('h3', null, title), ...body);

/** One logs section per port, kept across re-renders so the tail doesn't flash or lose its scroll */
let tail = null;

function logsSection(p) {
  if (tail?.port !== p.port) {
    clearInterval(tail?.timer);
    const pre = el('pre', null, t('common.loading'));
    const src = el('p', 'insp-src');
    const node = h('section', { class: 'insp-sec insp-logs' },
      h('div', { class: 'insp-logs-head' }, el('h3', null, t('inspector.logs', { n: TAIL_LINES })), h('button', { type: 'button', title: t('inspector.logs.reload'), onclick: () => load() }, '↻')),
      src, pre);
    const load = async () => {
      const r = await fetchLogs(p.port, TAIL_LINES);
      if (tail?.port !== p.port) return;
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      src.textContent = r.source;
      pre.textContent = r.text;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    };
    tail = { port: p.port, node, load, timer: null, shown: () => false };
    load();
    tail.timer = setInterval(() => { if (!document.hidden && tail.shown()) load(); }, TAIL_MS);
  }
  return tail.node;
}

/** Stop the tail (nothing selected, or a port without logs) */
function stopTail() {
  clearInterval(tail?.timer);
  tail = null;
}

/**
 * 한눈에: what the inspector shows while no port is selected, so the column is not empty. Counts over the ports the
 * list shows by default (listening, not system or hidden), and the watched ones that are down; missing: watched ports
 * nothing listens on that the snapshot doesn't have (alerts.js missingRows), down too.
 */
export function portsOverview(ports, usage, missing = 0) {
  const shown = ports.filter((p) => p.listening && p.visible);
  const n = (pred) => shown.filter(pred).length;
  const watched = ports.filter((p) => p.alert);
  const down = missing + watched.filter((p) => !p.listening || portAlertBadge(p)?.classList.contains('bad')).length;
  const nWatched = watched.length + missing;
  const rows = [
    [t('inspector.overview.ports'), shown.length],
    [t('inspector.overview.inUse'), usage ? n((p) => usage.byPort[p.port]?.length) : null],
    [t('inspector.overview.served'), n((p) => p.served)],
    [t('inspector.overview.local'), n((p) => p.scope === 'loopback' && !p.served)],
    [t('inspector.overview.watched'), nWatched ? `${nWatched}${down ? ` · ${t('inspector.overview.down', { n: down })}` : ''}` : 0],
  ].filter(([, v]) => v !== null);
  const list = facts(rows);
  if (down) list.lastElementChild.classList.add('bad');
  const node = section(t('inspector.overview'), list);
  node.classList.add('insp-overview');
  return node;
}

/** Fill the inspector: the selected port p (null: nothing selected / it went away) */
export function renderInspector(insp, p, ctx) {
  if (!insp) return;
  const body = insp.body;
  const scroll = body.scrollTop;
  const same = body.dataset.port === String(p?.port ?? '');
  if (!p) {
    stopTail();
    insp.setTitle(t('inspector.title'));
    delete body.dataset.port;
    body.replaceChildren(...[ctx.overview, el('p', 'insp-empty', ctx.emptyText ?? t('inspector.empty'))].filter(Boolean));
    return;
  }
  insp.setTitle(t('inspector.title.port', { port: p.port }));
  body.dataset.port = String(p.port);

  const proc = p.processes[0];
  const sub = [p.label ? p.detectedName : null, proc?.project, proc?.unit, p.composeProject && `compose · ${p.composeProject}`].filter(Boolean).join(' · ');
  const name = h('a', { class: 'name', href: `service.html#${p.port}`, title: t('inspector.page') }, p.name);
  const head = h('div', { class: 'insp-port' },
    h('div', { class: 'insp-title' }, el('span', 'port', String(p.port)), name, p.listening || p.alert ? portBell(p) : null),
    sub ? el('div', 'insp-sub', sub) : null,
    h('div', { class: 'badges' }, portBadges(p)));

  const busy = ctx.busy.has(p.port);
  const actions = h('div', { class: 'insp-actions' }, reachButtons(p, { busy, act: (kind) => ctx.act(p.port, kind) }));
  if (p.control) actions.append(button(t('inspector.logsButton'), () => ctx.openLogs(p)));
  if (p.canRestart) actions.append(button(t('control.restart'), () => ctx.confirmAct(p, 'restart', restartQuestion(p)), { disabled: busy, write: true }));
  if (p.canStop) actions.append(button(t('control.stop'), () => ctx.confirmAct(p, 'stop', stopQuestion(p)), { disabled: busy, danger: true, write: true }));
  actions.append(h('a', { class: 'btn', href: `service.html#${p.port}` }, t('inspector.page')));

  const { what, reach } = inspectorFacts(p);
  const parts = [head, actions];
  parts.push(section(t('inspector.sec.what'), facts(what), h('dl', { class: 'insp-owner' })));
  if (reach.length) parts.push(section(t('inspector.sec.reach'), facts(reach)));
  // 포트 규칙 (features/port-rules.js): which rules matched, and where the name and the new-port notice came from
  const rules = ruleFacts(p);
  if (rules.length) parts.push(section(t('inspector.sec.rules'), facts(rules), h('a', { class: 'muted', href: 'settings.html#port-rules' }, t('inspector.rules.edit'))));

  const up = portUptime(p);
  parts.push(section(t('inspector.sec.uptime'), up ?? el('p', 'muted', p.alert ? t('inspector.uptime.none') : t('inspector.uptime.off'))));

  const who = p.listening ? ctx.usage?.byPort[p.port] ?? [] : [];
  const last = lastUsedText(p.port, ctx.usage);
  const uses = h('ul', { class: 'insp-list' });
  if (who.length) uses.append(...who.map((u) => h('li', null, usingChip(u, { title: true }), el('span', 'muted', ` · ${t('inspector.connections', { n: u.connections })}`))));
  else uses.append(el('li', 'muted', t('inspector.users.none')));
  if (last) uses.append(el('li', 'muted', t('inspector.lastUsed', { last })));
  const h7 = ctx.usage?.history?.byPort[p.port];
  if (h7?.devices7d > 1) uses.append(el('li', 'muted', t('ports.devices7d', { n: h7.devices7d })));
  parts.push(section(t('inspector.sec.users'), uses));

  if (p.control) {
    const logs = logsSection(p);
    tail.shown = ctx.shown;
    parts.push(logs);
  } else {
    stopTail();
  }
  body.replaceChildren(...parts);
  if (same) body.scrollTop = scroll;
  else body.scrollTop = 0;
}
