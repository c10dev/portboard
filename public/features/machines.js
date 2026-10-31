// 기기 tab · 머신 (machines): one card per machine work can run on (this one, each `portboard agent`, the cloud) from
// GET /api/machines (src/features/machines.ts): load bars, Claude Code sessions against maxSessions, checkouts with
// work in them, and how old the data is. A card opens a sheet with its sessions and checkouts; "어디서 돌릴까" opens
// features/where.js. Self-contained: the page only loads this script. Hidden when only this machine is listed.

import { tryJSON } from '../lib/api.js';
import { sheet } from '../lib/dialog.js';
import { $, dl, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { busyCheckouts, KIND_LABEL, loadPct, machineBits, machineTone, upstreamBadge } from '../lib/machines.js';
import { ago } from '../lib/time.js';
import { openWhere, VIA } from './where.js';

const REFRESH_MS = 60_000;
const REACH = { local: t('machines.reach.local'), agent: t('machines.reach.agent'), none: t('machines.reach.none') };

let machines = [];
let openName = null;

function mount() {
  if ($('machines')) return $('machines');
  const sec = h('section', { id: 'machines', class: 'machines', 'aria-label': t('machines.title'), hidden: true },
    h('div', { class: 'machines-head' },
      h('h3', { class: 'sec-h', text: t('machines.title') }),
      h('button', { type: 'button', class: 'machines-where', onclick: () => openWhere() }, t('where.open'))),
    h('div', { id: 'machineStrip', class: 'machine-strip' }));
  const anchor = $('status');
  if (anchor) anchor.after(sec);
  else document.querySelector('main')?.prepend(sec);
  document.body.append(h('aside', { id: 'machDetail', class: 'detail', hidden: true, 'aria-live': 'polite' },
    h('button', { type: 'button', class: 'detail-close', id: 'machDetailClose', 'aria-label': t('common.close') }, '×'),
    h('div', { id: 'machDetailBody' })));
  return sec;
}

const panel = () => sheet($('machDetail'), $('machDetailClose'), () => { openName = null; });
let detail = null;

/** A thin bar: label, then the fill at pct (null: no reading) */
function bar(label, pct) {
  const fill = el('span', `mbar-fill${pct != null && pct >= 90 ? ' hot' : ''}`);
  fill.style.width = `${pct ?? 0}%`;
  return h('div', { class: 'mbar', title: pct == null ? t('machines.noReading') : `${label} ${pct}%` },
    h('span', { class: 'mbar-label', text: label }),
    h('span', { class: 'mbar-track' }, fill),
    h('span', { class: 'mbar-val', text: pct == null ? '–' : `${pct}%` }));
}

function card(m) {
  const tone = machineTone(m);
  const { cpu, mem } = loadPct(m);
  const c = h('button', { type: 'button', class: `device machine ${tone}${m.reach === 'local' ? ' self' : ''}`, onclick: () => show(m.name) },
    h('div', { class: 'device-head' },
      el('span', 'dot'),
      el('strong', null, m.reach === 'local' ? t('machines.thisOne', { name: m.name }) : m.name),
      el('span', 'device-os', KIND_LABEL[m.kind] ?? m.kind)),
    m.load ? h('div', { class: 'mbars' }, bar('CPU', cpu), bar(t('machines.mem'), mem)) : null,
    el('div', 'device-line', machineBits(m).join(' · ')));
  c.title = [m.error ? `${t('machines.error')}: ${m.error}` : null, m.checkedAt ? t('machines.checked', { ago: ago(m.checkedAt, { suffix: true }) }) : null].filter(Boolean).join('\n');
  return c;
}

function paint() {
  const sec = mount();
  // only this machine and nothing else to compare with: the strip says nothing the page doesn't
  sec.hidden = machines.filter((m) => m.reach !== 'local').length === 0;
  $('machineStrip').replaceChildren(...machines.map(card));
  if (openName) show(openName, true);
}

/** One session; the cloud's are estimates from claude/* branches, so their minutes are since the last push */
function sessionRow(s, estimate = false) {
  const what = [s.worktree ?? s.project ?? '?', s.idle ? t('machines.session.idle') : t('machines.session.active'),
    s.idleMin != null ? (estimate ? t('machines.session.pushed', { n: s.idleMin }) : t('machines.session.quiet', { n: s.idleMin })) : null, s.cpuPct != null ? `CPU ${s.cpuPct}%` : null, s.mb != null ? `${s.mb} MB` : null];
  return h('li', {}, h('code', { text: s.id ?? '—' }), ' ', what.filter(Boolean).join(' · '));
}

function checkoutRow(w) {
  const up = upstreamBadge(w);
  const what = [w.dirty ? t('machines.dirty', { n: w.dirty }) : null, up ? up[2] : null, w.inUse ? t('machines.inUse') : null, w.claude ? 'Claude Code' : null,
    w.reservedPort ? `:${w.reservedPort}` : null, w.main ? t('machines.main') : null];
  return h('li', { class: (w.dirty ?? 0) > 0 || w.inUse ? 'busy' : null }, h('strong', { text: w.owner }), ' ', what.filter(Boolean).join(' · '), w.path ? h('div', { class: 'muted', text: w.path }) : null);
}

function show(name, keepScroll = false) {
  const m = machines.find((x) => x.name === name);
  if (!m) return;
  openName = name;
  detail ??= panel();
  detail.show(() => {
    const l = m.load;
    const body = $('machDetailBody');
    const busy = busyCheckouts(m);
    const rest = (m.worktrees ?? []).filter((w) => !busy.includes(w));
    body.replaceChildren(...[
      el('div', 'd-kicker', `${KIND_LABEL[m.kind] ?? m.kind} · ${REACH[m.reach] ?? m.reach}`),
      el('h3', 'd-title', m.name),
      dl([
        [t('machines.d.state'), m.kind === 'cloud' ? machineBits(m).join(' · ') : m.online ? (m.stale ? t('machines.d.stale') : t('machines.d.online')) : t('machines.offline')],
        [t('machines.d.checked'), m.checkedAt ? ago(m.checkedAt, { suffix: true }) : null],
        [t('machines.d.error'), m.error],
        [t('machines.d.load'), l ? `${l.load1} / ${l.cores}` : null],
        [t('machines.d.mem'), l?.memTotalMb ? `${Math.round((l.memAvailMb ?? 0) / 1024)} / ${Math.round(l.memTotalMb / 1024)} GB ${t('machines.d.free')}` : null],
        [t('machines.d.disk'), l?.diskFreePct != null ? `${l.diskFreePct}% ${t('machines.d.free')}` : null],
        [t('machines.d.sessions'), m.claude ? `${m.claude.active}${m.maxSessions ? ` / ${m.maxSessions}` : ''} (${t('machines.idle', { n: m.claude.idle })})${m.claude.cliVersion ? ` · CLI ${m.claude.cliVersion}` : ''}` : null],
        [t('machines.d.ports'), m.ports ? t('machines.d.portsVal', { listening: m.ports.listening, dev: m.ports.devServers }) : null],
        [t('machines.d.caps'), m.capabilities.join(', ')],
        [t('machines.d.launch'), m.launch.map((x) => VIA[x.via] ?? x.via).join(', ')],
      ]),
      m.claude?.sessions.length ? h('div', { class: 'd-use' }, h('div', { class: 'd-use-h' }, h('strong', { text: t('machines.d.sessionList') })), h('ul', { class: 'mach-list' }, m.claude.sessions.map((x) => sessionRow(x, m.claude.source === 'github')))) : null,
      m.claude?.source === 'github' ? el('p', 'muted', t('machines.cloud.note')) : null,
      m.worktrees ? h('div', { class: 'd-use' },
        h('div', { class: 'd-use-h' }, h('strong', { text: t('machines.d.checkouts', { n: m.worktrees.length }) })),
        h('ul', { class: 'mach-list' }, [...busy, ...rest].slice(0, 40).map(checkoutRow)),
        m.worktrees.length > 40 ? el('p', 'muted', t('machines.d.more', { n: m.worktrees.length - 40 })) : null) : null,
      h('button', { type: 'button', class: 'name-btn', onclick: () => openWhere() }, t('where.open')),
    ].filter(Boolean));
  }, keepScroll);
}

async function refresh() {
  const doc = await tryJSON('/api/machines');
  if (!doc?.machines) return;
  machines = doc.machines;
  paint();
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
