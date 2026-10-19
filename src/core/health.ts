// Health of Portboard's own data collection: one record per collector (compute-pool, Proxmox, the SSH port reads,
// host-key probes, usage sampling, history and known-devices files, the alert checker). Collectors report each real
// attempt here as it finishes, so watching them never causes an extra fetch. selfwatch.ts reads the registry,
// /api/health?detail shows it.
//
// lastError is short and free of secrets: callers pass fixed codes or their own messages, and clean() still strips
// URLs, long tokens and anything after a credential-looking key before it is stored.

import { SITE } from './site.ts';
import { t } from './i18n.ts';

export interface CollectorHealth {
  name: string;
  /** false: turned off or not set up (no proxmox.json, no Windows user, key not installed yet): not an outage */
  enabled: boolean;
  ok: boolean;
  /** ms of the last finished attempt */
  checkedAt: number;
  /** ms of the last successful attempt in this process */
  lastOk: number | null;
  lastError: string | null;
  /** consecutive failed attempts */
  failures: number;
  /** ms of the first failed attempt of the current run of failures (in this process) */
  since: number | null;
  /** the failure is a setup step not done yet (key not installed, invalid config): only an outage once it has worked */
  setup: boolean;
}

export interface Report {
  ok: boolean;
  error?: string | null;
  /** default true */
  enabled?: boolean;
  setup?: boolean;
}

/** Display order and Korean labels for the UI. */
export const COLLECTORS: Record<string, string> = {
  get usage() {
    return t('health.collector.usage');
  },
  pool: 'compute-pool',
  proxmox: 'Proxmox API',
  get 'pve-ports'() {
    return t('health.collector.pvePorts', { node: SITE.pve.node });
  },
  get 'win-ports'() {
    return t('health.collector.winPorts');
  },
  get hostkeys() {
    return t('health.collector.hostkeys');
  },
  get history() {
    return t('health.collector.history');
  },
  get 'known-devices'() {
    return t('health.collector.knownDevices');
  },
  get alerts() {
    return t('health.collector.alerts');
  },
  get memory() {
    return t('health.collector.memory');
  },
};

const MAX_ERROR = 120;

/** An error message as it may be shown or sent: no URLs, no long tokens, no key=value secrets, one short line. */
export function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  let s = String(text).split('\n')[0];
  s = s.replace(/https?:\/\/\S+/gi, '<url>');
  s = s.replace(/\b(PVEAPIToken|authorization|token|secret|password|topic)\b\s*[=:]\s*\S+/gi, '$1=***');
  s = s.replace(/[A-Za-z0-9+/_=-]{32,}/g, '***');
  s = s.trim();
  return s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s || null;
}

export class HealthRegistry {
  private records = new Map<string, CollectorHealth>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  report(name: string, r: Report): void {
    const t = this.now();
    const prev = this.records.get(name);
    const enabled = r.enabled ?? true;
    const ok = enabled && r.ok;
    this.records.set(name, {
      name,
      enabled,
      ok,
      checkedAt: t,
      lastOk: ok ? t : (prev?.lastOk ?? null),
      lastError: ok ? null : (clean(r.error) ?? (enabled ? 'failed' : null)),
      failures: ok || !enabled ? 0 : (prev?.failures ?? 0) + 1,
      since: ok || !enabled ? null : (prev && !prev.ok && prev.enabled ? prev.since : t),
      setup: !ok && enabled && !!r.setup,
    });
  }

  get(name: string): CollectorHealth | undefined {
    const r = this.records.get(name);
    return r && { ...r };
  }

  /** Every collector that reported in this process, in COLLECTORS order. */
  all(): CollectorHealth[] {
    const order = Object.keys(COLLECTORS);
    const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
    return [...this.records.values()].map((r) => ({ ...r })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  }

  clear(): void {
    this.records.clear();
  }
}

/** The process-wide registry the collectors report to. */
export const health = new HealthRegistry();

export const reportHealth = (name: string, r: Report) => health.report(name, r);
