// Restart / stop / logs for whatever owns a port. Targets are resolved server-side from the
// snapshot (systemd user unit → docker container → plain process); clients only ever pass a port.

import { open, readlink, stat } from 'node:fs/promises';
import { run } from './exec.ts';
import { platform } from './platform/index.ts';
import { stdioFiles } from './platform/procs.ts';
import { services } from './platform/services.ts';
import type { ActionResult } from './tailscale.ts';
import { t } from './i18n.ts';

export type Control =
  | { type: 'systemd'; unit: string }
  | { type: 'docker'; container: string }
  | { type: 'process'; pids: number[] };

/** Never stop ourselves: the dashboard would go away with nothing to bring it back. */
export const SELF_UNIT = 'portboard.service';

export function controlFor(o: { container: string | null; processes: { pid: number; unit: string | null }[] }): Control | null {
  const unit = o.processes.find((p) => p.unit)?.unit;
  if (unit) return { type: 'systemd', unit };
  if (o.container) return { type: 'docker', container: o.container };
  if (o.processes.length) return { type: 'process', pids: o.processes.map((p) => p.pid) };
  return null;
}

/** Why writes are refused on this install (PORTBOARD_READ_ONLY, a container), or null (#11) */
export function readOnlyRefusal(): ActionResult | null {
  const p = platform();
  return p.readOnly ? { ok: false, message: t('errors.readOnly', { reason: p.readOnlyReason }) } : null;
}

export async function restartTarget(c: Control): Promise<ActionResult> {
  const refused = readOnlyRefusal();
  if (refused) return refused;
  if (c.type === 'systemd') {
    const sm = services();
    if (sm.unavailable) return { ok: false, message: `${c.unit}: ${sm.unavailable}` };
    if (c.unit === SELF_UNIT) {
      // Restarting ourselves: let the HTTP reply leave first, systemd SIGTERMs us right away otherwise.
      setTimeout(() => void sm.restart(c.unit), 500);
      return { ok: true, message: `restarting ${c.unit} in a moment` };
    }
    const r = await sm.restart(c.unit);
    return r.ok ? { ok: true, message: `restarting ${c.unit}` } : { ok: false, message: (r.stderr || r.stdout).trim() };
  }
  if (c.type === 'docker') {
    const r = await run('docker', ['restart', c.container], 60_000);
    return r.ok ? { ok: true, message: `restarted ${c.container}` } : { ok: false, message: (r.stderr || r.stdout).trim() };
  }
  return { ok: false, message: 'not a systemd service or docker container — restart it where it was started' };
}

export async function stopTarget(c: Control): Promise<ActionResult> {
  const refused = readOnlyRefusal();
  if (refused) return refused;
  if (c.type === 'systemd') {
    if (c.unit === SELF_UNIT) return { ok: false, message: 'refusing to stop portboard itself' };
    const sm = services();
    if (sm.unavailable) return { ok: false, message: `${c.unit}: ${sm.unavailable}` };
    const r = await sm.stop(c.unit);
    return r.ok ? { ok: true, message: `stopping ${c.unit}` } : { ok: false, message: (r.stderr || r.stdout).trim() };
  }
  if (c.type === 'docker') {
    const r = await run('docker', ['stop', c.container], 60_000);
    return r.ok ? { ok: true, message: `stopped ${c.container}` } : { ok: false, message: (r.stderr || r.stdout).trim() };
  }
  if (c.pids.includes(process.pid)) return { ok: false, message: 'refusing to stop portboard itself' };
  const failed: string[] = [];
  for (const pid of c.pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      failed.push(`${pid}: ${(err as Error).message}`);
    }
  }
  return failed.length
    ? { ok: false, message: `SIGTERM failed for ${failed.join(', ')}` }
    : { ok: true, message: `sent SIGTERM to pid ${c.pids.join(', ')}` };
}

export interface Logs {
  ok: boolean;
  source: string;
  lines: string[];
  message?: string;
}

export const MAX_LOG_LINES = 1000;

export async function logsFor(c: Control, lines: number): Promise<Logs> {
  const n = String(Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines))));
  if (c.type === 'systemd') {
    const r = await services().logs(c.unit, n);
    return { ok: r.ok, source: r.source, lines: splitLines(r.stdout), message: r.ok ? undefined : r.stderr.trim() };
  }
  if (c.type === 'docker') {
    // docker logs replays the container's stdout and stderr on the matching streams; keep both.
    const r = await run('docker', ['logs', '--tail', n, '--timestamps', c.container], 15_000);
    const merged = [...splitLines(r.stdout), ...splitLines(r.stderr)].sort();
    return { ok: r.ok, source: `docker logs ${c.container}`, lines: merged.slice(-Number(n)) };
  }
  // Plain process: only readable when stdout/stderr were redirected to a regular file.
  if (!platform().procfs) {
    // no /proc: lsof says where descriptors 1 and 2 go (#11)
    for (const pid of c.pids) {
      for (const target of await stdioFiles(pid)) {
        const st = await stat(target).catch(() => null);
        if (st?.isFile()) return { ok: true, source: target, lines: await tailFile(target, st.size, Number(n)) };
      }
    }
  }
  for (const pid of c.pids) {
    for (const fd of [1, 2]) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
      if (!target?.startsWith('/') || target.startsWith('/dev/')) continue;
      const st = await stat(target).catch(() => null);
      if (!st?.isFile()) continue;
      return { ok: true, source: target, lines: await tailFile(target, st.size, Number(n)) };
    }
  }
  return {
    ok: false,
    source: 'process',
    lines: [],
    message: 'output goes to a terminal or pipe, not a file or the journal — check the terminal that started it',
  };
}

async function tailFile(path: string, size: number, n: number): Promise<string[]> {
  const len = Math.min(size, 512 * 1024);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = splitLines(buf.toString('utf8'));
    if (len < size) lines.shift(); // first line is probably cut
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}

function splitLines(s: string): string[] {
  const lines = s.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Ports to suggest for a new dev server: not listening, not served, outside the ephemeral range. */
export function pickFreePorts(taken: Set<number>, count: number, preferred?: number): number[] {
  const inEphemeral = (p: number) => p >= 32768 && p <= 60999;
  const start = preferred && preferred >= 1024 && preferred <= 65535 ? preferred : 3000;
  const end = start <= 9999 ? 9999 : 65535;
  const out: number[] = [];
  const scan = (from: number, to: number) => {
    for (let p = from; p <= to && out.length < count; p++) {
      if (!taken.has(p) && !inEphemeral(p) && !out.includes(p)) out.push(p);
    }
  };
  scan(start, end);
  if (out.length < count && start > 3000) scan(3000, 9999);
  return out;
}
