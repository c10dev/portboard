// portboard://status as data: statusReport() turns what the sources returned into the summary. Pure and free of tool
// imports, so the remote redaction (src/remote/redact.ts) and the local resource (resources.ts) share it without an
// import cycle through the tool registry.

import type { SelfWatchStatus } from '../core/selfwatch.ts';
import type { MemoryStatus } from '../core/memory.ts';

// Same set as the menubar's ⚠ (menubar/format.mjs POOL_WARN): agent-away and agent-busy are normal.
const POOL_WARN = new Set(['degraded', 'wsl-down', 'host-down', 'auth']);
const MAX_LIST = 20;

/** The minimum statusReport reads, so the remote server can pass its redacted projections. */
export interface StatusInput {
  at: string;
  /** visible: false for system, ephemeral and hidden ports (named in inUse, not counted as listening services) */
  ports: { host: string; tailnet: string | null; ports: { port: number; name: string; listening: boolean; visible?: boolean }[] } | null;
  devices: {
    pool: { available: boolean };
    devices: { name: string; self: boolean; online: boolean; pool: { name: string; state: string; inRotation: boolean } | null }[];
  } | null;
  usage: { byPort: Record<number, { name: string }[]>; idleServices: number } | null;
  watching: { kind: 'port' | 'device'; port?: number; name: string; down: boolean; since: string | null }[] | null;
  /** Pending 새 기기: the list (local) or only how many (remote) */
  newDevices: { name: string; kind: string; since: string; service: { port: number; name: string } | null }[] | number | null;
  /** Self-watch (local server only; absent = the section is left out) */
  collection?: SelfWatchStatus | null;
  /** Memory pressure, numbers only (absent = left out; null = nothing samples it) */
  memory?: MemoryStatus | null;
}

/** The status resource's collection section: failing collectors and credentials expiring soon, nothing that works. */
export function collectionReport(c: SelfWatchStatus) {
  return {
    summary: c.summary,
    failing: c.collectors
      .filter((x) => x.view === 'failing' || x.view === 'down')
      .map((x) => ({ name: x.name, since: x.failingSince, lastOk: x.lastOk, error: x.lastError, alerted: x.alerted })),
    notSetUp: c.collectors.filter((x) => x.view === 'setup' || x.view === 'off').map((x) => x.name),
    expiring: c.expiry.items.filter((i) => i.status === 'soon' || i.status === 'expired').map((i) => ({ name: i.name, status: i.status, expiresAt: i.expiresAt })),
    checkedAt: c.lastCheck,
  };
}

const REASONS = new Set(['available', 'psi', 'swap']);

/** The status resource's memory line: rebuilt from numbers and known reason codes, so nothing else can ride along */
export function memoryReport(m: MemoryStatus) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    pressure: m.pressure === true,
    reasons: Array.isArray(m.reasons) ? m.reasons.filter((r) => REASONS.has(r)) : [],
    availablePct: num(m.availablePct),
    swapPct: num(m.swapPct),
    psiSome60: num(m.psiSome60),
    at: typeof m.at === 'string' && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : null,
  };
}

export function statusReport(i: StatusInput) {
  const unavailable = (['ports', 'devices', 'usage', 'watching', 'newDevices'] as const).filter((k) => i[k] === null);
  const names = new Map((i.ports?.ports ?? []).map((p) => [p.port, p.name]));
  const others = i.devices?.devices.filter((d) => !d.self) ?? [];
  const poolHosts = i.devices?.devices.flatMap((d) => (d.pool ? [{ name: d.pool.name, state: d.pool.state, inRotation: d.pool.inRotation }] : [])) ?? [];
  const inUse = Object.entries(i.usage?.byPort ?? {})
    .map(([port, users]) => ({ port: Number(port), service: names.get(Number(port)) ?? `:${port}`, users: [...new Set(users.map((u) => u.name))] }))
    .filter((r) => r.users.length)
    .sort((a, b) => a.port - b.port);
  const down = (i.watching ?? []).filter((w) => w.down);
  const nd = i.newDevices;

  return {
    at: i.at,
    host: i.ports?.host ?? null,
    tailnet: i.ports?.tailnet ?? null,
    devices: i.devices
      ? {
          online: i.devices.devices.filter((d) => d.online).length,
          total: i.devices.devices.length,
          offline: others.filter((d) => !d.online).map((d) => d.name).slice(0, MAX_LIST),
        }
      : null,
    pool: i.devices
      ? {
          available: i.devices.pool.available,
          healthy: i.devices.pool.available && poolHosts.every((h) => !POOL_WARN.has(h.state)),
          hosts: poolHosts,
        }
      : null,
    services: i.ports || i.usage
      ? {
          listening: i.ports ? i.ports.ports.filter((p) => p.listening && p.visible !== false).length : null,
          inUse: i.usage ? inUse.slice(0, MAX_LIST) : null,
          idle: i.usage ? i.usage.idleServices : null,
        }
      : null,
    watchedDown: i.watching ? down.map((w) => ({ kind: w.kind, ...(w.port !== undefined ? { port: w.port } : {}), name: w.name, since: w.since })) : null,
    newDevices:
      nd === null
        ? null
        : typeof nd === 'number'
          ? { pending: nd }
          : {
              pending: nd.length,
              devices: nd.slice(0, MAX_LIST).map((d) => ({ name: d.name, kind: d.kind, since: d.since, service: d.service })),
            },
    ...(i.collection !== undefined ? { collection: i.collection ? collectionReport(i.collection) : null } : {}),
    ...(i.memory !== undefined ? { memory: i.memory ? memoryReport(i.memory) : null } : {}),
    unavailable: [...unavailable, ...(i.collection === null ? ['collection'] : []), ...(i.memory === null ? ['memory'] : [])],
  };
}

