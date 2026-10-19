// The 서비스 tab's inspector (lib/shell.js's right panel): everything about the selected port that the dense row leaves
// out — command, path, PID, unit/container, owner (features/owners.js fills .insp-owner), addresses and SSH, the
// uptime bars, who uses it and when it was last used, suggestions (features/suggestions.js decorates .insp-port like
// a row), the actions and a live tail of its logs (the logs dialog's fetch, every 15 s while it shows).
//
// ctx: the rows' ctx (features/ports.js) plus { shown(): the inspector is on screen }

import { portBell, portUptime } from './alerts.js';
import { controlText, fetchLogs, reachButtons, restartQuestion, stopQuestion } from './control.js';
import { lastUsedText, portBadges } from './ports.js';
import { ruleFacts } from './port-rules.js';
import { usingChip } from '../lib/badge.js';
import { button, el, h } from '../lib/dom.js';

const TAIL_LINES = 40;
const TAIL_MS = 15_000;

/** [label, value] rows of 무엇인지 and 주소 for a port; empty values left out */
export function inspectorFacts(p) {
  const keep = (rows) => rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const procs = p.processes.flatMap((x, i) => {
    const n = p.processes.length > 1 ? ` ${i + 1}` : '';
    return [
      [`명령${n}`, x.cmdline],
      [`경로${n}`, x.cwd],
      [`PID${n}`, x.pid],
      [`systemd${n}`, x.unit && `${x.unit}${x.unitDescription ? ` — ${x.unitDescription}` : ''}`],
    ];
  });
  return {
    what: keep([
      ...procs,
      ['컨테이너', p.container],
      ['compose', p.composeProject],
      ['묶음', p.group ? `${p.group.name} (${p.group.ports.join(', ')})` : null],
      ['제어', controlText(p.control)],
      ['페이지 제목', p.probe?.title],
      ['시스템', p.kind === 'system' ? (p.systemOwner ?? '다른 사용자/시스템 프로세스') : null],
    ]),
    reach: keep([
      ['주소', p.addresses.join(', ')],
      ['직접 URL', p.urls.direct],
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
    const pre = el('pre', null, '불러오는 중…');
    const src = el('p', 'insp-src');
    const node = h('section', { class: 'insp-sec insp-logs' },
      h('div', { class: 'insp-logs-head' }, el('h3', null, `로그 · 마지막 ${TAIL_LINES}줄`), h('button', { type: 'button', title: '다시 읽기', onclick: () => load() }, '↻')),
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

/** Fill the inspector: the selected port p (null: nothing selected / it went away) */
export function renderInspector(insp, p, ctx) {
  if (!insp) return;
  const body = insp.body;
  const scroll = body.scrollTop;
  const same = body.dataset.port === String(p?.port ?? '');
  if (!p) {
    stopTail();
    insp.setTitle('상세');
    delete body.dataset.port;
    body.replaceChildren(el('p', 'insp-empty', ctx.emptyText ?? '포트를 고르면 여기에 상세가 나와요. ↑↓로 옮겨 다닐 수 있어요.'));
    return;
  }
  insp.setTitle(`${p.port} 상세`);
  body.dataset.port = String(p.port);

  const proc = p.processes[0];
  const sub = [p.label ? p.detectedName : null, proc?.project, proc?.unit, p.composeProject && `compose · ${p.composeProject}`].filter(Boolean).join(' · ');
  const name = h('a', { class: 'name', href: `service.html#${p.port}`, title: '상세 페이지' }, p.name);
  const head = h('div', { class: 'insp-port' },
    h('div', { class: 'insp-title' }, el('span', 'port', String(p.port)), name, p.listening || p.alert ? portBell(p) : null),
    sub ? el('div', 'insp-sub', sub) : null,
    h('div', { class: 'badges' }, portBadges(p)));

  const busy = ctx.busy.has(p.port);
  const actions = h('div', { class: 'insp-actions' }, reachButtons(p, { busy, act: (kind) => ctx.act(p.port, kind) }));
  if (p.control) actions.append(button('로그', () => ctx.openLogs(p)));
  if (p.canRestart) actions.append(button('재시작', () => ctx.confirmAct(p, 'restart', restartQuestion(p)), { disabled: busy, write: true }));
  if (p.canStop) actions.append(button('중지', () => ctx.confirmAct(p, 'stop', stopQuestion(p)), { disabled: busy, danger: true, write: true }));
  actions.append(h('a', { class: 'btn', href: `service.html#${p.port}` }, '상세 페이지'));

  const { what, reach } = inspectorFacts(p);
  const parts = [head, actions];
  parts.push(section('무엇인지', facts(what), h('dl', { class: 'insp-owner' })));
  if (reach.length) parts.push(section('주소', facts(reach)));
  // 포트 규칙 (features/port-rules.js): which rules matched, and where the name and the new-port notice came from
  const rules = ruleFacts(p);
  if (rules.length) parts.push(section('규칙', facts(rules), h('a', { class: 'muted', href: 'settings.html#port-rules' }, '설정 › 포트 규칙에서 바꾸기')));

  const up = portUptime(p);
  parts.push(section('업/다운', up ?? el('p', 'muted', p.alert ? '아직 확인한 기록이 없어요.' : '🔔 다운 알림을 켜면 업타임이 쌓여요.')));

  const who = p.listening ? ctx.usage?.byPort[p.port] ?? [] : [];
  const last = lastUsedText(p.port, ctx.usage);
  const uses = h('ul', { class: 'insp-list' });
  if (who.length) uses.append(...who.map((u) => h('li', null, usingChip(u, { title: true }), el('span', 'muted', ` · 연결 ${u.connections}`))));
  else uses.append(el('li', 'muted', '지금 연결한 기기나 프로세스가 없어요.'));
  if (last) uses.append(el('li', 'muted', `마지막 사용: ${last}`));
  const h7 = ctx.usage?.history?.byPort[p.port];
  if (h7?.devices7d > 1) uses.append(el('li', 'muted', `최근 7일 기기 ${h7.devices7d}대`));
  parts.push(section('누가 쓰나', uses));

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
