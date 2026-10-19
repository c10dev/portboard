// 메모리 (src/core/memory.ts): what could be freed (suggestions, never actions) and the digest's line.

import { t } from '../i18n.ts';
import { gb, type PressureState } from './pressure.ts';
import type { MemorySample, Thresholds } from './sample.ts';

export interface Suggestion {
  kind: 'idle-sessions' | 'stale-cli' | 'mcp-unused' | 'dev-idle';
  text: string;
  mb: number;
  /** a page to go to (the existing cleanup flow); never an action */
  href?: string;
  linkText?: string;
}

/** Tool calls per MCP server in the adoption scan's window (null: that scan hasn't counted them yet) */
export interface McpUse {
  days: number;
  /** sessions in the window */
  sessions: number;
  /** server segment of mcp__<server>__tool → calls and sessions that called it */
  servers: Record<string, { calls: number; sessions: number }>;
}

/** Calls to one of our MCP rows: a tool name's server segment that names it (plugin_portboard_portboard → portboard) */
export function useOf(use: McpUse, name: string): { calls: number; sessions: number } {
  const want = name.toLowerCase().replace(/^@[\w.-]+\//, '').replace(/[^a-z0-9]+/g, '');
  let calls = 0;
  let sessions = 0;
  for (const [server, v] of Object.entries(use.servers)) {
    const s = server.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (s === want || s.includes(want) || (want.length > 3 && want.includes(s) && s.length > 3)) {
      calls += v.calls;
      sessions = Math.max(sessions, v.sessions);
    }
  }
  return { calls, sessions };
}

export function suggestions(s: MemorySample, th: Thresholds, use: McpUse | null): Suggestion[] {
  const out: Suggestion[] = [];
  const idle = s.sessions.filter((x) => x.idle);
  if (idle.length) {
    const mb = idle.reduce((a, x) => a + x.mb, 0);
    out.push({ kind: 'idle-sessions', mb, text: t('memoryMsg.suggest.idle', { n: idle.length, size: gb(mb), min: th.idleMin }) });
  }
  const stale = s.sessions.filter((x) => x.stale);
  if (stale.length && s.newestVersion) {
    const mb = stale.reduce((a, x) => a + x.mb, 0);
    const old = [...new Set(stale.map((x) => x.version))].join(', ');
    out.push({ kind: 'stale-cli', mb, text: t('memoryMsg.suggest.staleCli', { versions: old, n: stale.length, size: gb(mb), newest: s.newestVersion }) });
  }
  const cliCount = s.sessions.filter((x) => !x.helper).length;
  for (const m of s.mcp) {
    if (m.instances < 3 || m.sessions < Math.max(3, cliCount / 2)) continue;
    if (!use) {
      out.push({ kind: 'mcp-unused', mb: m.mb, text: t('memoryMsg.suggest.mcpUnchecked', { label: m.label, n: m.instances, size: gb(m.mb) }) });
      continue;
    }
    const u = useOf(use, m.name);
    const share = use.sessions ? u.sessions / use.sessions : 0;
    if (share >= 0.2) continue;
    out.push({
      kind: 'mcp-unused',
      mb: m.mb,
      text: t('memoryMsg.suggest.mcpUnused', { label: m.label, n: m.instances, size: gb(m.mb), days: use.days, sessions: use.sessions, used: u.sessions, calls: u.calls }),
    });
  }
  const devIdle = s.services.filter((x) => x.dev && x.unused && x.uptimeSec !== null && x.uptimeSec >= th.devIdleHours * 3600);
  if (devIdle.length) {
    const mb = devIdle.reduce((a, x) => a + x.mb, 0);
    out.push({
      kind: 'dev-idle',
      mb,
      text: t('memoryMsg.suggest.devIdle', { hours: th.devIdleHours, n: devIdle.length, size: mbText(mb), list: devIdle.slice(0, 4).map((x) => `${x.name} :${x.ports[0]}`).join(', ') }),
      href: './#ownersBanner',
      linkText: t('memoryMsg.suggest.cleanupLink'),
    });
  }
  return out.sort((a, b) => b.mb - a.mb);
}

export const mbText = (mb: number) => (mb >= 1024 ? gb(mb) : `${mb} MB`);

/** The digest's line: only when memory is short or something sizeable can be freed */
export function digestLine(s: MemorySample, st: PressureState | null, sugg: Suggestion[]): { problem: boolean; text: string } | null {
  const m = s.mem;
  const head = t('memoryMsg.digest.head', { available: gb(m.availableMb), total: gb(m.totalMb), pct: m.availablePct, swap: m.swapPct });
  const idle = sugg.find((x) => x.kind === 'idle-sessions');
  const extra = [st?.active ? t('memoryMsg.digest.alerting') : null, idle ? t('memoryMsg.digest.idle', { n: s.sessions.filter((x) => x.idle).length, size: gb(idle.mb) }) : null, s.mcp[0] ? `${s.mcp[0].label} ×${s.mcp[0].instances} ${gb(s.mcp[0].mb)}` : null].filter(Boolean);
  return { problem: !!st?.active, text: [head, ...extra].join(' · ') };
}
