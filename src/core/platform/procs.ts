// Process details where there is no /proc (#11: macOS and other non-Linux systems), one batch per snapshot:
//
//   ps -o pid=,command= -p <pids>          command lines
//   lsof -a -p <pids> -d cwd -F pn         working directories
//   lsof -a -p <pid> -d 1,2 -F ftn         where stdout / stderr go (the logs action for a plain process)
//
// The parsers are pure (test/platform.test.ts); the runners take `exec` so tests never need ps or lsof.

import { run, type RunResult } from '../exec.ts';

type Exec = (cmd: string, args: string[]) => Promise<RunResult>;

/** `ps -o pid=,command=` → pid → command line */
export function parsePsCommands(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** `lsof -F pn` (one cwd per process) → pid → path */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = /^\d+$/.test(line.slice(1)) ? Number(line.slice(1)) : null;
    else if (line.startsWith('n') && pid !== null && !out.has(pid) && line.length > 1) out.set(pid, line.slice(1));
  }
  return out;
}

/** `lsof -F ftn` for descriptors 1 and 2 → the regular files they write to, stdout first */
export function parseLsofStdio(text: string): string[] {
  const files: { fd: number; path: string }[] = [];
  let fd: number | null = null;
  let type = '';
  for (const line of text.split('\n')) {
    const v = line.slice(1);
    if (line.startsWith('p')) fd = null;
    else if (line.startsWith('f')) {
      fd = /^\d+$/.test(v) ? Number(v) : null;
      type = '';
    } else if (line.startsWith('t')) type = v;
    else if (line.startsWith('n') && fd !== null && (fd === 1 || fd === 2) && type === 'REG' && v.startsWith('/') && !v.startsWith('/dev/')) {
      files.push({ fd, path: v });
    }
  }
  return [...new Set(files.sort((a, b) => a.fd - b.fd).map((f) => f.path))];
}

/** Command lines and cwds of these processes (two subprocesses whatever the count); missing ones are left out */
export async function psDetails(pids: number[], exec: Exec = run): Promise<{ cmdlines: Map<number, string>; cwds: Map<number, string> }> {
  if (!pids.length) return { cmdlines: new Map(), cwds: new Map() };
  const list = pids.join(',');
  const [ps, cwd] = await Promise.all([exec('ps', ['-o', 'pid=,command=', '-p', list]), exec('lsof', ['-a', '-p', list, '-d', 'cwd', '-F', 'pn'])]);
  return { cmdlines: parsePsCommands(ps.stdout), cwds: parseLsofCwd(cwd.stdout) };
}

/** The regular files a process writes stdout / stderr to, without /proc */
export async function stdioFiles(pid: number, exec: Exec = run): Promise<string[]> {
  const r = await exec('lsof', ['-a', '-p', String(pid), '-d', '1,2', '-F', 'ftn']);
  return parseLsofStdio(r.stdout);
}
