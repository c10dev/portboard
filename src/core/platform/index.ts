// The platform layer (c10dev/portboard#11): which backends this process uses to read ports and processes and to act
// on services, picked once from process.platform with environment overrides for tests and odd setups.
//
//   linux (default)   ss + /proc, systemd user units (systemctl, journalctl, systemd-run): the original behaviour
//   darwin, others    lsof + ps (ports.ts, procs.ts here), no service manager: stop signals the process; restart,
//                     dev servers, unit logs and the memory view answer with a reason instead of failing
//   container         PORTBOARD_CONTAINER=1 (the Dockerfile sets it): no service manager and read-only by default
//
// Env (docs/config.md#platform-environment):
//   PORTBOARD_PORT_READER=ss|lsof      the port and process reader
//   PORTBOARD_SERVICES=systemd|none    the service manager (none: no systemctl / journalctl / systemd-run calls)
//   PORTBOARD_READ_ONLY=1|0            refuse every write (on in a container unless set to 0)
//   PORTBOARD_CONTAINER=1              running in the Docker image
//
// detectPlatform() is pure (test/platform.test.ts); platform() is the process's answer, computed on first use.

export type PortReader = 'ss' | 'lsof';
export type ServiceManagerName = 'systemd' | 'none';

export interface Platform {
  os: string;
  portReader: PortReader;
  services: ServiceManagerName;
  /** /proc is there to read (Linux): memory sampling, per-process environ/cwd, the worktree process scan */
  procfs: boolean;
  container: boolean;
  /** every write (HTTP write route, MCP action, auto-stop) is refused */
  readOnly: boolean;
  /** why readOnly is on, for the 403 and the log; null when it is off */
  readOnlyReason: string | null;
  /** env values that were not understood (the default was used instead) */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function pick<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T, warnings: string[]): T {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  warnings.push(`${key}=${env[key]} is not one of ${allowed.join(', ')}; using ${fallback}`);
  return fallback;
}

function flag(env: Env, key: string, warnings: string[]): boolean | null {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  warnings.push(`${key}=${env[key]} is not 1 or 0; ignored`);
  return null;
}

export function detectPlatform(env: Env = process.env, os: string = process.platform): Platform {
  const warnings: string[] = [];
  const linux = os === 'linux';
  const container = flag(env, 'PORTBOARD_CONTAINER', warnings) === true;
  const portReader = pick<PortReader>(env, 'PORTBOARD_PORT_READER', ['ss', 'lsof'], linux ? 'ss' : 'lsof', warnings);
  const services = pick<ServiceManagerName>(env, 'PORTBOARD_SERVICES', ['systemd', 'none'], linux && !container ? 'systemd' : 'none', warnings);
  const ro = flag(env, 'PORTBOARD_READ_ONLY', warnings);
  const readOnly = ro ?? container;
  const readOnlyReason = !readOnly ? null : ro ? 'PORTBOARD_READ_ONLY=1' : 'container (PORTBOARD_CONTAINER=1; PORTBOARD_READ_ONLY=0 allows writes)';
  return { os, portReader, services, procfs: linux, container, readOnly, readOnlyReason, warnings };
}

let current: Platform | null = null;

/** This process's platform, from process.env and process.platform at first use */
export function platform(): Platform {
  return (current ??= detectPlatform());
}

/** Tests: use this platform (null: detect again from the environment at the next call) */
export function setPlatform(p: Platform | null): void {
  current = p;
}

/** One line for the start log; null on a plain Linux install, which logs what it always did */
export function describePlatform(p: Platform = platform()): string | null {
  const parts: string[] = [];
  if (p.os !== 'linux' || p.portReader !== 'ss') parts.push(`ports via ${p.portReader}`);
  if (p.services !== 'systemd') parts.push('no service manager (restart, dev servers and unit logs unavailable)');
  if (!p.procfs) parts.push('no /proc (memory view unavailable)');
  if (p.container) parts.push('in a container');
  if (p.readOnly) parts.push(`read-only: ${p.readOnlyReason}`);
  for (const w of p.warnings) parts.push(w);
  return parts.length ? `[portboard] platform ${p.os}: ${parts.join('; ')}` : null;
}
