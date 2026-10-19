// The command palette's Portboard side (c10dev/portboard#35): what it lists and what each item can do. The dialog,
// matching and keys are lib/palette.js; this file has no src/features/ twin, it only reads the existing GET APIs
// (/api/ports, /api/devices, /api/worktrees, /api/alerts) when the palette opens.
//
// The actions are the ones the pages already have: 열기 and the restart/stop questions from features/control.js,
// 🔔 from features/alerts.js, ★ is the same prefs POST as the row's ☆. A page passes hooks so an action on its own
// data goes through its own code (busy state, re-render); without one, the action navigates or POSTs and refreshes.
//
// page: { refresh(), openLogs(p), act(port, kind), confirmAct(p, kind, question), savePrefs(port, patch),
//         showDevice(id), showWorktree(path) } — all optional.

import { canWatchDevice, setDeviceAlert, setPortAlert } from './alerts.js';
import { controlText, openUrlOf, portAction, restartQuestion, stopQuestion } from './control.js';
import { haystack } from './ports.js';
import { errorText, post, tryJSON } from '../lib/api.js';
import { deviceHref } from '../lib/badge.js';
import { $ } from '../lib/dom.js';
import { paletteEntries } from '../lib/keys.js';
import { initPalette } from '../lib/palette.js';
import { settingsHash, SETTINGS_IDS, SETTINGS_LABELS } from '../lib/settings-route.js';
import { copy, toast } from '../lib/toast.js';
import { t } from '../lib/i18n.js';

export const KINDS = { cmd: t('palette.kind.cmd'), port: t('palette.kind.port'), device: t('palette.kind.device'), worktree: t('palette.kind.worktree') };

export const VERBS = [
  { key: 'open', names: [t('palette.verb.open'), 'open', 'browser'] },
  { key: 'detail', names: [t('palette.verb.detail'), 'detail', 'info'] },
  { key: 'logs', names: [t('palette.verb.logs'), 'logs'] },
  { key: 'pin', names: [t('palette.verb.pin'), 'pin', 'unpin'] },
  { key: 'alert', names: [t('palette.verb.alert'), 'alert', 'notify'] },
  { key: 'restart', names: [t('palette.verb.restart'), 'restart'] },
  { key: 'stop', names: [t('palette.verb.stop'), 'stop', 'kill'] },
];
const namesOf = (key) => VERBS.find((v) => v.key === key)?.names;

const go = (href) => { location.href = href; };

/** POST, toast how it went, then let the page reload */
async function write(promise, done, page) {
  try {
    const r = await promise;
    toast(r.ok ? done : errorText(r), !r.ok);
  } catch (err) {
    toast(err.message, true);
  }
  await page.refresh?.();
}

function portItem(p, page) {
  const proc = p.processes[0];
  const url = openUrlOf(p);
  const actions = [];
  const add = (key, label, run, extra = {}) => actions.push({ key, label, run, names: namesOf(key), ...extra });
  if (url) add('open', t('palette.act.open'), () => window.open(url, '_blank', 'noopener'));
  add('detail', t('palette.act.detail'), () => go(`service.html#${p.port}`));
  if (p.control) add('logs', t('palette.act.logs'), () => (page.openLogs ? page.openLogs(p) : go(`service.html?logs#${p.port}`)));
  if (p.listening) {
    add('pin', p.pinned ? t('palette.act.unpin') : t('palette.act.pin'), () => (page.savePrefs
      ? page.savePrefs(p.port, { pinned: !p.pinned })
      : write(post(`/api/ports/${p.port}/prefs`, { pinned: !p.pinned }), p.pinned ? t('palette.act.unpinned') : t('palette.act.pinned'), page)));
  }
  add('alert', p.alert ? t('palette.act.alertOff') : t('palette.act.alertOn'), () => (page.savePrefs
    ? page.savePrefs(p.port, { alert: !p.alert })
    : write(setPortAlert(p.port, !p.alert), p.alert ? t('palette.act.alertWasOff') : t('palette.act.alertWasOn'), page)));
  const ask = (kind, question) => {
    if (page.confirmAct) return page.confirmAct(p, kind, question);
    if (!window.confirm(question)) return;
    return portAction(p.port, kind, () => p.alert).then(() => page.refresh?.());
  };
  if (p.canRestart) add('restart', t('palette.act.restart'), () => ask('restart', restartQuestion(p)));
  if (p.canStop) add('stop', t('palette.act.stop'), () => ask('stop', stopQuestion(p)), { danger: true });
  if (!url && p.urls.direct) add('copy', t('palette.act.copyAddr'), () => copy(p.urls.direct.replace(/^tcp:\/\//, '')));
  const sub = [
    p.label ? p.detectedName : null,
    proc?.project,
    proc?.unit,
    p.container ? `docker: ${p.container}` : null,
    !p.listening ? t('nav.notListening') : p.kind === 'system' ? t('palette.system') : null,
    p.pinned ? '★' : null,
    p.alert ? '🔔' : null,
  ].filter(Boolean).join(' · ');
  return {
    id: `port:${p.port}`,
    kind: 'port',
    weight: p.visible ? 30 : 0,
    title: `${p.port} ${p.name}`,
    sub,
    text: [haystack(p, null), p.label, p.composeProject, controlText(p.control)].filter(Boolean).join(' '),
    actions,
  };
}

function deviceItem(d, watched, page) {
  const actions = [{ key: 'detail', label: t('palette.act.detail'), names: namesOf('detail'), run: () => (page.showDevice ? page.showDevice(d.id) : go(deviceHref(d.id))) }];
  const ip = d.tailscaleIps?.[0];
  if (ip) actions.push({ key: 'copy-ip', label: t('palette.act.copy', { value: ip }), names: ['ip', t('palette.verb.copy'), 'copy'], run: () => copy(ip) });
  if (d.dnsName) actions.push({ key: 'copy-dns', label: t('palette.act.copy', { value: d.dnsName }), names: [t('palette.verb.copy'), 'copy', 'dns'], run: () => copy(d.dnsName) });
  if (canWatchDevice({ kind: d.self ? 'self' : 'tailnet', pool: d.pool })) {
    const on = watched.has(d.id);
    actions.push({
      key: 'alert', label: on ? t('palette.act.offlineOff') : t('palette.act.offlineOn'), names: namesOf('alert'),
      run: () => write(setDeviceAlert(d.id, !on), on ? t('palette.act.offlineWasOff') : t('palette.act.offlineWasOn'), page),
    });
  }
  return {
    id: `device:${d.id}`,
    kind: 'device',
    weight: 15,
    title: d.name,
    sub: [d.self ? t('common.thisServer') : null, d.os, d.self ? null : d.online ? t('nav.online') : t('nav.offline'), ip, d.lanIps?.[0], d.pool ? `compute-pool ${d.pool.name}` : null].filter(Boolean).join(' · '),
    text: [d.id, d.dnsName, ...(d.tailscaleIps ?? []), ...(d.lanIps ?? []), d.pool?.name].filter(Boolean).join(' '),
    actions,
  };
}

function worktreeItem(repo, w, page) {
  const branch = w.branch ?? (w.detached ? t('dev.detached') : w.short);
  return {
    id: `worktree:${w.path}`,
    kind: 'worktree',
    title: w.main ? t('palette.wt.main', { repo: repo.name, branch }) : `${repo.name} · ${branch}`,
    sub: [w.short, w.pr ? `PR #${w.pr.number}` : null, w.changes ? t('dev.changes', { n: w.changes }) : null, w.removable ? t('dev.removable') : null].filter(Boolean).join(' · '),
    text: [w.path, repo.path, w.pr?.number].filter(Boolean).join(' '),
    actions: [
      { key: 'detail', label: t('palette.act.inDev'), names: namesOf('detail'), run: () => (page.showWorktree ? page.showWorktree(w.path) : go(`dev.html#${encodeURIComponent(w.path)}`)) },
      { key: 'copy', label: t('palette.act.copyPath'), names: [t('palette.verb.copy'), 'copy', 'path'], run: () => copy(w.path) },
    ],
  };
}

/** Items from the four GET answers (each may be null when it failed); pure, so the tests can build them */
export function paletteItems({ ports, devices, worktrees, alerts }, page = {}) {
  const out = [];
  // shown ports first (pinned on top, as on the 서비스 tab), then system / hidden / not listening
  const ps = [...(ports?.ports ?? [])].sort((a, b) => Number(b.visible) - Number(a.visible) || Number(b.pinned) - Number(a.pinned) || a.port - b.port);
  out.push(...ps.map((p) => portItem(p, page)));
  const watched = new Set((alerts?.watching ?? []).filter((w) => w.kind === 'device').map((w) => w.id));
  out.push(...(devices?.devices ?? []).map((d) => deviceItem(d, watched, page)));
  for (const repo of worktrees?.repos ?? []) out.push(...repo.worktrees.map((w) => worktreeItem(repo, w, page)));
  return out;
}

/** Tabs, 새로고침, the 🔔 dialog and the shell's actions from lib/keys.js (with their keys): there without a fetch */
export function paletteCommands(page = {}) {
  const here = location.pathname.split('/').pop() || 'index.html';
  const tab = (id, label, href, file, names) => ({
    id: `cmd:${id}`, kind: 'cmd', weight: 15, title: label, sub: file === here ? t('palette.here') : null, text: names,
    actions: [{ key: 'go', label: t('palette.act.go'), run: () => go(href) }],
  });
  const out = [
    tab('services', t('palette.tab.services'), './', 'index.html', t('palette.find.services')),
    tab('devices', t('palette.tab.devices'), 'devices.html', 'devices.html', 'devices tailnet'),
    tab('dev', t('palette.tab.dev'), 'dev.html', 'dev.html', t('palette.find.dev')),
    // 설정 is a modal over this page (features/settings-modal.js opens it on the hash)
    tab('settings', t('shell.view.settings'), '#settings', 'settings.html', t('palette.find.settings')),
    ...SETTINGS_IDS.filter((id) => id !== 'start').map((id) => ({
      id: `cmd:settings:${id}`, kind: 'cmd', weight: 14, title: t('palette.settingsSection', { section: SETTINGS_LABELS[id] }), text: t('palette.find.settingsSection', { id }),
      actions: [{ key: 'go', label: t('palette.act.show'), run: () => go(settingsHash(id)) }],
    })),
    {
      id: 'cmd:refresh', kind: 'cmd', weight: 15, title: t('common.refresh'), text: t('palette.find.refresh'),
      actions: [{ key: 'go', label: t('palette.act.run'), run: () => (page.refresh ? page.refresh() : location.reload()) }],
    },
  ];
  if ($('alertsBtn')) {
    out.push({ id: 'cmd:alerts', kind: 'cmd', weight: 15, title: t('palette.alerts'), text: t('palette.find.alerts'), actions: [{ key: 'go', label: t('palette.act.show'), run: () => $('alertsBtn').click() }] });
  }
  out.push(...paletteEntries(document));
  return out;
}

async function loadAll() {
  const [ports, devices, worktrees, alerts] = await Promise.all(['/api/ports', '/api/devices', '/api/worktrees', '/api/alerts'].map(tryJSON));
  return { ports, devices, worktrees, alerts };
}

/** Wire ⌘K on this page. Returns lib/palette.js's { open, close, invalidate }. */
export function initCommandPalette(page = {}) {
  return initPalette({
    commands: () => paletteCommands(page),
    load: async () => paletteItems(await loadAll(), page),
    kinds: KINDS,
    verbs: VERBS,
    placeholder: t('palette.search'),
  });
}
