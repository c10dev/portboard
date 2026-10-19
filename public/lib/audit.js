// 기록 (#30): one audit entry (GET /api/audit) as a list row — when, what, on what, who, from where, and how it went.
// Used by service.html's 기록 section and the dashboard's 최근 기록 list (features/audit.js).

import { badge } from './badge.js';
import { el } from './dom.js';
import { t } from './i18n.js';
import { when } from './time.js';

const ACTIONS = {
  'POST /api/ports/:port/restart': 'audit.action.restart',
  'POST /api/ports/:port/stop': 'audit.action.stop',
  'POST /api/ports/:port/expose': 'audit.action.expose',
  'POST /api/ports/:port/unexpose': 'audit.action.unexpose',
  'POST /api/ports/:port/prefs': 'audit.action.prefs',
  'POST /api/cleanup': 'audit.action.cleanup',
  'POST /api/worktrees/remove': 'audit.action.worktreeRemove',
  'POST /api/worktrees/prune': 'audit.action.worktreePrune',
  'POST /api/reservations': 'audit.action.reserve',
  'POST /api/reservations/:port/release': 'audit.action.release',
  'POST /api/dev-servers/start': 'audit.action.devStart',
  'POST /api/dev-servers/stop': 'audit.action.devStop',
  'POST /api/alerts/test': 'audit.action.alertTest',
  'POST /api/devices/:device/alert': 'audit.action.deviceAlert',
  'POST /api/known-devices/ack': 'audit.action.newDeviceAck',
  'POST /api/known-devices/settings': 'audit.action.newDeviceSettings',
  'POST /api/clients/name': 'audit.action.deviceName',
  'POST /api/digest': 'audit.action.digest',
  'POST /api/digest/send': 'audit.action.digestSend',
  'POST /api/suggestions/:device/dismiss': 'audit.action.suggestionDismiss',
  'POST /api/claude/session-end': 'audit.action.claudeSessionEnd',
  'POST /api/claude/settings': 'audit.action.claudeSettings',
  'mcp expose_port': 'audit.action.expose',
  'mcp unexpose_port': 'audit.action.unexpose',
  'mcp restart_service': 'audit.action.restart',
  'mcp stop_service': 'audit.action.stop',
  'mcp name_device': 'audit.action.deviceName',
  'mcp set_alert': 'audit.action.alert',
  'mcp cleanup_servers': 'audit.action.cleanup',
  'mcp remove_worktrees': 'audit.action.worktreeRemove',
  'mcp reserve_port': 'audit.action.reserve',
  'mcp release_port': 'audit.action.release',
  'mcp start_dev_server': 'audit.action.devStart',
  'mcp stop_dev_server': 'audit.action.devStop',
  'mcp set_digest': 'audit.action.digest',
};
const FIELDS = { label: 'audit.field.name', pinned: 'audit.field.pinned', hidden: 'audit.field.hidden', alert: 'audit.field.alert', time: 'audit.field.time', name: 'audit.field.name', note: 'audit.field.note' };
const SOURCES = { serve: 'tailnet', loopback: t('audit.source.loopback'), direct: t('audit.source.direct'), mcp: 'MCP' };
const RESULTS = { ok: ['audit.result.ok', 'ok'], denied: ['audit.result.denied', 'bad'], error: ['audit.result.error', 'warn'] };

const field = (k) => (FIELDS[k] ? t(FIELDS[k]) : k);
/** "고정 켬" / "Pinned on"; the bare `on` switch has no field name */
const toggle = (k, on) => (k === 'on' ? t(on ? 'audit.toggle.on' : 'audit.toggle.off') : t(on ? 'audit.toggle.fieldOn' : 'audit.toggle.fieldOff', { field: field(k) }));

// targetText's own `t` is the target: its texts are built out here
const moreText = (n) => t('audit.target.more', { n });
const pathsText = (n, list) => t('audit.target.paths', { n, list });

export const actionText = (e) => (ACTIONS[e.route] ? t(ACTIONS[e.route]) : e.route);

const base = (p) => String(p).split('/').filter(Boolean).pop() ?? p;

/** The target in a few words: :port, ports, the folder, what was changed. */
export function targetText(t = {}, { port = true } = {}) {
  const out = [];
  if (port && t.port) out.push(`:${t.port}`);
  if (Array.isArray(t.ports) && t.ports.length) out.push(t.ports.map((p) => `:${p}`).join(' ') + (t.portsCount ? ` ${moreText(t.portsCount - t.ports.length)}` : ''));
  if (t.device) out.push(t.device);
  if (t.key) out.push(t.key);
  if (t.path) out.push(base(t.path));
  if (t.repo) out.push(base(t.repo));
  if (Array.isArray(t.paths) && t.paths.length) out.push(`${pathsText(t.pathsCount ?? t.paths.length, t.paths.slice(0, 3).map(base).join(', '))}${(t.pathsCount ?? t.paths.length) > 3 ? ' …' : ''}`);
  if (t.owner) out.push(t.owner);
  for (const k of ['pinned', 'hidden', 'alert', 'on']) if (typeof t[k] === 'boolean') out.push(toggle(k, t[k]));
  if (t.mode) out.push(t.mode);
  if (t.autoStop) out.push(t.autoStop);
  if (Array.isArray(t.fields) && t.fields.length) out.push(t.fields.map(field).join('·'));
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
  const [rk, tone] = RESULTS[e.result] ?? [null, ''];
  const rt = rk ? t(rk) : e.result;
  const res = badge(e.count > 1 ? `${rt} ×${e.count}` : rt, tone);
  const since = e.count > 1 && e.since ? ` ${t('audit.since', { since: when(e.since), n: e.count })}` : '';
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

/**
 * GET /api/audit → {entries}, or {ownerOnly: true} when this browser isn't the owner (the log is the owner's only,
 * #7), or null when it failed.
 */
export async function loadAudit(path) {
  try {
    const res = await fetch(path);
    if (res.status === 403) return { ownerOnly: true };
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The <li> a list shows instead of entries: not the owner, or the load failed */
export const auditUnavailable = (doc) => el('li', 'muted', doc?.ownerOnly ? t('audit.ownerOnly') : t('audit.loadFailed'));
