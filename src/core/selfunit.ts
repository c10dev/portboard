// What is Portboard itself, so stop, cleanup and the new-port and idle checks never treat it as somebody else's
// server: its systemd user units (portboard.service and the units install-service writes next to it,
// portboard-remote.service and portboard-agent.service), and its processes without a unit (a launchd agent on a Mac,
// `portboard start` from a shell, a preview from a worktree). Pure: whether a folder is a Portboard checkout comes in
// as `isCheckout` (src/core/checkout.ts reads it), and the snapshot decides once per port (PortEntry.isPortboard).

import { isAbsolute, join } from 'node:path';

export const PORTBOARD_UNIT = /^portboard(?:-[a-z]+)?\.service$/;

export const isPortboardUnit = (unit: string | null | undefined): boolean => !!unit && PORTBOARD_UNIT.test(unit);

const RUNTIME = /^(?:.*?\/)?node(?:js)?(?:\.exe)?(?=\s|$)/;
const BIN = /^(.*?(?:^|\/)(?:bin|node_modules\/\.bin)\/portboard)(?=\s|$)/;
const BIN_TAIL = /\/?(?:bin|node_modules\/\.bin)\/portboard$/;
const ENTRY = /^((?:.*?\/)?src\/(?:server|remote|agent|mcp)\.ts)(?=\s|$)/;
const ENTRY_TAIL = /\/?src\/(?:server|remote|agent|mcp)\.ts$/;

/**
 * The script a command line runs, when it can be Portboard's: `bin/portboard` (install-service, launchd, the npm bin),
 * `node_modules/.bin/portboard` (npx), or `src/{server,remote,agent,mcp}.ts`. The script comes right after the node
 * runtime and its options; a later argument never counts. ps and the joined /proc cmdline lose argument boundaries,
 * so a path may hold spaces: the script is then the shortest such prefix, and `root` (the folder above bin/ or src/,
 * '' when relative to the working directory) must pass isCheckout. A bin path without spaces needs no check.
 */
export function portboardScript(cmdline: string): { bin: true } | { bin: false; root: string } | null {
  const line = cmdline.trim();
  const runtime = RUNTIME.exec(line);
  const rest = runtime ? line.slice(runtime[0].length).replace(/^(?:\s+-\S*)*\s+/, '') : line;
  const bin = BIN.exec(rest)?.[1];
  if (bin && !/\s/.test(bin)) return { bin: true };
  const path = bin ?? ENTRY.exec(rest)?.[1];
  if (!path) return null;
  const root = path.replace(bin ? BIN_TAIL : ENTRY_TAIL, '');
  // With spaces the prefix may run into later arguments; their ".." must not climb into another folder
  return /\s/.test(root) && root.split('/').includes('..') ? null : { bin: false, root };
}

/** A bin path without spaces, or a script whose checkout `isCheckout` accepts (a relative path is taken from `cwd`) */
export function isPortboardCommand(cmdline: string, cwd: string | null, isCheckout: (dir: string) => boolean): boolean {
  const s = portboardScript(cmdline);
  if (!s) return false;
  if (s.bin) return true;
  const dir = isAbsolute(s.root) ? s.root : cwd ? join(cwd, s.root) : null;
  return dir !== null && isCheckout(dir);
}

type Proc = { pid: number; unit?: string | null; cmdline?: string; cwd?: string | null };

/** A port held by this process, by one of Portboard's units, or by a Portboard process without one */
export function isPortboardProcess(
  processes: readonly Proc[],
  opts: { selfPid?: number; isCheckout?: (dir: string) => boolean } = {},
): boolean {
  const selfPid = opts.selfPid ?? process.pid;
  const isCheckout = opts.isCheckout ?? (() => false);
  return processes.some(
    (p) => p.pid === selfPid || isPortboardUnit(p.unit) || (!!p.cmdline && isPortboardCommand(p.cmdline, p.cwd ?? null, isCheckout)),
  );
}
