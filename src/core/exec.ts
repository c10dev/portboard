import { spawn } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Git options for commands Portboard runs in checkouts it only looks at: a repo's or worktree's own config must not
 * make `git status` (or the status `git worktree remove` runs) start a program. core.fsmonitor names a hook command;
 * hooksPath points every hook nowhere. `-c` reaches git's child processes too (GIT_CONFIG_PARAMETERS).
 * docs/security-review/v1.0.md I4.
 */
export const GIT_NO_HOOKS: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/** Subprocesses started per command since the process began (for /api/health?detail and docs/operations.md). */
const spawned = new Map<string, number>();
const startedAt = Date.now();

export function runStats(): { since: string; total: number; perMinute: number; byCommand: Record<string, number> } {
  const total = [...spawned.values()].reduce((a, b) => a + b, 0);
  const minutes = Math.max(1 / 60, (Date.now() - startedAt) / 60_000);
  return { since: new Date(startedAt).toISOString(), total, perMinute: Math.round((total / minutes) * 10) / 10, byCommand: Object.fromEntries(spawned) };
}

/**
 * Run a command without a shell. `stopWhen` ends it early (as a failure) once the output matches —
 * for CLIs like `tailscale serve` that print an error and then wait forever.
 */
export function run(cmd: string, args: string[], timeoutMs = 10_000, stopWhen?: RegExp): Promise<RunResult> {
  spawned.set(cmd, (spawned.get(cmd) ?? 0) + 1);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (ok: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve({ ok, stdout, stderr: stderr || extra });
    };
    const timer = setTimeout(() => finish(false, `timed out after ${timeoutMs}ms`), timeoutMs);
    const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (which === 'out') stdout += chunk;
      else stderr += chunk;
      if (stopWhen?.test(stdout + stderr)) finish(false);
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `exit ${code}`));
  });
}

/**
 * A read-only command whose output several collectors want within seconds (`tailscale status --json`, `ip neigh`):
 * one subprocess per `ttlMs`, concurrent callers share the in-flight run. Never use it for commands that change state.
 */
const shared = new Map<string, { at: number; value: Promise<RunResult> }>();

export function runShared(cmd: string, args: string[], ttlMs = 5_000, now = Date.now()): Promise<RunResult> {
  const key = [cmd, ...args].join('\u0000');
  const hit = shared.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = run(cmd, args);
  shared.set(key, { at: now, value });
  return value;
}

/** Drop a cached runShared result (after a command that changes what it reports, e.g. `tailscale serve`). */
export function forgetShared(cmd: string, args: string[]): void {
  shared.delete([cmd, ...args].join('\u0000'));
}
