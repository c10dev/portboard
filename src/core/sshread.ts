// Reading another machine's listening ports over SSH with a dedicated forced-command key: the parts every such
// reader shares (pveports.ts for pve1 and its containers, winports.ts for the desktop's Windows side).
//
// Only key auth (BatchMode, IdentitiesOnly, -F /dev/null) against the host key already in known_hosts
// (StrictHostKeyChecking=yes), with no remote command: the key's forced command decides what runs. A request never
// waits for SSH except the very first one in a process; the result is cached and refreshed in the background about
// once a minute, backing off while it fails. Raw stderr (it names the user and address) never reaches a payload:
// errors are reduced to fixed codes and logged once per change of state.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import { reportHealth } from './health.ts';

export type SshReadError =
  | 'bad-config' // the config file is unreadable or invalid
  | 'no-user' // no remote user configured yet (the desktop's Windows user is learned at install time)
  | 'no-key' // the private key file is missing
  | 'not-installed' // Permission denied: the key isn't authorized on the other side yet
  | 'host-key' // known_hosts has no or a different key for the host
  | 'unreachable' // refused, no route, DNS
  | 'timeout'
  | 'bad-output' // answered, but not in the expected format
  | 'failed';

export interface SshTarget {
  host: string;
  /** null until known: the reader reports no-user and never connects */
  user: string | null;
  /** private key path (~ expanded) */
  key: string;
  enabled: boolean;
}

export interface SshReadStatus {
  enabled: boolean;
  ok: boolean;
  /** no attempt finished yet */
  pending: boolean;
  /** ms of the last finished attempt */
  checkedAt: number | null;
  /** ms of the last successful read */
  lastOk: number | null;
  error: SshReadError | null;
  /** consecutive failures */
  failures: number;
  /** ms of the next scheduled attempt */
  nextAt: number | null;
  setupUrl: string;
}

export const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** ssh argv: key auth only, no config files, the known host key or nothing, no remote command (the key forces it). */
export function sshArgs(t: SshTarget & { user: string }): string[] {
  return [
    '-F', '/dev/null',
    '-i', expandHome(t.key),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR',
    '-T', '-x', '-a',
    '-l', t.user,
    t.host,
  ];
}

/** ssh's result → a fixed error code, or null when the output looks like an answer. */
export function classifySsh(r: RunResult, timedOut: boolean, looksOk: boolean): SshReadError | null {
  if (timedOut) return 'timeout';
  if (looksOk) return null;
  const e = r.stderr;
  if (/Permission denied/i.test(e)) return 'not-installed';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .*(not known|mismatch)|No \S+ host key is known/i.test(e)) return 'host-key';
  if (/Connection refused|Connection timed out|No route to host|Network is unreachable|Could not resolve|Name or service not known|Connection closed by|Connection reset/i.test(e)) return 'unreachable';
  if (/Identity file .* not accessible|no such identity/i.test(e)) return 'no-key';
  return r.ok ? 'bad-output' : 'failed';
}

// ---- schedule ----

export const INTERVAL = 60_000;
const MAX_BACKOFF = 10 * 60_000;
/** Until the key is installed, every attempt is a failed login in the other side's auth log: every 5 min, not every minute. */
const WAITING = 5 * 60_000;

/** Delay before the next attempt: a minute when fine; doubling from a minute up to 10 min on failures. */
export function nextDelay(failures: number, error: SshReadError | null): number {
  if (!failures || !error) return INTERVAL;
  if (error === 'not-installed' || error === 'no-key' || error === 'no-user' || error === 'bad-config') return WAITING;
  return Math.min(MAX_BACKOFF, INTERVAL * 2 ** (failures - 1));
}

/** Last good data is shown at most this long after it was read */
export const STALE_AFTER = 15 * 60_000;

// ---- reader ----

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const TIMEOUT = 15_000;

export interface ReaderOptions {
  runner?: Runner;
  now?: () => number;
  log?: (line: string) => void;
  /** Preview/screenshots only: a command whose stdout stands in for the ssh call; undefined = read fakeEnv */
  fakeCmd?: string | null;
  /** Report every attempt to health.ts under this name (the process-wide readers) */
  health?: string;
}

/** Errors that mean "not set up yet" rather than "broke": only an outage once the read has worked (selfwatch.ts). */
const SETUP_ERRORS = new Set<SshReadError>(['no-key', 'not-installed', 'bad-config']);

export abstract class SshReader<C extends SshTarget, D extends { at: number }, S extends SshReadStatus = SshReadStatus> {
  protected data: D | null = null;
  protected status: S;
  protected runner: Runner;
  protected readonly now: () => number;
  private inflight: Promise<void> | null = null;
  private logged: string | null = null;
  private readonly log: (line: string) => void;
  private readonly fakeCmd: string[] | null;
  private readonly health: string | null;

  constructor(opts: ReaderOptions, fakeEnv: string, initial: S) {
    this.runner = opts.runner ?? run;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    const fake = opts.fakeCmd === undefined ? process.env[fakeEnv] : opts.fakeCmd;
    this.fakeCmd = fake ? fake.trim().split(/\s+/) : null;
    this.health = opts.health ?? null;
    this.status = initial;
  }

  protected abstract loadConfig(): Promise<C | string>;
  /** stdout → data; null when it isn't an answer in the expected format */
  protected abstract parse(stdout: string, at: number): D | null;
  /** cheap test that stdout is an answer, even when ssh's exit code says otherwise */
  protected abstract looksOk(stdout: string): boolean;
  /** "pve ports (pve1)" for the log */
  protected abstract label(): string;
  protected abstract summary(d: D): string;
  /** copy what the status shows from the config (node, device) */
  protected onConfig(_c: C): void {}

  /** Current status and the last good data (null once older than STALE_AFTER). */
  current(): { status: S; data: D | null } {
    const data = this.data && this.now() - this.data.at < STALE_AFTER ? this.data : null;
    return { status: { ...this.status }, data };
  }

  /** Start an attempt when one is due (or forced, at most every 20 s); never waits. */
  refreshLater(force = false) {
    const now = this.now();
    const due = this.status.nextAt === null || now >= this.status.nextAt;
    const recent = this.status.checkedAt !== null && now - this.status.checkedAt < 20_000;
    if (this.inflight || !(due || (force && !recent))) return;
    void this.refresh();
  }

  /** The first call in a process waits for one attempt so a fresh MCP process has an answer; later ones don't. */
  /**
   * The very first read waits for SSH at most `firstWaitMs` (default 400 ms); after that it answers `pending` and the
   * background refresh fills in, so a request right after a restart isn't held for the whole SSH round trip (#24).
   */
  async get(firstWaitMs = Number(process.env.PORTBOARD_SSH_FIRST_WAIT_MS ?? 400)): Promise<{ status: S; data: D | null }> {
    if (this.status.pending) {
      const done = this.inflight ?? this.refresh();
      if (firstWaitMs > 0 && Number.isFinite(firstWaitMs)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([done, new Promise<void>((r) => (timer = setTimeout(r, firstWaitMs)))]);
        clearTimeout(timer);
      } else await done;
    } else this.refreshLater();
    return this.current();
  }

  refresh(): Promise<void> {
    this.inflight ??= this.attempt().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async attempt() {
    const cfg = await this.loadConfig();
    let error: SshReadError | null = null;
    let data: D | null = null;
    let detail = '';
    if (typeof cfg === 'string') {
      error = 'bad-config';
      detail = cfg;
    } else {
      this.onConfig(cfg);
      this.status.enabled = cfg.enabled;
      if (!cfg.enabled) {
        this.data = null;
        this.status = { ...this.status, ok: false, pending: false, error: null, failures: 0, checkedAt: this.now(), nextAt: this.now() + INTERVAL };
        if (this.health) reportHealth(this.health, { ok: false, enabled: false, error: 'turned off' });
        return;
      }
      const user = cfg.user;
      const keyOk = this.fakeCmd || (await access(expandHome(cfg.key), constants.R_OK).then(() => true, () => false));
      if (!user && !this.fakeCmd) error = 'no-user';
      else if (!keyOk) error = 'no-key';
      else {
        const started = this.now();
        const r = this.fakeCmd ? await this.runner(this.fakeCmd[0], this.fakeCmd.slice(1), TIMEOUT) : await this.runner('ssh', sshArgs({ ...cfg, user: user! }), TIMEOUT);
        error = classifySsh(r, !r.ok && this.now() - started >= TIMEOUT - 50, this.looksOk(r.stdout));
        if (!error) data = this.parse(r.stdout, this.now());
        if (!error && !data) error = 'bad-output';
        detail = r.stderr.trim().split('\n').pop() ?? '';
      }
    }
    const now = this.now();
    const failures = error ? this.status.failures + 1 : 0;
    if (data) this.data = data;
    this.status = { ...this.status, ok: !error, pending: false, checkedAt: now, lastOk: data ? now : this.status.lastOk, error, failures, nextAt: now + nextDelay(failures, error) };
    // The fixed code only: detail (ssh's stderr) names the user and address.
    if (this.health) reportHealth(this.health, { ok: !error, error, enabled: error !== 'no-user', setup: !!error && SETUP_ERRORS.has(error) });
    // One log line per change of state, not one a minute.
    const state = error ?? 'ok';
    if (state !== this.logged) {
      this.logged = state;
      this.log(`[portboard] ${this.label()}: ${error ? `${error}${detail ? ` — ${detail}` : ''}` : `ok, ${this.summary(data!)}`}`);
    }
  }
}
