// Listening ports of a Proxmox host and its running containers, read over SSH with a dedicated, forced-command key.
//
// On pve1, /root/.ssh/authorized_keys holds
//   command="/usr/local/bin/portboard-ports",restrict ssh-ed25519 … portboard-ro@<this host>
// so the key can run nothing but that script (no shell, no forwarding, no pty). It prints
//   ## host        then `ss -ltnpH` (or `ss -ltnH`)
//   ## ct <vmid>   then that running container's `ss -ltnpH` / `ss -ltnH` / `netstat -ltn` (via `pct exec`)
// Setup: docs/runbooks/ssh-readonly-setup.md
//
// Config (optional; the defaults are pve1's, from site.ts, or portboard.json's "pve"): ~/.config/portboard/pveports.json,
// override with PORTBOARD_PVEPORTS
//   {"host": "192.168.1.201", "user": "root", "key": "~/.ssh/portboard_ro", "node": "pve1", "enabled": true}
// The SSH call, schedule, backoff and error codes are shared with winports.ts (sshread.ts).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { RUNBOOKS } from './runbooks.ts';
import { SITE } from './site.ts';
import type { RunResult } from './exec.ts';
import type { ListenPort } from './pool.ts';
import { parseSs } from './ss.ts';
import { classifySsh, HOST, SshReader, type ReaderOptions, type SshReadError, type SshReadStatus } from './sshread.ts';

export { expandHome, INTERVAL, nextDelay, sshArgs, STALE_AFTER } from './sshread.ts';

export const PVEPORTS_PATH = PATHS.pveports;
export const SETUP_URL = `${RUNBOOKS.sshSetup}#2-proxmox-ve-host`;

export interface PvePortsConfig {
  host: string;
  user: string;
  /** private key path (~ expanded) */
  key: string;
  /** the Proxmox node (and tailnet device) the host section belongs to */
  node: string;
  enabled: boolean;
}

/** SITE_DEFAULTS.pve (pve1), under portboard.json's "pve"; pveports.json goes on top of these */
export const DEFAULT_CONFIG: PvePortsConfig = { ...SITE.pve };

export type PvePortsError = SshReadError;

export interface PvePortsData {
  /** ms: when it was read */
  at: number;
  host: ListenPort[];
  /** vmid → that container's listening sockets */
  cts: Record<number, ListenPort[]>;
}

export interface PvePortsStatus extends SshReadStatus {
  /** node name the host section belongs to (no address, no user) */
  node: string;
}

// ---- config ----

const USER = /^[a-z_][a-z0-9_-]*$/i;

export function checkConfig(raw: unknown): PvePortsConfig | string {
  // No pveports.json: the defaults alone, still checked (portboard.json's "pve" may have changed them)
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'pveports.json must be an object';
  const c = { ...DEFAULT_CONFIG, ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  for (const k of ['host', 'user', 'key', 'node']) if (typeof c[k] !== 'string' || !c[k]) return `pveports.json: ${k} must be a non-empty string`;
  // Validated so neither can be read as an ssh option.
  if (!HOST.test(c.host as string)) return 'pveports.json: host must be an IP or host name';
  if (!USER.test(c.user as string)) return 'pveports.json: user must be a plain user name';
  if (typeof c.enabled !== 'boolean') return 'pveports.json: enabled must be true or false';
  return { host: c.host as string, user: c.user as string, key: c.key as string, node: c.node as string, enabled: c.enabled };
}

export async function loadConfig(path = PVEPORTS_PATH): Promise<PvePortsConfig | string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return checkConfig(undefined);
  }
  try {
    return checkConfig(JSON.parse(text));
  } catch {
    return 'pveports.json is not valid JSON';
  }
}

// ---- parsing ----

/** `1234/sshd` in a netstat -p column → sshd */
const NETSTAT_PROC = /\s(\d+)\/(\S+)\s*$/;

/** One section's text → ListenPort[] (ss with or without -p, netstat -ltn[p]); headers and junk lines are skipped. */
export function parseListeners(text: string): ListenPort[] {
  const out: ListenPort[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const [l] = parseSs(line);
    if (!l || l.port <= 0 || l.port > 65535) continue;
    // netstat prints udp/unix rows only when asked; skip anything that says so anyway
    if (/^(udp|raw|unix)/i.test(line.trim())) continue;
    const proc = processName(l.processes.map((p) => p.name)) ?? NETSTAT_PROC.exec(line)?.[2];
    const key = `${l.address}|${l.port}|${proc ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proc ? { port: l.port, address: l.address, process: proc } : { port: l.port, address: l.address });
  }
  return out;
}

/**
 * One name for a socket's owners: systemd only when nothing else (socket activation), then the shortest, which is the
 * parent of truncated worker names ("pveproxy worker", "pveproxy" → pveproxy).
 */
export function processName(names: string[]): string | undefined {
  const uniq = [...new Set(names.filter(Boolean))];
  const real = uniq.filter((n) => n !== 'systemd');
  return (real.length ? real : uniq).sort((a, b) => a.length - b.length)[0];
}

/** The script's whole output → host and per-container sockets; null when there is no "## host" section. */
export function parseOutput(text: string, at = Date.now()): PvePortsData | null {
  const sections: { kind: 'host' | 'ct'; vmid: number; lines: string[] }[] = [];
  let cur: (typeof sections)[number] | null = null;
  for (const line of text.split('\n')) {
    const head = /^##\s+(host|ct\s+(\d+))\s*$/.exec(line.trim());
    if (head) {
      cur = head[2] ? { kind: 'ct', vmid: Number(head[2]), lines: [] } : { kind: 'host', vmid: 0, lines: [] };
      sections.push(cur);
      continue;
    }
    cur?.lines.push(line);
  }
  const host = sections.find((s) => s.kind === 'host');
  if (!host) return null;
  const cts: Record<number, ListenPort[]> = {};
  for (const s of sections) if (s.kind === 'ct') cts[s.vmid] = [...(cts[s.vmid] ?? []), ...parseListeners(s.lines.join('\n'))];
  return { at, host: parseListeners(host.lines.join('\n')), cts };
}

export function classify(r: RunResult, timedOut: boolean): PvePortsError | null {
  return classifySsh(r, timedOut, /^##\s+host\s*$/m.test(r.stdout));
}

// ---- collector ----

export class PvePortsCollector extends SshReader<PvePortsConfig, PvePortsData, PvePortsStatus> {
  private readonly configPath: string;

  constructor(opts: ReaderOptions & { configPath?: string } = {}) {
    super(opts, 'PORTBOARD_PVEPORTS_CMD', {
      enabled: true, node: DEFAULT_CONFIG.node, ok: false, pending: true, checkedAt: null, lastOk: null, error: null, failures: 0, nextAt: null, setupUrl: SETUP_URL,
    });
    this.configPath = opts.configPath ?? PVEPORTS_PATH;
  }

  protected loadConfig() {
    return loadConfig(this.configPath);
  }
  protected parse(stdout: string, at: number) {
    return parseOutput(stdout, at);
  }
  protected looksOk(stdout: string) {
    return /^##\s+host\s*$/m.test(stdout);
  }
  protected label() {
    return `pve ports (${this.status.node})`;
  }
  protected summary(d: PvePortsData) {
    return `${d.host.length} host sockets, ${Object.keys(d.cts).length} containers`;
  }
  protected onConfig(c: PvePortsConfig) {
    this.status.node = c.node;
  }
}

let shared: PvePortsCollector | null = null;

/** The process-wide collector (devices.ts and server.ts share it). */
export function pvePorts(): PvePortsCollector {
  shared ??= new PvePortsCollector({ health: 'pve-ports' });
  return shared;
}
