// This machine's load and what it can run, for `portboard agent`'s info/status and the board's own machine_status row
// (docs/multi-host.md).
//
//   load          cores, load1, memory (Linux /proc/meminfo; elsewhere os.totalmem and os.freemem, which counts less
//                 as available than Linux does), free share of /, uptime
//   capabilities  linux | macos, systemd and dev-servers (start_dev_server needs systemd), memory-view (/proc),
//                 docker (a docker socket); portboard.json tags add more on the board

import { stat, readFile, statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem, uptime } from 'node:os';
import type { HostLoad } from '../agent/server.ts';
import { parseMeminfo } from './memory/parse.ts';
import { platform } from './platform/index.ts';

export async function hostLoad(): Promise<HostLoad> {
  const mem = await readFile('/proc/meminfo', 'utf8').then(parseMeminfo, () => null);
  const disk = await statfs('/').catch(() => null);
  const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
  return {
    cores: availableParallelism(),
    load1: Math.round(loadavg()[0] * 100) / 100,
    memTotalMb: mem ? Math.round(mem.totalKb / 1024) : mb(totalmem()),
    memAvailMb: mem ? Math.round(mem.availableKb / 1024) : mb(freemem()),
    diskFreePct: disk && disk.blocks ? Math.round((disk.bavail / disk.blocks) * 1000) / 10 : null,
    uptimeSec: Math.round(uptime()),
  };
}

const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

export async function localCapabilities(): Promise<string[]> {
  const p = platform();
  const caps: string[] = [p.os === 'darwin' ? 'macos' : p.os];
  if (p.services === 'systemd') caps.push('systemd', 'dev-servers');
  if (p.procfs) caps.push('memory-view');
  if ((await Promise.all(DOCKER_SOCKETS.map((s) => stat(s).then(() => true, () => false)))).some(Boolean)) caps.push('docker');
  return caps;
}
