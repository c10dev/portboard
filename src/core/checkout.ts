// Whether a folder is a Portboard checkout or install: its package.json is named portboard (a checkout, the first
// public release) or @c10dev/portboard (the npm package). The callers of selfunit.ts (index.ts, topology.ts,
// claude-session.ts) pass it as isCheckout, for the folder above an entry point's src/ or above a bin/portboard path
// with spaces. A yes is cached per folder: a running checkout keeps its name. A no is read again next time, so a
// package.json caught while it was being saved, or a full file table, does not stick.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAMES = new Set(['portboard', '@c10dev/portboard']);
const MAX = 256;
const cache = new Set<string>();

/** `dir` may start with ~/ (ProcInfo.cwd is shortPath()ed). An unreadable or other package.json is not Portboard. */
export function isPortboardCheckout(dir: string, home = homedir()): boolean {
  const abs = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
  if (cache.has(abs)) return true;
  let yes = false;
  try {
    yes = NAMES.has(JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))?.name);
  } catch {
    yes = false;
  }
  if (yes) {
    if (cache.size >= MAX) cache.clear();
    cache.add(abs);
  }
  return yes;
}
