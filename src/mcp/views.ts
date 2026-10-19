// The port summary every MCP surface shares: list_ports, service_detail, the port resources and the remote's redacted
// list_ports all start from summarize() / toSummary().

import type { BindScope, PortEntry, PortKind, Snapshot } from '../core/index.ts';
import type { HistoryView } from '../core/history.ts';
import type { Parsed } from './kit.ts';

export interface PortSummary {
  port: number;
  name: string;
  listening: boolean;
  scope: BindScope | null;
  kind: PortKind;
  /** User-set label, when it differs from the detected name */
  label: string | null;
  pinned: boolean;
  /** Push alert when it goes down / comes back (set_alert) */
  alert: boolean;
  /** HTTP status of GET /, or null when the port doesn't speak HTTP (or wasn't probed) */
  http: number | null;
  /** Reachable directly on the tailnet */
  directUrl: string | null;
  /** Published through `tailscale serve` */
  servedUrl: string | null;
  canExpose: boolean;
  exposeBlocker: string | null;
  /** systemd unit, docker container or pid(s) that restart_service / stop_service act on */
  control: string | null;
  canRestart: boolean;
  canStop: boolean;
  /** Other ports owned by the same compose project, systemd unit or process; role is this port's part in it */
  group?: { name: string; ports: number[]; role: string | null };
  /** Last time any device (or a process on this server) was seen connected, from the history */
  lastUsed?: { at: string; by: string };
}

export interface ListArgs {
  query?: string;
  include_system?: boolean;
}

export function summarize(snap: Snapshot, args: ListArgs = {}, history?: HistoryView) {
  const q = args.query?.trim().toLowerCase() ?? '';
  const visible = snap.ports.filter((p) => args.include_system || p.visible);
  const matched = q ? visible.filter((p) => haystack(p).includes(q)) : visible;
  return {
    host: snap.host.hostname,
    tailnet: snap.tailscale.available ? snap.tailscale.dnsName : null,
    hiddenPorts: snap.ports.length - visible.length,
    ports: matched.map((p) => {
      const s = toSummary(p);
      if (p.group) s.group = { name: p.group.name, ports: p.group.ports, role: p.role };
      const last = p.listening ? history?.byPort[p.port] : undefined;
      if (last) s.lastUsed = { at: last.at, by: last.name };
      return s;
    }),
  };
}

function haystack(p: PortEntry): string {
  const proc = p.processes[0];
  return [String(p.port), p.name, p.detectedName, p.container, p.probe?.title, proc?.project, proc?.unit]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export function toSummary(p: PortEntry): PortSummary {
  return {
    port: p.port,
    name: p.name,
    listening: p.listening,
    scope: p.scope,
    kind: p.kind,
    label: p.label,
    pinned: p.pinned,
    alert: !!p.alert,
    http: p.probe?.http ? p.probe.status : null,
    directUrl: p.urls.direct,
    servedUrl: p.urls.served,
    canExpose: p.canExpose,
    exposeBlocker: p.exposeBlocker,
    control: controlText(p),
    canRestart: p.canRestart,
    canStop: p.canStop,
  };
}

function controlText(p: PortEntry): string | null {
  const c = p.control;
  if (!c) return null;
  if (c.type === 'systemd') return `systemd: ${c.unit}`;
  if (c.type === 'docker') return `docker: ${c.container}`;
  return `process: pid ${c.pids.join(', ')}`;
}

export function parseListArgs(args: unknown): Parsed<ListArgs> {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'arguments must be an object' };
  if (a.query !== undefined && typeof a.query !== 'string') return { ok: false, error: 'query must be a string' };
  if (a.include_system !== undefined && typeof a.include_system !== 'boolean') {
    return { ok: false, error: 'include_system must be a boolean' };
  }
  return { ok: true, value: { query: a.query as string | undefined, include_system: a.include_system as boolean | undefined } };
}
