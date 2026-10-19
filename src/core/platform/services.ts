// The service manager (#11): every systemctl, journalctl and systemd-run call the server makes about units goes
// through here, so a machine without systemd (macOS, a container) gets a clear "not available" instead of a failed
// spawn.
//
//   systemd   the user manager, with exactly the arguments control.ts, proc.ts and devservers.ts always used
//   none      nothing is run; every call fails with UNAVAILABLE (the routes turn it into a 409 / 501 with that text)
//
// Plain processes (SIGTERM by pid) and docker containers never come through here: they work the same everywhere.
// `portboard install-service` writes launchd agents on macOS (src/cli.ts), but the running server does not drive
// launchd: a port's owner on a Mac is a plain process.

import { run, type RunResult } from '../exec.ts';
import { platform, type ServiceManagerName } from './index.ts';

export interface ServiceManager {
  readonly name: ServiceManagerName;
  /** why units can't be managed here; null for systemd */
  readonly unavailable: string | null;
  restart(unit: string): Promise<RunResult>;
  /** --no-block unless `wait` (a dev server stop waits, with a 20 s limit) */
  stop(unit: string, wait?: boolean): Promise<RunResult>;
  /** the last `lines` lines of a unit's journal, and where they came from */
  logs(unit: string, lines: string): Promise<RunResult & { source: string }>;
  /** `systemctl --user show -p <props> <units>` */
  show(units: string[], props: string, timeoutMs?: number): Promise<RunResult>;
  /** `systemctl --user list-units <pattern> --all --no-legend --plain` */
  list(pattern: string): Promise<RunResult>;
  /** `systemd-run <args>` (a transient unit: the dev servers) */
  startTransient(args: string[]): Promise<RunResult>;
}

export const UNAVAILABLE = 'systemd user units are not available on this platform';

export function systemdManager(exec: (cmd: string, args: string[], timeoutMs?: number) => Promise<RunResult> = run): ServiceManager {
  return {
    name: 'systemd',
    unavailable: null,
    restart: (unit) => exec('systemctl', ['--user', '--no-block', 'restart', unit]),
    stop: (unit, wait = false) => (wait ? exec('systemctl', ['--user', 'stop', unit], 20_000) : exec('systemctl', ['--user', '--no-block', 'stop', unit])),
    logs: async (unit, lines) => ({
      ...(await exec('journalctl', ['--user', '-u', unit, '-n', lines, '--no-pager', '-o', 'short-iso'])),
      source: `journalctl --user -u ${unit}`,
    }),
    show: (units, props, timeoutMs) =>
      timeoutMs === undefined ? exec('systemctl', ['--user', 'show', '-p', props, ...units]) : exec('systemctl', ['--user', 'show', '-p', props, ...units], timeoutMs),
    list: (pattern) => exec('systemctl', ['--user', 'list-units', pattern, '--all', '--no-legend', '--plain'], 5_000),
    startTransient: (args) => exec('systemd-run', args, 15_000),
  };
}

export function noServiceManager(reason = UNAVAILABLE): ServiceManager {
  const no = async (): Promise<RunResult> => ({ ok: false, stdout: '', stderr: reason });
  return {
    name: 'none',
    unavailable: reason,
    restart: no,
    stop: no,
    logs: async () => ({ ok: false, stdout: '', stderr: reason, source: '' }),
    show: no,
    list: no,
    startTransient: no,
  };
}

let current: ServiceManager | null = null;

/** The service manager platform() names (tests: setServiceManager) */
export function services(): ServiceManager {
  return (current ??= platform().services === 'systemd' ? systemdManager() : noServiceManager());
}

export function setServiceManager(m: ServiceManager | null): void {
  current = m;
}
