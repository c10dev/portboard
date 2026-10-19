// 기록 (#30): one audit entry (GET /api/audit) as a list row — when, what, on what, who, from where, and how it went.
// Used by service.html's 기록 section and the dashboard's 최근 기록 list (features/audit.js).

import { badge } from './badge.js';
import { el } from './dom.js';
import { when } from './time.js';

const ACTIONS = {
  'POST /api/ports/:port/restart': '재시작',
  'POST /api/ports/:port/stop': '중지',
  'POST /api/ports/:port/expose': 'tailnet 공개',
  'POST /api/ports/:port/unexpose': '공개 해제',
  'POST /api/ports/:port/prefs': '설정',
  'POST /api/cleanup': '서버 정리',
  'POST /api/worktrees/remove': '워크트리 삭제',
  'POST /api/worktrees/prune': '워크트리 기록 정리',
  'POST /api/reservations': '포트 예약',
  'POST /api/reservations/:port/release': '예약 해제',
  'POST /api/dev-servers/start': '개발 서버 시작',
  'POST /api/dev-servers/stop': '개발 서버 중지',
  'POST /api/alerts/test': '테스트 알림',
  'POST /api/devices/:device/alert': '기기 오프라인 알림',
  'POST /api/known-devices/ack': '새 기기 확인',
  'POST /api/known-devices/settings': '새 기기 알림 설정',
  'POST /api/clients/name': '기기 이름',
  'POST /api/digest': '요약 알림 설정',
  'POST /api/digest/send': '요약 지금 보내기',
  'POST /api/suggestions/:device/dismiss': '제안 무시',
  'POST /api/claude/session-end': 'Claude 세션 종료',
  'POST /api/claude/settings': '세션 종료 자동 정리 설정',
  'mcp expose_port': 'tailnet 공개',
  'mcp unexpose_port': '공개 해제',
  'mcp restart_service': '재시작',
  'mcp stop_service': '중지',
  'mcp name_device': '기기 이름',
  'mcp set_alert': '다운 알림',
  'mcp cleanup_servers': '서버 정리',
  'mcp remove_worktrees': '워크트리 삭제',
  'mcp reserve_port': '포트 예약',
  'mcp release_port': '예약 해제',
  'mcp start_dev_server': '개발 서버 시작',
  'mcp stop_dev_server': '개발 서버 중지',
  'mcp set_digest': '요약 알림 설정',
};
const FIELDS = { label: '이름', pinned: '고정', hidden: '숨김', alert: '다운 알림', time: '시각', name: '이름', note: '메모' };
const SOURCES = { serve: 'tailnet', loopback: '이 서버', direct: '직접 접속', mcp: 'MCP' };
const RESULTS = { ok: ['완료', 'ok'], denied: ['거부', 'bad'], error: ['실패', 'warn'] };

export const actionText = (e) => ACTIONS[e.route] ?? e.route;

const base = (p) => String(p).split('/').filter(Boolean).pop() ?? p;

/** The target in a few words: :port, ports, the folder, what was changed. */
export function targetText(t = {}, { port = true } = {}) {
  const out = [];
  if (port && t.port) out.push(`:${t.port}`);
  if (Array.isArray(t.ports) && t.ports.length) out.push(t.ports.map((p) => `:${p}`).join(' ') + (t.portsCount ? ` 외 ${t.portsCount - t.ports.length}개` : ''));
  if (t.device) out.push(t.device);
  if (t.key) out.push(t.key);
  if (t.path) out.push(base(t.path));
  if (t.repo) out.push(base(t.repo));
  if (Array.isArray(t.paths) && t.paths.length) out.push(`${t.pathsCount ?? t.paths.length}개: ${t.paths.slice(0, 3).map(base).join(', ')}${(t.pathsCount ?? t.paths.length) > 3 ? ' …' : ''}`);
  if (t.owner) out.push(t.owner);
  for (const k of ['pinned', 'hidden', 'alert', 'on']) if (typeof t[k] === 'boolean') out.push(`${FIELDS[k] ?? '켜기'} ${t[k] ? '켬' : '끔'}`);
  if (t.mode) out.push(t.mode);
  if (t.autoStop) out.push(t.autoStop);
  if (Array.isArray(t.fields) && t.fields.length) out.push(t.fields.map((f) => FIELDS[f] ?? f).join('·'));
  return out.join(' · ');
}

/** The device a serve/direct write came from: its name, or the address when tailscale didn't know it. */
export function deviceText(d) {
  if (!d?.addr) return '';
  return d.name ?? d.addr;
}

/** <li>: time, action, target, who · device · source, result (with the server's message as the title); a coalesced denial shows ×count */
export function auditRow(e, opts = {}) {
  const li = el('li', `audit-${e.result}`);
  const [rt, tone] = RESULTS[e.result] ?? [e.result, ''];
  const res = badge(e.count > 1 ? `${rt} ×${e.count}` : rt, tone);
  const since = e.count > 1 && e.since ? ` (${when(e.since)}부터 ${e.count}번)` : '';
  if (e.detail || since) res.title = `${e.detail ?? ''}${since}`;
  const target = targetText(e.target, opts);
  const dev = deviceText(e.device);
  // The direct caller's "who" already is its address
  const from = [e.who, dev && dev !== e.who ? dev : '', SOURCES[e.source] ?? e.source].filter(Boolean).join(' · ');
  const who = el('span', 'muted', from);
  if (e.device?.addr) who.title = [e.device.name, e.device.addr, e.device.id].filter(Boolean).join(' · ');
  li.append(el('time', null, when(e.at)), el('strong', null, actionText(e)), target ? el('span', 'audit-target', target) : '', who, res);
  return li;
}
