// The port reader (#11): listening TCP sockets as Listener[] (src/core/ss.ts), from `ss` on Linux or `lsof` elsewhere.
//
//   ss    ss -ltnpH (with owners) / ss -ltnH (ports only): exactly what snapshot() and freePorts() always ran
//   lsof  lsof -nP +c 0 -iTCP -sTCP:LISTEN -F pcnL: field output, one p/c/L block per process and an n line per
//         listening socket (`*:3000`, `127.0.0.1:5432`, `[::1]:5173`). Merged per address and port the way ss shows
//         one line per socket with every process that holds it. Without root, macOS's lsof lists only this user's
//         processes, so other users' listeners are not seen at all (ss shows them without an owner).

import { run, type RunResult } from '../exec.ts';
import { classify, parseSs, type Listener } from '../ss.ts';
import { platform, type PortReader } from './index.ts';

export const LSOF_LISTEN_ARGS: readonly string[] = ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnL'];

/** `host:port` as lsof (or ss) names a socket → address without brackets or zone, and the port */
export function splitHostPort(name: string): { address: string; port: number } | null {
  const idx = name.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number(name.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535 || name.slice(idx + 1) === '') return null;
  const address = name.slice(0, idx).replace(/%[^\]]*$/, '').replace(/%[^\]]*\]$/, ']').replace(/^\[|\]$/g, '');
  return { address, port };
}

/** `lsof -F pcnL` output → listeners, in the order lsof printed them */
export function parseLsof(text: string): Listener[] {
  const out = new Map<string, Listener>();
  let pid: number | null = null;
  let name = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = /^\d+$/.test(value) ? Number(value) : null;
      name = '';
    } else if (field === 'c') {
      name = value;
    } else if (field === 'n') {
      // an established socket names both ends (a->b): never a listener
      if (value.includes('->')) continue;
      const hp = splitHostPort(value);
      if (!hp) continue;
      const key = `${hp.address} ${hp.port}`;
      let l = out.get(key);
      if (!l) {
        l = { address: hp.address, port: hp.port, scope: classify(hp.address), processes: [] };
        out.set(key, l);
      }
      if (pid !== null && !l.processes.some((p) => p.pid === pid)) l.processes.push({ name: name || String(pid), pid });
    }
    // f (descriptor), L (login), t (type) and anything else: not needed
  }
  return [...out.values()];
}

/**
 * The listening sockets. `withProcesses: false` is the cheaper read freePorts() wants (ss without -p); lsof always
 * names the owners.
 */
export async function readListeners(
  withProcesses: boolean,
  reader: PortReader = platform().portReader,
  exec: (cmd: string, args: string[]) => Promise<RunResult> = run,
): Promise<Listener[]> {
  if (reader === 'ss') return parseSs((await exec('ss', withProcesses ? ['-ltnpH'] : ['-ltnH'])).stdout);
  // lsof exits 1 when nothing matches; the output is what counts
  return parseLsof((await exec('lsof', [...LSOF_LISTEN_ARGS])).stdout);
}
