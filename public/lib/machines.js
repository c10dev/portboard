// @ts-check
// The machine list (GET /api/machines, src/core/machines.ts) as the pages read it: each machine's tone, load and
// one-line summary for the 기기 tab's strip (features/machines.js), and which repo@branch is checked out on another
// machine for the 개발 tab (dev.js). Pure, so the tests run them in node.

import { t } from './i18n.js';

const lc = (s) => String(s ?? '').toLowerCase();

/** What a machine is, in a word */
export const KIND_LABEL = { linux: 'Linux', mac: 'macOS', windows: 'Windows', wsl: 'WSL', cloud: t('machines.kind.cloud') };

/** CPU (load1 per core) and memory in use, 0–100; null when not read */
export function loadPct(m) {
  const l = m.load;
  if (!l) return { cpu: null, mem: null };
  const cpu = l.cores > 0 ? Math.min(100, Math.round((l.load1 / l.cores) * 100)) : null;
  const mem = l.memTotalMb && l.memAvailMb != null ? Math.max(0, Math.min(100, Math.round((1 - l.memAvailMb / l.memTotalMb) * 100))) : null;
  return { cpu, mem };
}

/** ok (fresh), warn (stale, or busy), bad (an agent that doesn't answer), off (offline, or the cloud: nothing to read) */
export function machineTone(m) {
  if (m.kind === 'cloud') return 'off';
  if (!m.online) return 'off';
  if (m.error && !m.checkedAt) return 'bad';
  if (m.stale) return 'warn';
  const { cpu, mem } = loadPct(m);
  return (cpu ?? 0) >= 90 || (mem ?? 0) >= 92 ? 'warn' : 'ok';
}

/** Checkouts with uncommitted files or a process working in them */
export const busyCheckouts = (m) => (m.worktrees ?? []).filter((w) => (w.dirty ?? 0) > 0 || w.inUse);

/** The strip's line under the name: sessions, checkouts with work, data age when stale */
export function machineBits(m, now = Date.now()) {
  if (m.kind === 'cloud') return [t('machines.cloud.line')];
  if (!m.online && !m.checkedAt) return [t('machines.offline')];
  const bits = [];
  if (m.claude) bits.push(m.maxSessions ? t('machines.sessions', { active: m.claude.active, max: m.maxSessions }) : t('machines.sessionsNoMax', { active: m.claude.active }));
  if (m.claude?.idle) bits.push(t('machines.idle', { n: m.claude.idle }));
  const busy = busyCheckouts(m).length;
  if (busy) bits.push(t('machines.busyCheckouts', { n: busy }));
  if (m.oldAgent) bits.push(t('machines.oldAgent'));
  if (m.stale && m.checkedAt) {
    const s = Math.max(0, Math.round((now - Date.parse(m.checkedAt)) / 1000));
    bits.push(s < 120 ? t('machines.staleFor', { s }) : t('machines.staleForMin', { n: Math.round(s / 60) }));
  }
  else if (m.stale) bits.push(t('machines.noData'));
  return bits;
}

/** owner/name from a GitHub remote URL (git@github.com:o/n.git, https://github.com/o/n); anything else as it is */
const ghName = (s) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(s)?.[1] ?? s;

/** A local repo (the 개발 tab's { name, remote URL }) and a machine's checkout are the same repository: folder or GitHub name */
export function sameRepo(repo, w) {
  if (lc(repo.name) === lc(w.repo)) return true;
  return !!(repo.remote && w.remote && lc(ghName(repo.remote)) === lc(w.remote));
}

/**
 * repo@branch (lower case) → the other machines that have it checked out, with what is going on there: { machine,
 * dirty, inUse, sessions, work }. Only agents (not this machine, not the cloud).
 */
export function elsewhereByOwner(machines) {
  const out = new Map();
  for (const m of machines ?? []) {
    if (m.reach !== 'agent') continue;
    const active = (m.claude?.sessions ?? []).filter((s) => !s.idle && s.worktree);
    for (const w of m.worktrees ?? []) {
      const sessions = active.filter((s) => lc(s.worktree) === lc(w.owner)).length;
      const dirty = w.dirty ?? 0;
      const e = { machine: m.name, dirty, inUse: !!w.inUse, sessions, work: dirty > 0 || !!w.inUse || sessions > 0 };
      const key = lc(w.owner);
      out.set(key, [...(out.get(key) ?? []), e]);
    }
  }
  return out;
}

/** The 개발 tab's badge for a checkout that is also on other machines: [text, tone, title] or null */
export function alsoOn(list) {
  if (!list?.length) return null;
  const names = list.map((e) => e.machine).join(', ');
  const work = list.filter((e) => e.work);
  const title = list.map((e) => `${e.machine}: ${[
    e.dirty ? t('machines.dirty', { n: e.dirty }) : null,
    e.sessions ? t('machines.activeSessions', { n: e.sessions }) : null,
    e.inUse ? t('machines.inUse') : null,
  ].filter(Boolean).join(', ') || t('machines.clean')}`).join('\n');
  return [work.length ? t('machines.alsoOnBusy', { machines: names }) : t('machines.alsoOn', { machines: names }), work.length ? 'warn' : 'info', title];
}

/** The 개발 tab's machine filter: every machine with checkouts, this one first; [{ value, label }] */
export function machineOptions(machines) {
  return (machines ?? []).filter((m) => m.reach === 'local' || (m.worktrees ?? []).length).map((m) => ({ value: m.name, label: m.reach === 'local' ? t('machines.thisOne', { name: m.name }) : m.name }));
}

/** Another machine's checkouts grouped by repo, for the 개발 tab: [{ repo, remote, machine, worktrees }] */
export function remoteRepos(machines, machine = null) {
  const out = [];
  for (const m of machines ?? []) {
    if (m.reach !== 'agent' || (machine && m.name !== machine)) continue;
    const by = new Map();
    for (const w of m.worktrees ?? []) {
      const key = lc(w.remote ?? w.repo);
      if (!by.has(key)) by.set(key, { repo: w.repo, remote: w.remote, machine: m.name, worktrees: [] });
      by.get(key).worktrees.push(w);
    }
    out.push(...by.values());
  }
  return out;
}
