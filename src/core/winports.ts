// Listening TCP ports on the Windows side of the desktop (outside WSL), read over Windows OpenSSH with the same
// dedicated key as pve1 (~/.ssh/portboard_ro), installed there as a forced-command key whose only command is
//   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\portboard\ports.ps1
// That prints one line per listening socket, tab-separated, CRLF:
//   LocalAddress<TAB>LocalPort<TAB>PID<TAB>ProcessName        (ProcessName empty when access is denied)
// The WSL side keeps coming from compute-pool; devices.ts merges both onto the desktop's card (desktop-pc).
// Setup: docs/runbooks/ssh-readonly-setup.md
//
// Config: ~/.config/portboard/winports.json (override with PORTBOARD_WINPORTS)
//   {"host": "192.168.1.7", "user": "Dev", "key": "~/.ssh/portboard_ro", "device": "desktop-pc", "enabled": true}
// (all optional: those are the defaults, from site.ts or portboard.json's "windows"). With "user": null the reader reports no-user (the 기기 tab shows the
// setup hint) and never connects.

import { readFile } from 'node:fs/promises';
import { PATHS } from './paths.ts';
import { RUNBOOKS } from './runbooks.ts';
import { SITE } from './site.ts';
import type { ListenPort } from './pool.ts';
import { HOST, SshReader, type ReaderOptions, type SshReadStatus } from './sshread.ts';

export const WINPORTS_PATH = PATHS.winports;
export const WIN_SETUP_URL = `${RUNBOOKS.sshSetup}#3-windows-desktop`;

export interface WinPortsConfig {
  host: string;
  /** the Windows account the key is installed for (Dev); null: don't connect */
  user: string | null;
  key: string;
  /** the tailnet device whose card gets the ports */
  device: string;
  enabled: boolean;
}

/** SITE_DEFAULTS.windows, under portboard.json's "windows"; winports.json goes on top of these */
export const WIN_DEFAULTS: WinPortsConfig = { ...SITE.windows };

export interface WinPortsData {
  /** ms: when it was read */
  at: number;
  sockets: ListenPort[];
}

export interface WinPortsStatus extends SshReadStatus {
  /** the device the ports belong to (no address, no user) */
  device: string;
}

// ---- config ----

/**
 * Windows account names may hold spaces and non-ASCII letters; they go to ssh as their own argv entry (-l), never
 * through a shell. Refused: a leading '-' (an option), control characters, and '%' (ssh expands %-tokens).
 */
const WIN_USER = /^[^\s\-%\x00-\x1f\x7f](?:[^%\x00-\x1f\x7f]{0,62}[^\s%\x00-\x1f\x7f])?$/u;

export function checkWinConfig(raw: unknown): WinPortsConfig | string {
  // No winports.json: the defaults alone, still checked (portboard.json's "windows" may have changed them)
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'winports.json must be an object';
  const c = { ...WIN_DEFAULTS, ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  for (const k of ['host', 'key', 'device']) if (typeof c[k] !== 'string' || !c[k]) return `winports.json: ${k} must be a non-empty string`;
  if (!HOST.test(c.host as string)) return 'winports.json: host must be an IP or host name';
  if (c.user !== null && c.user !== '' && (typeof c.user !== 'string' || !WIN_USER.test(c.user))) return 'winports.json: user must be a Windows account name (or null)';
  if (typeof c.enabled !== 'boolean') return 'winports.json: enabled must be true or false';
  return { host: c.host as string, user: (c.user as string | null) || null, key: c.key as string, device: c.device as string, enabled: c.enabled };
}

export async function loadWinConfig(path = WINPORTS_PATH): Promise<WinPortsConfig | string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return checkWinConfig(undefined);
  }
  try {
    return checkWinConfig(JSON.parse(text));
  } catch {
    return 'winports.json is not valid JSON';
  }
}

// ---- parsing ----

const LINE = /^([^\t]+)\t(\d{1,5})\t(\d+)(?:\t([^\t]*))?/;

/** ports.ps1 output → sockets (no pids kept). null when no line has the expected shape. */
export function parseWinPorts(text: string, at = Date.now()): WinPortsData | null {
  const sockets: ListenPort[] = [];
  const seen = new Set<string>();
  let valid = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = LINE.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const port = Number(m[2]);
    if (port <= 0 || port > 65535) continue;
    valid++;
    const address = m[1].trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const process = (m[4] ?? '').trim().replace(/\.exe$/i, '');
    const key = `${address}|${port}|${process}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sockets.push(process ? { port, address, process } : { port, address });
  }
  return valid ? { at, sockets } : null;
}

// ---- collector ----

export class WinPortsCollector extends SshReader<WinPortsConfig, WinPortsData, WinPortsStatus> {
  private readonly configPath: string;

  constructor(opts: ReaderOptions & { configPath?: string } = {}) {
    super(opts, 'PORTBOARD_WINPORTS_CMD', {
      enabled: true, device: WIN_DEFAULTS.device, ok: false, pending: true, checkedAt: null, lastOk: null, error: null, failures: 0, nextAt: null, setupUrl: WIN_SETUP_URL,
    });
    this.configPath = opts.configPath ?? WINPORTS_PATH;
  }

  protected loadConfig() {
    return loadWinConfig(this.configPath);
  }
  protected parse(stdout: string, at: number) {
    return parseWinPorts(stdout, at);
  }
  protected looksOk(stdout: string) {
    return /^[^\t\r\n]+\t\d{1,5}\t\d+/m.test(stdout.replace(/^\uFEFF/, ''));
  }
  protected label() {
    return `windows ports (${this.status.device})`;
  }
  protected summary(d: WinPortsData) {
    return `${d.sockets.length} sockets`;
  }
  protected onConfig(c: WinPortsConfig) {
    this.status.device = c.device;
  }
}

let shared: WinPortsCollector | null = null;

/** The process-wide collector (devices.ts and server.ts share it). */
export function winPorts(): WinPortsCollector {
  shared ??= new WinPortsCollector({ health: 'win-ports' });
  return shared;
}
