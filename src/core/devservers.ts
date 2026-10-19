// Start/stop a worktree's dev server (c10dev/portboard#28) as a transient systemd user unit, on the worktree's
// reserved port (or a free one, which then gets reserved so a restart keeps it).
//
//   systemd-run --user --unit pb-dev-<repo>-<hash> --collect -p WorkingDirectory=<worktree> \
//     --setenv=PORT=<p> -- <node's npm> run <script> [-- <framework port flags>]
//
// Only directories that are worktrees (or main checkouts) of the repos Portboard scans, and only scripts that exist in
// their package.json. Logs: `journalctl --user -u <unit>` (the existing logs action works on the port).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { services } from './platform/services.ts';
import { t } from './i18n.ts';

export const UNIT_PREFIX = 'pb-dev-';
export const SCRIPTS = ['dev', 'start', 'preview', 'serve'] as const;

export type Framework = 'vite' | 'next' | 'astro' | 'generic';

export interface DevScripts {
  /** script name → command text, only the ones Portboard can start */
  scripts: Record<string, string>;
  /** The script it starts by default (dev, else start, …) */
  preferred: string | null;
}

export interface DevServer {
  unit: string;
  path: string;
  active: boolean;
  state: string;
  description: string;
  port: number | null;
  since: string | null;
}

const HOME = homedir();

export async function devScripts(dir: string): Promise<DevScripts> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const all = pkg?.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, unknown>) : {};
    const scripts: Record<string, string> = {};
    for (const s of SCRIPTS) if (typeof all[s] === 'string') scripts[s] = all[s] as string;
    return { scripts, preferred: SCRIPTS.find((s) => Object.hasOwn(scripts, s)) ?? null };
  } catch {
    return { scripts: {}, preferred: null };
  }
}

/** Whether `name` is one of the scripts Portboard may start here: own keys only (`in` is also true for constructor,
 * toString, __proto__…; docs/security-review/v1.0.md I2). */
export function hasScript(s: DevScripts, name: string): boolean {
  return Object.hasOwn(s.scripts, name);
}

/** The framework from the script's own command text (a repo can depend on both vite and next). */
export function frameworkOf(command: string): Framework {
  if (/\bnext\b/.test(command)) return 'next';
  if (/\bastro\b/.test(command)) return 'astro';
  if (/\bvite\b/.test(command)) return 'vite';
  return 'generic';
}

/** Extra arguments after `npm run <script> --` so the server binds to the chosen port on loopback. */
export function portArgs(fw: Framework, port: number): string[] {
  if (fw === 'vite') return ['--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  if (fw === 'next') return ['-p', String(port), '-H', '127.0.0.1'];
  if (fw === 'astro') return ['--port', String(port), '--host', '127.0.0.1'];
  return []; // PORT / HOST env only
}

export function unitFor(dir: string): string {
  const base = dir.split('/').filter(Boolean).slice(-2).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').slice(0, 40);
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `${UNIT_PREFIX}${base}-${hash}.service`.replace(/--+/g, '-');
}

/**
 * The Claude session that asked for the server (the stdio MCP server runs as its child), passed on to the unit so
 * owners.ts can tell whose server it is: systemd-run doesn't inherit the caller's environment (#43). Only the MCP
 * path passes its env; the dashboard's start button belongs to no session.
 */
export function claudeEnvArgs(env: Record<string, string | undefined>): string[] {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id)) return [];
  const pid = env.CLAUDE_PID && /^\d+$/.test(env.CLAUDE_PID) ? [`--setenv=CLAUDE_PID=${env.CLAUDE_PID}`] : [];
  return [`--setenv=CLAUDE_CODE_SESSION_ID=${id}`, ...pid];
}

export function startArgs(o: { unit: string; dir: string; script: string; fw: Framework; port: number; description: string; nodeBin: string; claudeEnv?: string[] }): string[] {
  const extra = portArgs(o.fw, o.port);
  return [
    '--user',
    `--unit=${o.unit}`,
    '--collect',
    `--description=${o.description}`,
    `--property=WorkingDirectory=${o.dir}`,
    `--setenv=PORT=${o.port}`,
    '--setenv=HOST=127.0.0.1',
    '--setenv=BROWSER=none',
    `--setenv=PATH=${o.nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    `--setenv=HOME=${HOME}`,
    ...(o.claudeEnv ?? []),
    '--',
    join(o.nodeBin, 'npm'),
    'run',
    o.script,
    ...(extra.length ? ['--', ...extra] : []),
  ];
}

export async function listDevServers(): Promise<DevServer[]> {
  const sm = services();
  // no systemd (#11): Portboard can't have started any
  if (sm.unavailable) return [];
  const r = await sm.list(`${UNIT_PREFIX}*`);
  const units = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u?.startsWith(UNIT_PREFIX));
  if (!units.length) return [];
  const show = await sm.show(units, 'Id,WorkingDirectory,ActiveState,SubState,Description,ActiveEnterTimestamp', 5_000);
  const out: DevServer[] = [];
  for (const block of show.stdout.split('\n\n')) {
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(block)?.[1] ?? '';
    const unit = get('Id');
    if (!unit) continue;
    const desc = get('Description');
    const port = Number(/:(\d{2,5})\b/.exec(desc)?.[1] ?? 0) || null;
    const ts = get('ActiveEnterTimestamp');
    out.push({ unit, path: get('WorkingDirectory'), active: get('ActiveState') === 'active', state: `${get('ActiveState')}/${get('SubState')}`, description: desc, port, since: ts && ts !== 'n/a' ? new Date(ts).toISOString() : null });
  }
  return out;
}

export interface StartPlan {
  unit: string;
  dir: string;
  script: string;
  fw: Framework;
  port: number;
  description: string;
  args: string[];
}

export function planStart(o: { dir: string; label: string; script: string; command: string; port: number; nodeBin?: string; env?: Record<string, string | undefined> }): StartPlan {
  const unit = unitFor(o.dir);
  const fw = frameworkOf(o.command);
  const description = `Portboard dev: ${o.label} :${o.port} (${o.script})`;
  const nodeBin = o.nodeBin ?? dirname(process.execPath);
  return { unit, dir: o.dir, script: o.script, fw, port: o.port, description, args: startArgs({ unit, dir: o.dir, script: o.script, fw, port: o.port, description, nodeBin, claudeEnv: claudeEnvArgs(o.env ?? {}) }) };
}

export async function startUnit(plan: StartPlan): Promise<{ ok: boolean; message: string }> {
  const r = await services().startTransient(plan.args);
  return r.ok ? { ok: true, message: t('devservers.started', { unit: plan.unit, port: plan.port, fw: plan.fw }) } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
}

export async function stopUnit(unit: string): Promise<{ ok: boolean; message: string }> {
  if (!unit.startsWith(UNIT_PREFIX)) return { ok: false, message: 'not a Portboard dev server unit' };
  const r = await services().stop(unit, true);
  return r.ok ? { ok: true, message: t('devservers.stopped', { unit }) } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
}
