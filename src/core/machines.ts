// Every machine work can run on, as one list (docs/multi-host.md "Machines"): this one, each `portboard agent` the
// board reads, and the cloud when portboard.json turns it on. Per machine its load, Claude Code sessions, checkouts,
// port counts, capabilities and how a person starts a session there. where_to_run (recommend.ts) scores this list.
//
//   self    computed here: hostLoad(), localClaude() matched to this machine's worktree scan, the snapshot's ports
//   agent   its last good /agent/v1/status (agents.ts); an agent without the route keeps info's load and null for
//           the rest, an agent that is down keeps its last status marked stale
//   cloud   nothing to read (no public API lists cloud sessions): reach none, tags from machines.cloud; its claude is
//           an estimate from the claude/* branches origin got lately (cloudEstimate), as of this machine's last fetch
//
// Portboard never starts anything on a machine: `launch` only says how a person does (the Desktop app's SSH session,
// a cloud session, Remote Control, --teleport).

import type { AgentReport, HostLoad, StatusParts } from '../agent/server.ts';
import type { AgentRead } from './agents.ts';
import { localClaude, type ClaudeSummary, type SessionBrief } from './claude-status.ts';
import type { Device } from './devices.ts';
import { hostLoad, localCapabilities } from './hostload.ts';
import { t } from './i18n.ts';
import type { Snapshot } from './index.ts';
import { platform } from './platform/index.ts';
import type { Reservation } from './reservations.ts';
import { UNIT_PREFIX } from './devservers.ts';
import type { AgentTarget, MachineKind, Site } from './site.ts';
import { briefOf, CLAUDE_BRANCH_WINDOW_MS, githubRepo, ownerName, worktreeOwnerOf, type WorktreeBrief, type WorktreesDoc } from './worktrees.ts';

export type { MachineKind };
export type Reach = 'local' | 'agent' | 'none';
export type MachineError = 'unreachable' | 'timeout' | 'auth' | 'http' | 'bad-answer';

export interface LaunchHint {
  via: 'local' | 'desktop-ssh' | 'remote-control' | 'cloud' | 'teleport';
  note: string;
}

export interface MachineStatus {
  /** the tailnet device id, agent:<name> for an agent on no device, cloud */
  id: string;
  name: string;
  kind: MachineKind;
  reach: Reach;
  /** this machine; an agent that answered or whose device Tailscale shows online; the cloud */
  online: boolean;
  /** when its data was last read (ISO); null: never, or nothing to read (cloud) */
  checkedAt: string | null;
  /** checkedAt is older than STALE_MS */
  stale: boolean;
  error: MachineError | null;
  load: HostLoad | null;
  claude: ClaudeSummary | null;
  worktrees: WorktreeBrief[] | null;
  ports: { listening: number; devServers: number } | null;
  capabilities: string[];
  /** Claude Code sessions it should run at once (portboard.json maxSessions, else by kind) */
  maxSessions: number | null;
  launch: LaunchHint[];
  /** the agent answers info but has no /agent/v1/status (older than machine_status): only load is known */
  oldAgent?: boolean;
}

/** Data older than this is shown as stale */
export const STALE_MS = 60_000;

/** Sessions a machine is meant to run at once when portboard.json doesn't say: the Mac is the control seat */
export function defaultMaxSessions(kind: MachineKind): number | null {
  if (kind === 'cloud') return null;
  return kind === 'mac' ? 2 : kind === 'windows' || kind === 'wsl' ? 3 : 4;
}

// ---- this machine ----

/** Listening ports, and the dev servers among them: user processes without a unit, or Portboard's pb-dev-* units */
export function portCounts(snap: Pick<Snapshot, 'ports'>): { listening: number; devServers: number } {
  const listening = snap.ports.filter((p) => p.listening);
  const dev = listening.filter((p) => p.kind === 'app' && p.owned && !p.container && p.processes.some((x) => !x.unit || x.unit.startsWith(UNIT_PREFIX)));
  return { listening: listening.length, devServers: dev.length };
}

export interface LocalDeps {
  host: string;
  snapshot(): Promise<Snapshot>;
  /** the last worktree scan (null: none yet) */
  worktrees(): Promise<WorktreesDoc | null>;
  reservations(): Promise<Reservation[]>;
  claude?(worktreeOf: (cwd: string) => string | null): Promise<ClaudeSummary | null>;
  load?(): Promise<HostLoad>;
  capabilities?(): Promise<string[]>;
  now?(): number;
}

/** This machine's status, unredacted (the agent redacts with projectStatus; the board's own row stays local) */
export async function localStatus(d: LocalDeps): Promise<StatusParts> {
  const [doc, reservations, snap, load, capabilities] = await Promise.all([
    d.worktrees().catch(() => null),
    d.reservations().catch(() => [] as Reservation[]),
    d.snapshot().catch(() => null),
    (d.load ?? hostLoad)(),
    (d.capabilities ?? localCapabilities)().catch(() => [] as string[]),
  ]);
  const worktreeOf = doc ? worktreeOwnerOf(doc) : () => null;
  const claude = await (d.claude ?? localClaude)(worktreeOf).catch(() => null);
  return {
    at: d.now?.() ?? Date.now(),
    host: d.host,
    load,
    claude,
    worktrees: doc ? briefOf(doc, reservations) : null,
    ports: snap ? portCounts(snap) : null,
    capabilities,
  };
}

// ---- the list ----

const osKind = (os: string | null | undefined): MachineKind | null => {
  const o = (os ?? '').toLowerCase();
  if (o === 'macos' || o === 'darwin' || o === 'mac') return 'mac';
  if (o === 'windows') return 'windows';
  if (o === 'linux') return 'linux';
  return null;
};

const capsKind = (caps: string[]): MachineKind | null => (caps.includes('macos') ? 'mac' : caps.includes('linux') ? 'linux' : null);

const uniq = (xs: string[]) => [...new Set(xs)];

/** How a person starts a session there (the Desktop app on the Mac is the control seat) */
export function launchHints(kind: MachineKind, name: string, self: boolean): LaunchHint[] {
  const out: LaunchHint[] = [];
  if (self) out.push({ via: 'local', note: t('machinesMsg.launch.local') });
  if (kind === 'cloud') return [{ via: 'cloud', note: t('machinesMsg.launch.cloud') }, { via: 'teleport', note: t('machinesMsg.launch.teleport') }];
  if (kind !== 'mac') out.push({ via: 'desktop-ssh', note: t('machinesMsg.launch.desktopSsh', { machine: name }) });
  out.push({ via: 'remote-control', note: t('machinesMsg.launch.remoteControl', { machine: name }) });
  return out;
}

/** A claude/* branch pushed within this many minutes counts as a cloud session still working */
export const CLOUD_ACTIVE_MIN = 60;

/**
 * The cloud's sessions, estimated: each claude/* branch origin got within CLAUDE_BRANCH_WINDOW_MS that no checkout here
 * has, and whose PR (when gh knows one) is still open; from the repos with worktrees and the plain clones (checkouts,
 * whose PRs aren't read). Active when pushed within CLOUD_ACTIVE_MIN. These are branches, not sessions: no id, and a
 * session that hasn't pushed yet isn't seen. The window is applied again: a saved scan can be days old. null when the
 * scan read no refs. Pure.
 */
export function cloudEstimate(doc: Pick<WorktreesDoc, 'repos' | 'checkouts'> | null, now = Date.now()): ClaudeSummary | null {
  const repos = [...(doc?.repos ?? []), ...(doc?.checkouts ?? [])].filter((r) => r.claudeBranches);
  if (!repos.length) return null;
  const sessions: SessionBrief[] = [];
  const seen = new Set<string>();
  for (const r of repos) {
    const gh = r.remote ? githubRepo(r.remote) : null;
    const repoKey = gh ?? r.name;
    for (const b of r.claudeBranches!) {
      if (b.pr && b.pr.state !== 'OPEN') continue;
      if (now - Date.parse(b.at) > CLAUDE_BRANCH_WINDOW_MS) continue;
      const key = `${repoKey.toLowerCase()}@${b.branch}`;
      if (seen.has(key)) continue; // two clones of one repo
      seen.add(key);
      const idleMin = Math.max(0, Math.floor((now - Date.parse(b.at)) / 60_000));
      sessions.push({ id: null, project: r.name, worktree: ownerName(r.name, b.branch), idleMin, cpuPct: null, mb: null, startedAt: null, idle: idleMin >= CLOUD_ACTIVE_MIN, remote: gh });
    }
  }
  sessions.sort((a, b) => (a.idleMin ?? 0) - (b.idleMin ?? 0));
  const idle = sessions.filter((x) => x.idle).length;
  return { cliVersion: null, sessions, active: sessions.length - idle, idle, source: 'github' };
}

export interface MachinesInput {
  site: Pick<Site, 'host' | 'machines'>;
  /** this machine's status (localStatus) */
  self: StatusParts;
  /** this machine's tailnet device id, when Tailscale runs */
  selfId?: string | null;
  agents: AgentRead[];
  targets: AgentTarget[];
  /** the tailnet devices (devices.ts), for online and OS; their agent field says which device an agent is on */
  devices: Pick<Device, 'id' | 'name' | 'online' | 'os' | 'self' | 'agent'>[];
  /** the cloud's estimated sessions (cloudEstimate), when the cloud is on */
  cloudWork?: ClaudeSummary | null;
  now?: number;
}

/** self, each agent in portboard.json order, then the cloud when on. Pure. */
export function buildMachines(i: MachinesInput): MachineStatus[] {
  const now = i.now ?? Date.now();
  const out: MachineStatus[] = [];
  const selfCfg = i.site.machines.self;
  const selfKind: MachineKind = selfCfg.kind ?? capsKind(i.self.capabilities) ?? osKind(platform().os) ?? 'linux';
  out.push({
    id: i.selfId ?? i.site.host,
    name: i.site.host,
    kind: selfKind,
    reach: 'local',
    online: true,
    checkedAt: new Date(i.self.at).toISOString(),
    stale: now - i.self.at > STALE_MS,
    error: null,
    load: i.self.load,
    claude: i.self.claude,
    worktrees: i.self.worktrees,
    ports: i.self.ports,
    capabilities: uniq([...i.self.capabilities, ...selfCfg.tags]),
    maxSessions: selfCfg.maxSessions ?? defaultMaxSessions(selfKind),
    launch: launchHints(selfKind, i.site.host, true),
  });
  for (const a of i.agents) {
    const target = i.targets.find((x) => x.name === a.name);
    const device = i.devices.find((d) => d.agent?.name === a.name && !d.self) ?? i.devices.find((d) => d.id.toLowerCase() === a.name.toLowerCase() && !d.self);
    if (i.devices.some((d) => d.self && d.agent?.name === a.name)) continue; // this machine's own agent: already the first row
    const st: AgentReport | null = a.status;
    const caps = st?.capabilities ?? [];
    const kind: MachineKind = target?.kind ?? capsKind(caps) ?? osKind(device?.os) ?? 'linux';
    const lastOk = st && a.lastOk ? Math.min(a.lastOk, st.at || a.lastOk) : a.lastOk;
    out.push({
      id: device?.id ?? `agent:${a.name}`,
      name: a.name,
      kind,
      reach: 'agent',
      online: a.ok || !!device?.online,
      checkedAt: lastOk ? new Date(lastOk).toISOString() : null,
      stale: !lastOk || now - lastOk > STALE_MS,
      error: a.error,
      load: st?.load ?? a.info?.load ?? null,
      claude: st?.claude ?? null,
      worktrees: st?.worktrees ?? null,
      ports: st?.ports ?? null,
      capabilities: uniq([...caps, ...(target?.tags ?? [])]),
      maxSessions: target?.maxSessions ?? defaultMaxSessions(kind),
      launch: launchHints(kind, a.name, false),
      ...(a.info && !st ? { oldAgent: true } : {}),
    });
  }
  const cloud = i.site.machines.cloud;
  if (cloud.enabled) {
    out.push({
      id: 'cloud',
      name: 'cloud',
      kind: 'cloud',
      reach: 'none',
      online: true,
      checkedAt: null,
      stale: false,
      error: null,
      load: null,
      claude: i.cloudWork ?? null,
      worktrees: null,
      ports: null,
      capabilities: uniq(cloud.tags),
      maxSessions: null,
      launch: launchHints('cloud', 'cloud', false),
    });
  }
  return out;
}

/** Seconds since each machine's data was read (null: never, or nothing to read) */
export function dataAge(list: MachineStatus[], now = Date.now()): Record<string, number | null> {
  return Object.fromEntries(list.map((m) => [m.name, m.checkedAt ? Math.max(0, Math.round((now - Date.parse(m.checkedAt)) / 1000)) : null]));
}
