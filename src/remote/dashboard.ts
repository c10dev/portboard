// Where the remote server's snapshot, devices and usage come from (#5): the dashboard's own cached answers, read over
// loopback (GET /api/ports, /api/devices, /api/usage on 127.0.0.1:PORTBOARD_PORT), so the two processes don't each
// run `ss`, `docker ps`, `tailscale status` and the HTTP probes. Only when the dashboard is down (refused, or no
// answer) does the remote compute them itself, and then it leaves the dashboard alone for a short back-off.
//
// What comes back is the same core object the dashboard computed (the routes answer ctx.snapshot(), devices() and
// ctx.usage() as JSON, all plain data with ISO strings for times); /api/usage adds history and 새 기기 fields, which
// the redaction (src/remote/redact.ts) never copies. Each request is built here from fixed values: no header, cookie
// or parameter of a remote client is ever passed on, and only 127.0.0.1 is dialled.

import { request } from 'node:http';
import type { Snapshot } from '../core/index.ts';
import type { Devices } from '../core/devices.ts';
import type { Usage } from '../core/usage.ts';

export interface DashboardOptions {
  /** The dashboard's port (PORTBOARD_PORT, default 8790) */
  port: number;
  /** No connection within this long counts as down */
  connectTimeoutMs?: number;
  /** Connected but no full answer within this long: down too (a cold snapshot takes a second or two) */
  answerTimeoutMs?: number;
  /** After the dashboard was down, read locally for this long before trying it again */
  backoffMs?: number;
  /** Bodies larger than this are refused (the dashboard's are tens of KB) */
  maxBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const CONNECT_TIMEOUT_MS = 1_500;
export const ANSWER_TIMEOUT_MS = 15_000;
export const BACKOFF_MS = 10_000;

class Down extends Error {}

/** GET one path from 127.0.0.1:port; Down when nothing answers, a plain Error for a bad answer. */
function get(path: string, o: Required<Omit<DashboardOptions, 'now' | 'log'>>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: o.port,
      path,
      method: 'GET',
      agent: false,
      // The router lets any GET through; Host must be a name the dashboard answers to (server.ts hostOk).
      headers: { host: `127.0.0.1:${o.port}`, accept: 'application/json', 'user-agent': 'portboard-remote' },
    });
    const fail = (err: Error) => {
      clearTimeout(connectTimer);
      clearTimeout(answerTimer);
      reject(err);
    };
    const connectTimer = setTimeout(() => req.destroy(new Down('connect timeout')), o.connectTimeoutMs);
    const answerTimer = setTimeout(() => req.destroy(new Down('answer timeout')), o.answerTimeoutMs);
    req.on('socket', (s) => s.once('connect', () => clearTimeout(connectTimer)));
    req.on('error', (err) => fail(err instanceof Down ? err : new Down(err.message)));
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          fail(new Error('answer too large'));
          req.destroy();
        } else chunks.push(c);
      });
      res.on('error', (err) => fail(new Down(err.message)));
      res.on('end', () => {
        clearTimeout(connectTimer);
        clearTimeout(answerTimer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('not JSON'));
        }
      });
    });
    req.end();
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Just enough shape that the redaction can't trip over it; anything else is read locally instead. */
export const isSnapshot = (v: unknown): v is Snapshot => isObj(v) && typeof v.at === 'string' && isObj(v.host) && isObj(v.tailscale) && Array.isArray(v.ports);
export const isDevices = (v: unknown): v is Devices =>
  isObj(v) && typeof v.at === 'string' && Array.isArray(v.devices) && isObj(v.pool) && isObj(v.proxmox) && Array.isArray(v.proxmox.hosts);
export const isUsage = (v: unknown): v is Usage => isObj(v) && Array.isArray(v.cards) && isObj(v.local) && Array.isArray(v.local.uses) && isObj(v.byPort);

export interface DashboardReader {
  /** The dashboard's answer at path when it has a valid one, else local() */
  read<T>(path: string, valid: (v: unknown) => v is T, local: () => Promise<T>): Promise<T>;
  /** Whether the next read skips the dashboard (it was down less than backoffMs ago) */
  backingOff(): boolean;
}

export function dashboardReader(opts: DashboardOptions): DashboardReader {
  const o = {
    port: opts.port,
    connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    answerTimeoutMs: opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
    backoffMs: opts.backoffMs ?? BACKOFF_MS,
    maxBytes: opts.maxBytes ?? 32 * 1024 * 1024,
  };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(`[portboard-remote] ${line}`));
  let downUntil = 0;
  let wasDown = false;
  const backingOff = () => now() < downUntil;
  return {
    backingOff,
    async read(path, valid, local) {
      if (backingOff()) return local();
      let value: unknown;
      try {
        value = await get(path, o);
      } catch (err) {
        if (err instanceof Down) {
          // One line per outage, not per read; the error text is ours or the socket's (no remote input in it).
          if (!wasDown) log(`dashboard on 127.0.0.1:${o.port} not answering (${err.message}); reading locally, retrying every ${o.backoffMs / 1000} s`);
          wasDown = true;
          downUntil = now() + o.backoffMs;
        }
        return local();
      }
      if (wasDown) log(`dashboard on 127.0.0.1:${o.port} answering again`);
      wasDown = false;
      return valid(value) ? value : local();
    },
  };
}

/** The three reads RemoteCore takes from the dashboard, each falling back to its local computation. */
export function dashboardSources(
  reader: DashboardReader,
  local: { snapshot(): Promise<Snapshot>; devices(): Promise<Devices>; usage(): Promise<Usage> },
) {
  return {
    snapshot: () => reader.read('/api/ports', isSnapshot, local.snapshot),
    devices: () => reader.read('/api/devices', isDevices, local.devices),
    usage: () => reader.read('/api/usage', isUsage, local.usage),
  };
}
