// The dashboard's shared runtime state, handed to every feature's routes, jobs and shutdown: the 2 s snapshot /
// topology / usage caches and the long-lived stores (history, uptime, alert checker, 새 기기 tracker, self-watch).
// Nothing starts here; the jobs the features declare do that (src/features/jobs.ts).
//
// The usage pipeline (topology → usage → history sample → 새 기기 observation) crosses features on purpose and lives
// here until one scheduler owns all collection (c10dev/portboard#24).

import { snapshot, type Snapshot } from '../core/index.ts';
import { topology, type Topology } from '../core/topology.ts';
import { usage, type Usage } from '../core/usage.ts';
import { loadNames, neighbors, ouiTable } from '../core/clients.ts';
import { defaultChecker, type Checker } from '../core/alerts.ts';
import { loadPrefs, newDeviceSettings } from '../core/prefs.ts';
import { createTracker, observationOf, withNewDevices, type Tracker } from '../core/known.ts';
import { HistoryStore, samplesOf, withHistory, type UsageWithHistory } from '../core/history.ts';
import { UptimeStore } from '../core/uptime.ts';
import { agents } from '../core/agents.ts';
import { pvePorts } from '../core/pveports.ts';
import { winPorts } from '../core/winports.ts';
import { createSelfWatch, type SelfWatch } from '../core/selfwatch.ts';
import { deviceResolver, loadAccessPolicy, loadWriteDevices, ownerLogin, type AccessPolicy, type Device, type WriteDevices } from '../core/access.ts';
import { AuditLog } from '../core/audit.ts';
import { cachedValue } from '../core/throttle.ts';
import type { Paths } from '../core/paths.ts';
import { serveStatus, type TailscaleInfo } from '../core/tailscale.ts';
import { resolveDashboardUrl } from '../core/site.ts';

async function withKnown(known: Tracker, u: UsageWithHistory) {
  const [neigh, oui, names, prefs] = await Promise.all([neighbors(), ouiTable(), loadNames(), loadPrefs()]);
  const settings = newDeviceSettings(prefs);
  await known.observe(observationOf(u, neigh, oui, names), settings).catch(() => []);
  return withNewDevices(u, await known.summary(settings));
}

export type UsageOut = Awaited<ReturnType<typeof withKnown>>;

/** How long a snapshot / topology / usage result is reused */
export const CACHE_MS = 2_000;
/** ?fresh skips that cache at most once per this long (in between it is served like a plain request) */
export const FRESH_MIN_MS = 5_000;

export interface ServerContext {
  paths: Paths;
  ts: TailscaleInfo;
  /** `ss` + probes, cached 2 s, one at a time; fresh skips the cache at most once per FRESH_MIN_MS */
  snapshot(fresh?: boolean): Promise<Snapshot>;
  topology(fresh?: boolean): Promise<Topology>;
  /** Usage joined with history and 새 기기; every computed result is also a history sample */
  usage(fresh?: boolean): Promise<UsageOut>;
  /** Drop a cache after a write that changes what it holds */
  invalidate(what: 'snapshot' | 'usage'): void;
  /** 새로고침: re-read the Proxmox host's and the desktop's ports soon (at most every 20 s); shows on the next poll */
  refreshHostPorts(): void;
  history: HistoryStore;
  uptime: UptimeStore;
  alerts: Checker;
  known: Tracker;
  selfwatch: SelfWatch;
  /** The owner's Tailscale login (PORTBOARD_OWNER_LOGIN, else this node's user), or null when unknown (#29) */
  owner(): Promise<string | null>;
  /** The tailnet device at an address (`tailscale whois`, cached per address) */
  device(addr: string): Promise<Device>;
  /** The write-device allowlist (access.json writeDevices + PORTBOARD_WRITE_DEVICES), null when not set */
  writeDevices(): Promise<WriteDevices | null>;
  /** Token mode (#12): access.json's mode and requireTokenOnLoopback, their env overrides and the owner token's hash */
  policy(): Promise<AccessPolicy>;
  /** 기록: every write through the routes (#30) */
  audit: AuditLog;
}

export async function createServerContext(paths: Paths, ts: TailscaleInfo): Promise<ServerContext> {
  // L1 (docs/security-review/v1.0.md): one computation at a time, shared; ?fresh skips the 2 s cache at most once per
  // FRESH_MIN_MS, so a loop of ?fresh requests from any tailnet device costs no more than the dashboard's own polling.
  const snap = cachedValue(() => snapshot(), { ttlMs: CACHE_MS, freshMinMs: FRESH_MIN_MS });
  const getSnapshot = (fresh = false): Promise<Snapshot> => snap.get(fresh);

  const topo = cachedValue((forced) => getSnapshot(forced).then((s) => topology(s)), { ttlMs: CACHE_MS, freshMinMs: FRESH_MIN_MS });
  const getTopology = (fresh = false): Promise<Topology> => topo.get(fresh);

  const history = await new HistoryStore().open();
  // 새 기기: every usage sample is also a known-devices observation (first run seeds, later runs diff and alert).
  // Links in alerts open the dashboard where tailscale serve publishes it (https 8443 since the connector took 443):
  // PORTBOARD_DASHBOARD_URL, else serve status, else portboard.json's dashboardUrl (site.ts).
  const dashboard = resolveDashboardUrl(ts.dnsName, await serveStatus().catch(() => []), paths.port);
  const known = createTracker({ alertsOn: paths.alertsOn, dashboard });

  const refreshHostPorts = () => {
    pvePorts().refreshLater(true);
    winPorts().refreshLater(true);
    agents().refresh();
  };

  // Every computed result is also a history sample (the usage feature's 30 s job covers the time nobody is looking).
  const use = cachedValue(
    (forced) => {
      if (forced) refreshHostPorts();
      return getTopology(forced)
        .then((t) => usage(t))
        .then((u: Usage) => {
          const now = Date.now();
          history.record(samplesOf(u), now);
          return withHistory(u, history.data, now);
        })
        .then((u) => withKnown(known, u));
    },
    { ttlMs: CACHE_MS, freshMinMs: FRESH_MIN_MS },
  );
  const getUsage = (fresh = false): Promise<UsageOut> => use.get(fresh);

  // Every down-alert check also goes into the uptime history (uptime.json), channel or not.
  const uptime = await new UptimeStore().open();
  const alerts = defaultChecker(() => getSnapshot().then((s) => s.ports), { record: (obs, t, quiet) => uptime.record(obs, t, quiet) });
  // Self-watch: alerts when a collector keeps failing, or a token nears expiry. Tracked with alerts off too.
  // Previews never send (paths.alertsOn is false unless PORTBOARD_PREVIEW_ALERTS=1); PORTBOARD_ALERTS=off silences production too.
  const selfwatch = createSelfWatch({ alertsOn: process.env.PORTBOARD_ALERTS !== 'off' && paths.alertsOn });

  return {
    paths,
    ts,
    snapshot: getSnapshot,
    topology: getTopology,
    usage: getUsage,
    invalidate(what) {
      if (what === 'snapshot') snap.invalidate();
      else use.invalidate();
    },
    refreshHostPorts,
    history,
    uptime,
    alerts,
    known,
    selfwatch,
    owner: () => ownerLogin(),
    device: deviceResolver(),
    writeDevices: () => loadWriteDevices(paths.access),
    policy: () => loadAccessPolicy(paths.access, paths.token),
    audit: new AuditLog(paths.audit),
  };
}
