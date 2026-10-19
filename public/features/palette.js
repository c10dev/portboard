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

export const KINDS = { cmd: '명령', port: '포트', device: '기기', worktree: '워크트리' };

export const VERBS = [
  { key: 'open', names: ['열기', 'open', 'browser'] },
  { key: 'detail', names: ['상세', 'detail', 'info'] },
  { key: 'logs', names: ['로그', 'logs'] },
  { key: 'pin', names: ['고정', 'pin', 'unpin'] },
  { key: 'alert', names: ['알림', 'alert', 'notify'] },
  { key: 'restart', names: ['재시작', 'restart'] },
  { key: 'stop', names: ['중지', 'stop', 'kill'] },
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
  if (url) add('open', '열기 ↗', () => window.open(url, '_blank', 'noopener'));
  add('detail', '상세', () => go(`service.html#${p.port}`));
  if (p.control) add('logs', '로그', () => (page.openLogs ? page.openLogs(p) : go(`service.html?logs#${p.port}`)));
  if (p.listening) {
    add('pin', p.pinned ? '고정 해제' : '고정', () => (page.savePrefs
      ? page.savePrefs(p.port, { pinned: !p.pinned })
      : write(post(`/api/ports/${p.port}/prefs`, { pinned: !p.pinned }), p.pinned ? '고정을 풀었어요' : '맨 위에 고정했어요', page)));
  }
  add('alert', p.alert ? '🔔 다운 알림 끄기' : '🔔 다운 알림 켜기', () => (page.savePrefs
    ? page.savePrefs(p.port, { alert: !p.alert })
    : write(setPortAlert(p.port, !p.alert), p.alert ? '다운 알림을 껐어요' : '다운 알림을 켰어요', page)));
  const ask = (kind, question) => {
    if (page.confirmAct) return page.confirmAct(p, kind, question);
    if (!window.confirm(question)) return;
    return portAction(p.port, kind, () => p.alert).then(() => page.refresh?.());
  };
  if (p.canRestart) add('restart', '재시작', () => ask('restart', restartQuestion(p)));
  if (p.canStop) add('stop', '중지', () => ask('stop', stopQuestion(p)), { danger: true });
  if (!url && p.urls.direct) add('copy', '주소 복사', () => copy(p.urls.direct.replace(/^tcp:\/\//, '')));
  const sub = [
    p.label ? p.detectedName : null,
    proc?.project,
    proc?.unit,
    p.container ? `docker: ${p.container}` : null,
    !p.listening ? '리스닝 없음' : p.kind === 'system' ? '시스템' : null,
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
  const actions = [{ key: 'detail', label: '상세', names: namesOf('detail'), run: () => (page.showDevice ? page.showDevice(d.id) : go(deviceHref(d.id))) }];
  const ip = d.tailscaleIps?.[0];
  if (ip) actions.push({ key: 'copy-ip', label: `${ip} 복사`, names: ['ip', '복사', 'copy'], run: () => copy(ip) });
  if (d.dnsName) actions.push({ key: 'copy-dns', label: `${d.dnsName} 복사`, names: ['복사', 'copy', 'dns'], run: () => copy(d.dnsName) });
  if (canWatchDevice({ kind: d.self ? 'self' : 'tailnet', pool: d.pool })) {
    const on = watched.has(d.id);
    actions.push({
      key: 'alert', label: on ? '🔔 오프라인 알림 끄기' : '🔔 오프라인 알림 켜기', names: namesOf('alert'),
      run: () => write(setDeviceAlert(d.id, !on), on ? '오프라인 알림을 껐어요' : '오프라인 알림을 켰어요', page),
    });
  }
  return {
    id: `device:${d.id}`,
    kind: 'device',
    weight: 15,
    title: d.name,
    sub: [d.self ? '이 서버' : null, d.os, d.self ? null : d.online ? '온라인' : '오프라인', ip, d.lanIps?.[0], d.pool ? `compute-pool ${d.pool.name}` : null].filter(Boolean).join(' · '),
    text: [d.id, d.dnsName, ...(d.tailscaleIps ?? []), ...(d.lanIps ?? []), d.pool?.name].filter(Boolean).join(' '),
    actions,
  };
}

function worktreeItem(repo, w, page) {
  const branch = w.branch ?? (w.detached ? '분리된 HEAD' : w.short);
  return {
    id: `worktree:${w.path}`,
    kind: 'worktree',
    title: w.main ? `${repo.name} · ${branch} (메인)` : `${repo.name} · ${branch}`,
    sub: [w.short, w.pr ? `PR #${w.pr.number}` : null, w.changes ? `변경 ${w.changes}` : null, w.removable ? '지울 수 있음' : null].filter(Boolean).join(' · '),
    text: [w.path, repo.path, w.pr?.number].filter(Boolean).join(' '),
    actions: [
      { key: 'detail', label: '개발 탭에서 보기', names: namesOf('detail'), run: () => (page.showWorktree ? page.showWorktree(w.path) : go(`dev.html#${encodeURIComponent(w.path)}`)) },
      { key: 'copy', label: '경로 복사', names: ['복사', 'copy', 'path'], run: () => copy(w.path) },
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
    id: `cmd:${id}`, kind: 'cmd', weight: 15, title: label, sub: file === here ? '지금 보는 탭' : null, text: names,
    actions: [{ key: 'go', label: '이동', run: () => go(href) }],
  });
  const out = [
    tab('services', '서비스 탭', './', 'index.html', 'services ports 포트'),
    tab('devices', '기기 탭', 'devices.html', 'devices.html', 'devices tailnet'),
    tab('dev', '개발 탭', 'dev.html', 'dev.html', 'dev worktrees git 워크트리 예약'),
    // 설정 is a modal over this page (features/settings-modal.js opens it on the hash)
    tab('settings', '설정', '#settings', 'settings.html', 'settings 설정 승인 코드 커넥터 approval code connector 쓰기 허용 기기 요약 알림 preferences'),
    ...SETTINGS_IDS.filter((id) => id !== 'start').map((id) => ({
      id: `cmd:settings:${id}`, kind: 'cmd', weight: 14, title: `설정 › ${SETTINGS_LABELS[id]}`, text: `settings 설정 ${id}`,
      actions: [{ key: 'go', label: '열기', run: () => go(settingsHash(id)) }],
    })),
    {
      id: 'cmd:refresh', kind: 'cmd', weight: 15, title: '새로고침', text: 'refresh reload 다시',
      actions: [{ key: 'go', label: '실행', run: () => (page.refresh ? page.refresh() : location.reload()) }],
    },
  ];
  if ($('alertsBtn')) {
    out.push({ id: 'cmd:alerts', kind: 'cmd', weight: 15, title: '다운 알림 보기', text: 'alerts 🔔 감시', actions: [{ key: 'go', label: '열기', run: () => $('alertsBtn').click() }] });
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
    placeholder: '포트, 기기, 워크트리, 명령 검색',
  });
}
