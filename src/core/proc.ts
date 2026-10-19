// Per-process details from /proc and systemd (user units only).

import { readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { run } from './exec.ts';

export interface ProcInfo {
  pid: number;
  cmdline: string;
  cwd: string | null;
  project: string | null;
  unit: string | null;
  unitDescription: string | null;
}

const HOME = homedir();
const PROJECTS = `${HOME}/projects/`;

export async function procInfo(pid: number): Promise<ProcInfo> {
  const [cmdline, cwd, cgroup] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.split('\0').filter(Boolean).join(' ')).catch(() => ''),
    readlink(`/proc/${pid}/cwd`).catch(() => null),
    readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => ''),
  ]);
  return {
    pid,
    cmdline: cmdline.length > 300 ? `${cmdline.slice(0, 300)}…` : cmdline,
    cwd: cwd ? shortPath(cwd) : null,
    project: cwd ? projectOf(cwd) : null,
    unit: unitOf(cgroup),
    unitDescription: null,
  };
}

export function shortPath(p: string): string {
  return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

export function projectOf(cwd: string): string | null {
  if (!cwd.startsWith(PROJECTS)) return null;
  const parts = cwd.slice(PROJECTS.length).split('/');
  // worktrees/<repo-hash>/<branch> → keep both levels so worktrees stay distinguishable
  return parts[0] === 'worktrees' ? parts.slice(0, 3).join('/') : parts[0];
}

export function unitOf(cgroup: string): string | null {
  for (const line of cgroup.split('\n')) {
    const last = line.split('/').pop() ?? '';
    if (last.endsWith('.service') && !last.startsWith('user@')) return last;
  }
  return null;
}

let descCache = new Map<string, string>();
let descAt = 0;

export async function unitDescriptions(units: string[]): Promise<Map<string, string>> {
  if (Date.now() - descAt > 60_000) {
    descCache = new Map();
    descAt = Date.now();
  }
  const missing = units.filter((u) => !descCache.has(u));
  if (missing.length) {
    const r = await run('systemctl', ['--user', 'show', '-p', 'Id,Description', ...missing]);
    for (const block of r.stdout.split('\n\n')) {
      const id = /^Id=(.*)$/m.exec(block)?.[1];
      const desc = /^Description=(.*)$/m.exec(block)?.[1];
      if (id && desc) descCache.set(id, desc);
    }
  }
  return descCache;
}
