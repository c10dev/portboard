// Per-process details from /proc and systemd (user units only), and the one /proc reader the collectors share:
//
//   scanProcs()     every process once (the numeric entries of /proc), a batch of reads at a time; the memory sampler
//                   reads stat + cmdline (+ environ of a few), the worktree scan reads cwd
//   readProcText()  one /proc/<pid>/<file>, null when it can't be read (gone, not ours)
//   readCwd()       /proc/<pid>/cwd as a path, with the kernel's " (deleted)" suffix taken off and reported

import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
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

const PROC = '/proc';
/** Reads in flight at once: hundreds of small reads, no need for hundreds of open files */
const BATCH = 64;

/** read(pid) for every process under root, BATCH at a time, in /proc's order; null results are left out. */
export async function scanProcs<T>(read: (pid: number) => Promise<T | null>, root = PROC): Promise<T[]> {
  const pids = (await readdir(root).catch(() => [] as string[])).filter((d) => /^\d+$/.test(d)).map(Number);
  const out: T[] = [];
  for (let i = 0; i < pids.length; i += BATCH) {
    for (const r of await Promise.all(pids.slice(i, i + BATCH).map(read))) if (r !== null) out.push(r);
  }
  return out;
}

export function readProcText(pid: number, file: string, root = PROC): Promise<string | null> {
  return readFile(join(root, String(pid), file), 'utf8').catch(() => null);
}

export async function readCwd(pid: number, root = PROC): Promise<{ path: string; deleted: boolean } | null> {
  const raw = await readlink(join(root, String(pid), 'cwd')).catch(() => null);
  if (raw === null) return null;
  const deleted = raw.endsWith(' (deleted)');
  return { path: deleted ? raw.slice(0, -' (deleted)'.length) : raw, deleted };
}

export async function procInfo(pid: number): Promise<ProcInfo> {
  const [cmdline, cwd, cgroup] = await Promise.all([
    readProcText(pid, 'cmdline').then((s) => (s ?? '').split('\0').filter(Boolean).join(' ')),
    readlink(`/proc/${pid}/cwd`).catch(() => null),
    readProcText(pid, 'cgroup').then((s) => s ?? ''),
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
