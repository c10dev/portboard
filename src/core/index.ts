// Portboard core: the one API that the REST server and the MCP server wrap.
//
//   snapshot()             → every listening TCP port with owner, project, HTTP title, prefs and access URLs
//   expose(port)           → tailnet-only HTTPS via `tailscale serve` (same port number)
//   unexpose(port)         → remove the serve entry pointing at that port
//   setPrefs(port, patch)  → label / pinned / hidden / alert / onNew
//   (label, pin, hide and onNew also come from the port rules in prefs.json, src/core/portrules.ts)
//   restart(port), stop(port), logs(port, lines)  → act on the systemd unit, container or process owning it
//   freePorts(count, preferred)                   → ports a new dev server can use

import { hostname, userInfo } from 'node:os';
import { controlFor, logsFor, pickFreePorts, restartTarget, SELF_UNIT, stopTarget, type Control, type Logs } from './control.ts';
import { dockerPs } from './docker.ts';
import { assignGroups, type PortGroup } from './groups.ts';
import { loadPrefs, setPortPrefs, type OnNew, type PortPrefs, type PrefsPatch } from './prefs.ts';
import { resolvePrefs, ruleResolver, type ResolvedPrefs, type RuleField, type RuleSource } from './portrules.ts';
import { procInfos, unitDescriptions, type ProcInfo } from './proc.ts';
import { platform } from './platform/index.ts';
import { readListeners } from './platform/ports.ts';
import { services } from './platform/services.ts';
import { probe, probeKey, pruneProbes, type Probe } from './probe.ts';
import type { BindScope } from './ss.ts';
import { loadReservations, reservedFor, type Reservation } from './reservations.ts';
import {
  serveOff,
  serveOn,
  servedUrl,
  serveStatus,
  tailscaleInfo,
  type ActionResult,
  type ServeEntry,
  type TailscaleInfo,
} from './tailscale.ts';
import { t } from './i18n.ts';

export type { ActionResult, BindScope, Control, Logs, OnNew, PortGroup, PortPrefs, PrefsPatch, Probe, ProcInfo, ServeEntry, TailscaleInfo };

/**
 * app: owned by this user or a Docker container
 * ephemeral: high-numbered helper ports with no unit or container (VS Code server, language servers…)
 * system: owner not visible to this user (sshd, DNS, tailscaled…)
 */
export type PortKind = 'app' | 'ephemeral' | 'system';

export interface PortEntry {
  port: number;
  listening: boolean;
  /** Widest bind: all > tailnet > other > loopback */
  scope: BindScope | null;
  addresses: string[];
  /** false when the owning process isn't visible to this user (root/system services) */
  owned: boolean;
  kind: PortKind;
  container: string | null;
  /** docker compose project of the container (com.docker.compose.project) */
  composeProject: string | null;
  processes: ProcInfo[];
  /** For a system port whose process isn't visible: who owns it, known from the port (sshd, tailscaled…) */
  systemOwner: string | null;
  /** Set when other ports belong to the same compose project, container, systemd unit, process or tailscaled */
  group: PortGroup | null;
  /** What this port is within its group (kong, 웹 (HTTP), PeerAPI…) */
  role: string | null;
  /** label if set, otherwise the detected name */
  name: string;
  detectedName: string;
  label: string | null;
  pinned: boolean;
  hidden: boolean;
  /** Down/up alerts are on for this port (src/core/alerts.ts) */
  alert: boolean;
  /** What happens when this port starts listening (src/core/newports.ts), from the port rules */
  onNew: OnNew;
  /** The port rules that matched (precedence order) and where label, pinned, hidden and onNew came from */
  rules: { matched: string[]; from: Record<RuleField, RuleSource> };
  /** Shown in the default view: pinned, or (app and not hidden) */
  visible: boolean;
  probe: Probe | null;
  served: ServeEntry | null;
  urls: { direct: string | null; served: string | null; ssh: string };
  canExpose: boolean;
  exposeBlocker: string | null;
  control: Control | null;
  canRestart: boolean;
  canStop: boolean;
}

export interface Snapshot {
  at: string;
  host: { hostname: string; user: string };
  tailscale: TailscaleInfo;
  ports: PortEntry[];
}

const SCOPE_RANK: Record<BindScope, number> = { loopback: 0, other: 1, tailnet: 2, all: 3 };

export function kindOf(o: { port: number; owned: boolean; container: string | null; processes: { unit: string | null }[] }): PortKind {
  if (o.container) return 'app';
  if (!o.owned) return 'system';
  const hasUnit = o.processes.some((p) => p.unit);
  return !hasUnit && o.port >= 32768 && o.port <= 60999 ? 'ephemeral' : 'app';
}

export async function snapshot(): Promise<Snapshot> {
  const [listeners, ts, serve, dockerInfo, prefs] = await Promise.all([
    readListeners(true),
    tailscaleInfo(),
    serveStatus(),
    dockerPs(),
    loadPrefs(),
  ]);
  const docker = dockerInfo.ports;

  const byPort = new Map<number, typeof listeners>();
  for (const l of listeners) byPort.set(l.port, [...(byPort.get(l.port) ?? []), l]);

  const pids = [...new Set(listeners.flatMap((l) => l.processes.map((p) => p.pid)))];
  const infos = new Map((await procInfos(pids)).map((i) => [i.pid, i]));
  const units = [...new Set([...infos.values()].map((i) => i.unit).filter((u): u is string => !!u))];
  const descs = units.length ? await unitDescriptions(units) : new Map<string, string>();
  for (const i of infos.values()) if (i.unit) i.unitDescription = descs.get(i.unit) ?? null;

  const resolve = ruleResolver(prefs);
  const user = userInfo().username;
  const sshHost = ts.hostName ?? hostname();
  const dns = ts.dnsName;
  // A port can be served under its own number or another one (the dashboard: https 8443 → 8790).
  const serveFor = (port: number) =>
    serve.find((e) => e.upstreamPort === port && e.httpsPort === port) ?? serve.find((e) => e.upstreamPort === port) ?? null;

  // #11: no writes on a read-only install, no unit restarts without systemd
  const { readOnly } = platform();
  const unitsManaged = !services().unavailable;
  const aliveProbes = new Set<string>();
  const ports = await Promise.all(
    [...byPort.entries()].map(async ([port, ls]): Promise<PortEntry> => {
      const scope = ls.map((l) => l.scope).reduce((a, b) => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a));
      const addresses = [...new Set(ls.map((l) => l.address))];
      const procNames = new Map<number, string>();
      for (const l of ls) for (const p of l.processes) procNames.set(p.pid, p.name);
      const processes = [...procNames.keys()].map((pid) => infos.get(pid)!).filter(Boolean);
      const owned = processes.length > 0;
      const container = docker.get(port) ?? null;

      const probeHost =
        scope === 'loopback' || scope === 'all' ? '127.0.0.1' : (addresses.find((a) => a !== '*') ?? '127.0.0.1');
      const probePid = processes[0]?.pid ?? null;
      if (owned || container) aliveProbes.add(probeKey(probeHost, port, probePid));
      const pr = owned || container ? await probe(probeHost, port, probePid) : null;

      const served = serveFor(port);
      const reachable = scope === 'all' || scope === 'tailnet';
      const scheme = pr?.http ? 'http' : 'tcp';

      let exposeBlocker: string | null = null;
      if (!ts.available) exposeBlocker = 'tailscale not available';
      else if (served) exposeBlocker = 'already served';
      else if (reachable) exposeBlocker = 'already reachable on tailnet';
      else if (scope !== 'loopback') exposeBlocker = `bound to ${addresses.join(', ')}`;
      else if (!pr?.http) exposeBlocker = 'not an HTTP server';

      const known = owned || container ? null : wellKnown(port, scope, ts, serve);
      const detectedName = container ? `docker: ${container}` : (known?.name ?? labelFor(processes, [...procNames.values()], pr));
      const kind = kindOf({ port, owned, container, processes });
      const control = controlFor({ container, processes });
      const isSelf = processes.some((p) => p.pid === process.pid || p.unit === SELF_UNIT);

      return {
        port,
        listening: true,
        scope,
        addresses,
        owned,
        kind,
        container,
        composeProject: container ? (dockerInfo.projects.get(container) ?? null) : null,
        processes,
        systemOwner: known?.owner ?? null,
        group: null,
        role: null,
        ...withPrefs(resolve({ port, addresses, kind, commands: [...processes.map((p) => p.cmdline), ...(container ? [`docker: ${container}`] : [])] }), detectedName, kind),
        probe: pr,
        served,
        urls: {
          direct: reachable && dns ? `${scheme}://${dns}:${port}` : null,
          served: served && dns ? servedUrl(dns, served.httpsPort) : null,
          ssh: `ssh -N -L ${port}:127.0.0.1:${port} ${user}@${sshHost}`,
        },
        canExpose: exposeBlocker === null,
        exposeBlocker,
        control,
        canRestart: !readOnly && ((control?.type === 'systemd' && unitsManaged) || control?.type === 'docker'),
        canStop: !readOnly && control !== null && !isSelf && (control.type !== 'systemd' || unitsManaged),
      };
    }),
  );
  pruneProbes(aliveProbes);

  // serve entries whose upstream is no longer listening
  for (const e of serve) {
    if (e.upstreamPort !== null && byPort.has(e.upstreamPort)) continue;
    const name = `serve → ${e.upstream} (nothing listening)`;
    ports.push({
      port: e.upstreamPort ?? e.httpsPort,
      listening: false,
      scope: null,
      addresses: [],
      owned: true,
      kind: 'app',
      container: null,
      composeProject: null,
      processes: [],
      systemOwner: null,
      group: null,
      role: null,
      // no prefs or rules for a stale serve entry: it keeps its "(nothing listening)" name and stays visible
      ...withPrefs(resolvePrefs(undefined, [], undefined, { port: e.upstreamPort ?? e.httpsPort, addresses: [], kind: 'app', commands: [] }), name, 'app'),
      probe: null,
      served: e,
      urls: { direct: null, served: dns ? servedUrl(dns, e.httpsPort) : null, ssh: '' },
      canExpose: false,
      exposeBlocker: 'not listening',
      control: null,
      canRestart: false,
      canStop: false,
    });
  }

  assignGroups(ports);
  ports.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.port - b.port);
  return { at: new Date().toISOString(), host: { hostname: hostname(), user }, tailscale: ts, ports };
}

function withPrefs(p: ResolvedPrefs, detectedName: string, kind: PortKind) {
  const { label, pinned, hidden, alert, onNew } = p;
  return {
    name: label ?? detectedName,
    detectedName,
    label,
    pinned,
    hidden,
    alert,
    onNew,
    rules: { matched: p.matched, from: p.from },
    visible: pinned || (kind === 'app' && !hidden),
  };
}

// Owners of these are usually root, so ss can't name the process; the port (or tailscale itself) can.
const WELL_KNOWN: Record<number, { name: string; owner: string }> = {
  22: { name: 'SSH (sshd)', owner: 'sshd' },
  53: { name: 'DNS (systemd-resolved)', owner: 'systemd-resolved' },
  631: {
    get name() {
      return t('wellKnown.cups');
    },
    owner: 'cupsd',
  },
};

/** Name and owner of a port whose process isn't visible: tailscaled's own listeners first, then well-known ports. */
export function wellKnown(
  port: number,
  scope: BindScope | null,
  ts: Pick<TailscaleInfo, 'peerApiPorts'>,
  serve: ServeEntry[],
): { name: string; owner: string } | null {
  if (scope === 'tailnet' && ts.peerApiPorts?.includes(port)) return { name: 'Tailscale PeerAPI (tailscaled)', owner: 'tailscaled' };
  if (scope === 'tailnet' && serve.some((e) => e.httpsPort === port)) {
    return { name: 'tailscale serve HTTPS (tailscaled)', owner: 'tailscaled' };
  }
  return WELL_KNOWN[port] ?? null;
}

function labelFor(procs: ProcInfo[], names: string[], pr: Probe | null): string {
  const p = procs[0];
  return p?.unitDescription ?? pr?.title ?? p?.project ?? names[0] ?? 'unknown';
}

async function entryFor(port: number, snap: () => Promise<Snapshot> = snapshot): Promise<PortEntry | ActionResult> {
  const entry = (await snap()).ports.find((p) => p.port === port && p.listening);
  return entry ?? { ok: false, message: `nothing is listening on ${port}` };
}

const isEntry = (x: PortEntry | ActionResult): x is PortEntry => 'port' in x;

export async function expose(port: number): Promise<ActionResult> {
  const entry = await entryFor(port);
  if (!isEntry(entry)) return entry;
  if (!entry.canExpose) return { ok: false, message: `cannot expose ${port}: ${entry.exposeBlocker}` };
  return serveOn(port);
}

export async function unexpose(port: number): Promise<ActionResult> {
  const serve = await serveStatus();
  const e = serve.find((x) => x.upstreamPort === port && x.httpsPort === port) ?? serve.find((x) => x.upstreamPort === port);
  if (!e) return { ok: false, message: `${port} is not served` };
  return serveOff(e.httpsPort);
}

export async function setPrefs(port: number, patch: PrefsPatch): Promise<PortPrefs> {
  return setPortPrefs(port, patch);
}

export async function restart(port: number): Promise<ActionResult> {
  const entry = await entryFor(port);
  if (!isEntry(entry)) return entry;
  if (!entry.control) return { ok: false, message: `owner of ${port} is not visible to this user` };
  return restartTarget(entry.control);
}

export async function stop(port: number): Promise<ActionResult> {
  const entry = await entryFor(port);
  if (!isEntry(entry)) return entry;
  if (!entry.control) return { ok: false, message: `owner of ${port} is not visible to this user` };
  if (!entry.canStop) return { ok: false, message: 'refusing to stop portboard itself' };
  return stopTarget(entry.control);
}

/**
 * Logs read the owner from `snap` (the dashboard passes its shared 2 s snapshot, so a loop of log requests doesn't
 * start a full snapshot each, docs/security-review/v1.0.md L1); writes always resolve the owner from a new snapshot.
 */
export async function logs(port: number, lines = 100, snap: () => Promise<Snapshot> = snapshot): Promise<Logs> {
  const entry = await entryFor(port, snap);
  if (!isEntry(entry)) return { ok: false, source: '', lines: [], message: entry.message };
  if (!entry.control) return { ok: false, source: '', lines: [], message: `owner of ${port} is not visible to this user` };
  return logsFor(entry.control, lines);
}

/**
 * Ports a new dev server can use: not listening, not served, not reserved for someone else (#27). With `forOwner`,
 * that owner's reserved ports that are free right now come first.
 */
export async function freePorts(count = 1, preferred?: number, forOwner?: string | null): Promise<number[]> {
  const [listeners, serve, reservations] = await Promise.all([readListeners(false), serveStatus(), loadReservations()]);
  const taken = new Set(listeners.map((l) => l.port));
  for (const e of serve) taken.add(e.httpsPort);
  return pickFor(taken, reservations, count, preferred, forOwner);
}

/**
 * freePorts() from a snapshot the caller already has (port-advice: the shared 2 s one) and reservations it read,
 * instead of a new `ss` + `tailscale serve status` (docs/security-review/v1.0.md L1).
 */
export function freePortsFrom(snap: Pick<Snapshot, 'ports'>, reservations: Reservation[], count = 1, preferred?: number, forOwner?: string | null): number[] {
  const taken = new Set<number>();
  for (const p of snap.ports) {
    if (p.listening) taken.add(p.port);
    if (p.served) taken.add(p.served.httpsPort);
  }
  return pickFor(taken, reservations, count, preferred, forOwner);
}

function pickFor(taken: Set<number>, reservations: Reservation[], count: number, preferred: number | undefined, forOwner: string | null | undefined): number[] {
  const { blocked, own } = reservedFor(reservations, forOwner);
  const n = Math.max(1, Math.min(20, count));
  const first = own.filter((p) => !taken.has(p)).slice(0, n);
  const rest = pickFreePorts(new Set([...taken, ...blocked, ...own]), n - first.length, preferred);
  return [...first, ...rest];
}
