// 메모리: where this server's RAM goes (Claude sessions, the MCP servers every session spawns, services and dev servers,
// docker, the rest) and memory-pressure alerts through the down alerts' channel (src/core/memory.ts).
//
//   GET /api/memory   the last sample: mem/swap/PSI, the partition (groups), sessions, MCP totals, services, docker,
//                     other, the hour's history, the pressure state with its thresholds, and suggestions (never actions)
//   MCP memory_usage  (also remote, redacted, from memory-state.json: titles, projects and process names stay on this
//                     machine unless remote.json's showProcesses)
//   job memory        every 60 s on the scheduler: one /proc read, the pressure step, memory-state.json
//   ui  memory.js on the 기기 tab, under 이 서버
//
// Config: memory.json in the config dir (PORTBOARD_MEMORY moves it), read on every sample, never written:
// {"availablePct": 10, "psiSome60": 5, "swapPct": 90, "sustainMin": 5, "reminderHours": 6, "idleMin": 60,
// "devIdleHours": 24}. Alerts go out only where paths.alertsOn (production; never a preview by default).
// Nothing here stops or signals a process: the suggestions say where to do it (the Claude app, the 서비스 tab's 정리).

import { hostname } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { httpSender, loadChannel, redact, type Message, type Sent } from '../core/alerts.ts';
import { appendPrivate, writePrivate } from '../core/atomic.ts';
import { reportHealth } from '../core/health.ts';
import { run } from '../core/exec.ts';
import {
  createSampler,
  digestLine,
  emptyState,
  historyPoint,
  loadState,
  parseThresholds,
  pressureMessage,
  pushHistory,
  scanTitle,
  statusLine,
  stepPressure,
  suggestions,
  MEMORY_STATE,
  REASON_TEXT,
  SAMPLE_EVERY,
  VIEW_STALE_MS,
  type McpUse,
  type MemorySample,
  type MemoryStateFile,
  type MemoryStatus,
  type ServiceRef,
  type Suggestion,
  type Thresholds,
} from '../core/memory.ts';
import { transcriptMtime, transcriptPath, transientUnits } from '../core/owners.ts';
import { PATHS, type Paths } from '../core/paths.ts';
import type { Snapshot } from '../core/index.ts';
import { parseOptionalInt, text } from '../mcp/kit.ts';
import { redactMemory } from '../remote/redact.ts';
import { mcpUseForMemory } from './adoption.ts';
import { ok } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** The memory view (the server's last sample from memory-state.json, else one read of /proc) */
    memory?(): Promise<MemoryView>;
  }
}

export type MemoryView = Omit<MemorySample, 'cpu'> & {
  pressure: MemoryStateFile['pressure'] & { reasonText: string[]; thresholds: Thresholds };
  history: MemoryStateFile['history'];
  suggestions: Suggestion[];
  sampleEverySec: number;
  /** groups is a partition (each process once, rssMb is their sum); a session's mb is its whole tree */
  note: string;
};

const NOTE =
  'groups split every process once (docker, MCP servers, services, Claude CLIs with their other children, the rest); ' +
  "a session's mb is its whole process tree, its MCP servers and dev servers included. Sizes are RSS.";

export const configPath = (paths: Paths = PATHS) => process.env.PORTBOARD_MEMORY ?? join(paths.configDir, 'memory.json');
export const statePath = (paths: Paths = PATHS) => join(paths.stateDir, MEMORY_STATE);

export async function loadThresholds(path = configPath()): Promise<Thresholds> {
  try {
    return parseThresholds(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return parseThresholds(null);
  }
}

// docker ps once per 5 minutes, for container names (the sizes come from the cgroups)
let dockerCache: { at: number; names: Map<string, string> } | null = null;
async function dockerNames(): Promise<Map<string, string>> {
  if (dockerCache && Date.now() - dockerCache.at < 5 * 60_000) return dockerCache.names;
  const r = await run('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}'], 5_000);
  const names = new Map<string, string>();
  if (r.ok) for (const line of r.stdout.split('\n')) {
    const [id, name] = line.split('\t');
    if (id && name) names.set(id.slice(0, 12), name);
  }
  dockerCache = { at: Date.now(), names };
  return names;
}

// Titles: each transcript is read once, then only what was appended since (scanTitle)
const titleScans = new Map<string, { size: number; title: string | null }>();
async function titleOf(id: string): Promise<string | null> {
  const path = await transcriptPath(id);
  if (!path) return null;
  const prev = titleScans.get(id);
  const next = await scanTitle(path, prev?.size ?? 0, prev?.title ?? null);
  if (titleScans.size > 1000) titleScans.clear();
  titleScans.set(id, next);
  return next.title;
}

const sampler = createSampler({ title: titleOf, lastActive: transcriptMtime, dockerNames });

/**
 * The port snapshot's services: one per systemd unit, else per owning process; docker ports are left to docker. A dev
 * server is one with no unit or a systemd-run (transient) unit: what a session or a person started by hand.
 */
export function servicesOf(snap: Snapshot, transient: Set<string> = new Set(), idlePorts: Set<number> | null = null): ServiceRef[] {
  const out = new Map<string, ServiceRef>();
  for (const p of snap.ports) {
    if (!p.owned || p.container || !p.processes.length) continue;
    const unit = p.processes.find((x) => x.unit)?.unit ?? null;
    const key = unit ?? `pid:${p.processes[0].pid}`;
    const cur = out.get(key) ?? { name: p.name, ports: [], pids: [], unit, dev: !unit || transient.has(unit), unused: true };
    cur.ports.push(p.port);
    for (const x of p.processes) if (!cur.pids.includes(x.pid)) cur.pids.push(x.pid);
    // unused: every port of it idle in the usage view (null: not known, so not "unused")
    cur.unused &&= idlePorts ? idlePorts.has(p.port) : false;
    out.set(key, cur);
  }
  return [...out.values()];
}

let latest: MemorySample | null = null;
let file: MemoryStateFile | null = null;
let running: Promise<MemorySample> | null = null;

async function deliver(paths: Paths, m: Message): Promise<boolean> {
  const c = await loadChannel(paths.alertChannel).catch(() => null);
  // no channel: nothing to retry
  if (!c) return true;
  const sent: Sent[] = await httpSender()(c, m).catch((err) => [{ channel: 'ntfy' as const, ok: false, error: redact(String(err), c) }]);
  await appendPrivate(paths.alertsLog, `${JSON.stringify({ t: new Date().toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent })}\n`).catch(() => {});
  return sent.some((x) => x.ok);
}

/** One sample: /proc, the pressure step (and its alert), the state file. */
export async function sampleOnce(ctx: ServerContext, now = Date.now()): Promise<MemorySample> {
  running ??= (async () => {
    try {
      const th = await loadThresholds(configPath(ctx.paths));
      const snap = await ctx.snapshot().catch(() => null);
      const units = snap ? [...new Set(snap.ports.flatMap((p) => p.processes.map((x) => x.unit).filter((u): u is string => !!u)))] : [];
      const transient = await transientUnits(units).catch(() => new Set<string>());
      const s = await sampler.sample(snap ? servicesOf(snap, transient) : [], th, now);
      reportHealth('memory', { ok: true });
      const f = (file ??= await loadState(statePath(ctx.paths)));
      f.history = pushHistory(f.history, historyPoint(s));
      const prev = f.pressure;
      const { next, event } = stepPressure(prev, { availablePct: s.mem.availablePct, swapPct: s.mem.swapPct, swapTotalMb: s.mem.swapTotalMb, psiSome60: s.psi?.some.avg60 ?? null }, now, th);
      f.pressure = next;
      if (event) {
        const since = event === 'recover' ? prev.breachSince : next.breachSince;
        console.error(`[portboard] memory: ${event} (${next.reasons.join(', ') || 'clear'}; available ${s.mem.availablePct}%, swap ${s.mem.swapPct}%)`);
        // Previews and PORTBOARD_ALERTS=off track the state and send nothing (paths.alertsOn)
        if (ctx.paths.alertsOn && !(await deliver(ctx.paths, pressureMessage(event, s, since, now, hostname())))) {
          // nothing got through: try again next minute
          if (event === 'warn') f.pressure = { ...next, active: false };
          if (event === 'remind') f.pressure = { ...next, lastSent: prev.lastSent };
        }
      }
      const { cpu: _cpu, ...view } = s;
      f.view = view;
      await writePrivate(statePath(ctx.paths), `${JSON.stringify(f)}\n`).catch((err) => console.error(`[portboard] memory state: ${(err as Error).message}`));
      latest = s;
      return s;
    } catch (err) {
      reportHealth('memory', { ok: false, error: (err as Error).message });
      throw err;
    } finally {
      running = null;
    }
  })();
  return running;
}

// tool calls per MCP server from the adoption scan: it changes once a day
let useCache: { at: number; value: McpUse | null } | null = null;
async function mcpUse(): Promise<McpUse | null> {
  if (useCache && Date.now() - useCache.at < 10 * 60_000) return useCache.value;
  const value = await mcpUseForMemory().catch(() => null);
  useCache = { at: Date.now(), value };
  return value;
}

/** The view the API, the MCP tool and the UI show. `idlePorts`: ports nobody uses now (usage.ts), when known. */
export function viewOf(s: Omit<MemorySample, 'cpu'>, f: MemoryStateFile, th: Thresholds, use: McpUse | null, idlePorts: Set<number> | null = null): MemoryView {
  const services = idlePorts ? s.services.map((x) => ({ ...x, unused: x.ports.every((p) => idlePorts.has(p)) })) : s.services;
  const sample = { ...s, services };
  return {
    ...sample,
    pressure: { ...f.pressure, reasonText: f.pressure.reasons.map((r) => REASON_TEXT[r]), thresholds: th },
    history: f.history,
    suggestions: suggestions({ ...sample, cpu: { at: 0, ticks: {} } }, th, use),
    sampleEverySec: SAMPLE_EVERY / 1000,
    note: NOTE,
  };
}

async function serverView(ctx: ServerContext): Promise<MemoryView> {
  const s = latest && Date.now() - Date.parse(latest.at) < VIEW_STALE_MS ? latest : await sampleOnce(ctx);
  const [th, use, usage] = await Promise.all([loadThresholds(configPath(ctx.paths)), mcpUse(), ctx.usage().catch(() => null)]);
  const idle = usage ? new Set(usage.idle.map((x) => x.port)) : null;
  return viewOf(s, file ?? emptyState(), th, use, idle);
}

/** For the stdio MCP server: the dashboard's last sample, else one read of /proc (no CPU history, no services). */
async function fileView(): Promise<MemoryView> {
  const f = await loadState(statePath());
  const th = await loadThresholds();
  const fresh = f.view && Date.now() - Date.parse(f.view.at) < VIEW_STALE_MS;
  const s = fresh ? f.view! : await sampler.sample([], th);
  return viewOf(s, f, th, await mcpUse());
}

/**
 * For the remote server: the dashboard's last sample (memory-state.json) as the view, or null when it is missing or
 * stale. Never samples /proc itself (that would read transcripts for titles from the internet-facing process).
 */
export async function savedView(path = statePath(), now = Date.now()): Promise<MemoryView | null> {
  const f = await loadState(path);
  if (!f.view || !(now - Date.parse(f.view.at) < VIEW_STALE_MS)) return null;
  return viewOf(f.view, f, await loadThresholds(), await mcpUse());
}

/** portboard://status's memory line, and the remote server's (numbers only); null when nothing samples */
export async function memoryStatus(path = statePath()): Promise<MemoryStatus | null> {
  return statusLine(await loadState(path));
}

/** The 수집 chip (/api/health?detail): the pressure state, when the server samples */
export function pressureNow(): { pressure: boolean; reasons: string[]; availablePct: number; swapPct: number } | null {
  if (!latest || !file) return null;
  return { pressure: file.pressure.active, reasons: file.pressure.reasons.map((r) => REASON_TEXT[r]), availablePct: latest.mem.availablePct, swapPct: latest.mem.swapPct };
}

/** The digest's 🧠 line, from the state file (the server or the stdio MCP server) */
export async function memoryForDigest(paths: Paths = PATHS): Promise<{ problem: boolean; text: string } | null> {
  const f = await loadState(statePath(paths));
  if (!f.view || Date.now() - Date.parse(f.view.at) > VIEW_STALE_MS) return null;
  const th = await loadThresholds(configPath(paths));
  return digestLine({ ...f.view, cpu: { at: 0, ticks: {} } }, f.pressure, suggestions({ ...f.view, cpu: { at: 0, ticks: {} } }, th, null));
}

const gb = (mb: number) => Math.round(mb / 102.4) / 10;

/** The tool's answer: the summary and the top rows, in GB where it reads better */
export function toolSummary(v: MemoryView, top = 10) {
  return {
    at: v.at,
    memory: { totalGb: gb(v.mem.totalMb), availableGb: gb(v.mem.availableMb), availablePct: v.mem.availablePct, swapPct: v.mem.swapPct, psi: v.psi ? { someAvg60: v.psi.some.avg60, fullAvg60: v.psi.full?.avg60 ?? null } : null },
    pressure: { active: v.pressure.active, reasons: v.pressure.reasonText, thresholds: v.pressure.thresholds },
    groups: v.groups.map((g) => ({ group: g.label, gb: gb(g.mb), processes: g.procs })),
    mcpServers: v.mcp.map((m) => ({ name: m.label, instances: m.instances, gb: gb(m.mb), sessions: m.sessions, orphans: m.orphans })),
    sessions: {
      count: v.sessions.length,
      idle: v.sessions.filter((x) => x.idle).length,
      staleVersion: v.sessions.filter((x) => x.stale).length,
      newestVersion: v.newestVersion,
      top: v.sessions.slice(0, top).map((x) => ({ title: x.title, project: x.project, version: x.version, stale: x.stale, idleMin: x.idleMin, idle: x.idle, mb: x.mb, mcpMb: x.breakdown.mcp, uptimeH: Math.round(x.uptimeSec / 360) / 10 })),
    },
    services: v.services.slice(0, top).map((x) => ({ name: x.name, ports: x.ports, mb: x.mb, dev: x.dev, unused: x.unused, session: x.session })),
    docker: v.docker.slice(0, top),
    suggestions: v.suggestions.map((x) => x.text),
    note: v.note,
  };
}

export const memoryFeature: FeatureModule = {
  name: 'memory',
  order: 2500,
  routes: [{ method: 'GET', path: '/api/memory', handler: async (_r, ctx) => ok(await serverView(ctx)) }],
  tools: [
    {
      def: {
        name: 'memory_usage',
        title: 'Memory by session and MCP server',
        description:
          'Where this server\'s RAM goes: available memory, swap and PSI pressure, then by group (Claude Code sessions, ' +
          'MCP servers, services and dev servers, docker, other). Per Claude session: title or project, CLI version (stale ' +
          'when older than the newest running), idle time, MB of its whole process tree. Per MCP server: instances and total ' +
          '(a user-scope server runs once per session). Plus suggestions (idle sessions to archive in the Claude app, stale ' +
          'CLIs, rarely used MCP servers, long-idle dev servers). Read-only: it never stops anything.',
        inputSchema: {
          type: 'object',
          properties: { top: { type: 'integer', minimum: 1, maximum: 50, description: 'Rows per list (default 10)' } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async call(args, core) {
        const top = parseOptionalInt(args, 'top', 1, 50);
        if (!top.ok) return text(top.error, true);
        if (!core.memory) return text('memory_usage is not available here', true);
        return text(toolSummary(await core.memory(), top.value ?? 10));
      },
      remote: {
        description:
          'Where the Portboard server\'s RAM goes: total, available and swap, PSI pressure and whether a memory-pressure ' +
          'alert is active (with its thresholds), then by group (Claude Code sessions, MCP servers, services and dev ' +
          'servers, docker, other) with totals. Per session only numbers (CLI version, idle, MB); per service and ' +
          'container its name and MB. From the server\'s last sample (at; every 60 s). Session titles, projects and ' +
          'process names are left out on purpose. Read-only: it never stops anything.',
        async call(args, core, policy) {
          const top = parseOptionalInt(args, 'top', 1, 50);
          if (!top.ok) return text(top.error, true);
          if (!core.memory) return text('memory_usage is not available here', true);
          const v = await core.memory();
          if (!v) return text({ at: null, note: 'No recent memory sample: the Portboard server samples every 60 s.' });
          return text(redactMemory(v, top.value ?? 10, policy));
        },
      },
    },
  ],
  mcpCore: () => ({ memory: () => fileView() }),
  jobs: [{ name: 'memory', everyMs: SAMPLE_EVERY, runAtStart: true, run: (ctx) => sampleOnce(ctx) }],
  collectors: ['memory'],
  ui: [{ pages: ['devices.html'], script: 'features/memory.js' }],
};
