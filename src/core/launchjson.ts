// Claude Code Desktop's preview reads a worktree's .claude/launch.json to start its dev server. Portboard writes one
// entry there (named "portboard") with the worktree's reserved port and autoPort off, so the preview runs on the port
// Portboard keeps for that repo@branch instead of picking a free one each time. In "attach" mode the entry has only a
// url: the preview attaches to the server Portboard already runs (start_dev_server).
//
//   <worktree>/.claude/launch.json   { version, configurations: [{ name: "portboard", … }, …] }
//
// Other entries and keys are kept. A file with comments (the format allows them) is not rewritten, since the comments
// would be lost; the caller gets the entry to paste instead. A file tracked by git is not touched either: a per-worktree
// port must not end up in a commit. An untracked one is added to the repo's info/exclude for the same reason.
// A symlinked .claude or launch.json is refused, like Claude Code refuses symlinked worktree folders.

import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GIT_NO_HOOKS, run } from './exec.ts';
import { portArgs, type Framework } from './devservers.ts';

export const LAUNCH_REL = '.claude/launch.json';
export const ENTRY_NAME = 'portboard';
const VERSION = '0.0.1';

export type LaunchMode = 'run' | 'attach';

export type LaunchEntry = Record<string, unknown> & { name: string; port: number };

/** The entry Portboard writes: run the script on `port` (autoPort off), or attach to the server already on it. */
export function launchEntry(o: { mode: LaunchMode; port: number; script?: string; fw?: Framework }): LaunchEntry {
  if (o.mode === 'attach') return { name: ENTRY_NAME, url: `http://localhost:${o.port}`, port: o.port };
  const extra = portArgs(o.fw ?? 'generic', o.port);
  return {
    name: ENTRY_NAME,
    runtimeExecutable: 'npm',
    runtimeArgs: ['run', o.script ?? 'dev', ...(extra.length ? ['--', ...extra] : [])],
    port: o.port,
    autoPort: false,
    env: { PORT: String(o.port) },
  };
}

/** Whether JSON text has // or /* comments outside strings. */
export function hasComments(text: string): boolean {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

export type MergeResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: 'comments' | 'invalid' };

/** The new launch.json text with `entry` in place of any entry of the same name. */
export function mergeLaunch(existing: string | null, entry: LaunchEntry): MergeResult {
  let doc: Record<string, unknown> = { version: VERSION, configurations: [] };
  if (existing !== null && existing.trim()) {
    if (hasComments(existing)) return { ok: false, reason: 'comments' };
    try {
      doc = JSON.parse(existing);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'invalid' };
    if (doc.configurations !== undefined && !Array.isArray(doc.configurations)) return { ok: false, reason: 'invalid' };
  }
  const configs = ((doc.configurations as unknown[] | undefined) ?? []).slice();
  const at = configs.findIndex((c) => (c as { name?: unknown })?.name === entry.name);
  if (at >= 0) configs[at] = entry;
  else configs.push(entry);
  const text = `${JSON.stringify({ version: VERSION, ...doc, configurations: configs }, null, 2)}\n`;
  return { ok: true, text, changed: text !== existing };
}

/** The port the preview would use: Portboard's entry, else the first entry with a port. null without one. */
export function launchPortOf(text: string | null): number | null {
  if (!text || hasComments(text)) return null;
  try {
    const configs = (JSON.parse(text) as { configurations?: unknown }).configurations;
    if (!Array.isArray(configs)) return null;
    const ours = configs.find((c) => c?.name === ENTRY_NAME) ?? configs.find((c) => Number.isInteger(c?.port));
    return Number.isInteger(ours?.port) && ours.port > 0 && ours.port < 65536 ? ours.port : null;
  } catch {
    return null;
  }
}

export async function readLaunch(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, LAUNCH_REL), 'utf8');
  } catch {
    return null;
  }
}

export type WriteResult =
  | { ok: true; path: string; changed: boolean; excluded: boolean }
  | { ok: false; reason: 'comments' | 'invalid' | 'tracked' | 'symlink' | 'io'; path: string; entry: LaunchEntry; message?: string };

const isLink = async (p: string) => (await lstat(p).catch(() => null))?.isSymbolicLink() ?? false;

/** Write `entry` into `<dir>/.claude/launch.json`. `dir` must already be a known worktree (the caller checks). */
export async function writeLaunch(dir: string, entry: LaunchEntry, runner: typeof run = run): Promise<WriteResult> {
  const path = join(dir, LAUNCH_REL);
  const fail = (reason: Exclude<WriteResult, { ok: true }>['reason'], message?: string): WriteResult => ({ ok: false, reason, path, entry, ...(message ? { message } : {}) });
  if ((await isLink(dirname(path))) || (await isLink(path))) return fail('symlink');
  const tracked = await runner('git', [...GIT_NO_HOOKS, '-C', dir, 'ls-files', '--error-unmatch', LAUNCH_REL], 5_000);
  if (tracked.ok) return fail('tracked');

  const merged = mergeLaunch(await readLaunch(dir), entry);
  if (!merged.ok) return fail(merged.reason);
  try {
    if (merged.changed) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, merged.text);
      await rename(tmp, path);
    }
  } catch (err) {
    return fail('io', err instanceof Error ? err.message : String(err));
  }
  return { ok: true, path, changed: merged.changed, excluded: await excludeLaunch(dir, runner) };
}

/** Add /.claude/launch.json to the repo's info/exclude (shared by its worktrees). True when it is listed there. */
export async function excludeLaunch(dir: string, runner: typeof run = run): Promise<boolean> {
  const r = await runner('git', [...GIT_NO_HOOKS, '-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], 5_000);
  const file = r.ok ? r.stdout.trim() : '';
  if (!file.startsWith('/')) return false;
  const line = `/${LAUNCH_REL}`;
  try {
    const cur = await readFile(file, 'utf8').catch(() => '');
    if (cur.split('\n').some((l) => l.trim() === line)) return true;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Portboard: per-worktree preview port (Claude Code)\n${line}\n`);
    return true;
  } catch {
    return false;
  }
}
