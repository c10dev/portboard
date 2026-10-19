// Same machine, two addresses: a LAN IP and a Tailscale IP that present the same SSH host key are one device
// (192.168.1.201 and pve1's 100.64.10.8). Keys come from `ssh-keyscan` in the background — a request never
// waits for a probe; it reads whatever the cache has, and the next refresh shows new matches.

import { run } from './exec.ts';
import { reportHealth } from './health.ts';

/** `ssh-keyscan` output: `host type base64` lines, comments start with # */
export function parseKeyscan(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(ssh-[\w-]+|ecdsa-[\w-]+)\s+([A-Za-z0-9+/=]+)\s*$/.exec(line.trim());
    if (!m) continue;
    const host = m[1].replace(/^\[|\](:\d+)?$/g, '');
    out.set(host, [...(out.get(host) ?? []), `${m[2]} ${m[3]}`]);
  }
  return out;
}

export interface KeyedPeer {
  name: string;
  ips: string[];
}

/** LAN IP → device name, for LAN IPs whose host key also answers on one of a device's Tailscale IPs. */
export function sameMachine(lanIps: string[], peers: KeyedPeer[], keysOf: (ip: string) => string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const ip of lanIps) {
    const mine = keysOf(ip);
    if (!mine?.length) continue;
    const hit = peers.find((p) => p.ips.some((t) => keysOf(t)?.some((k) => mine.includes(k))));
    if (hit) out.set(ip, hit.name);
  }
  return out;
}

// ---- background probe ----

const TTL = 60 * 60_000;
const FAILED_TTL = 10 * 60_000;
/** ip → keys ([] when nothing answered), when, and the LAN MAC it was probed under (re-probe when it changes) */
const cache = new Map<string, { keys: string[]; at: number; tag: string }>();
const wanted: { ip: string; tag: string }[] = [];
let running = false;

export function cachedKeys(ip: string): string[] | undefined {
  return cache.get(ip)?.keys;
}

/** Queue IPs whose keys are missing, stale or probed under another MAC; returns at once. */
export function probeLater(targets: { ip: string; tag?: string }[]) {
  const now = Date.now();
  for (const { ip, tag = '' } of targets) {
    const c = cache.get(ip);
    const fresh = c && c.tag === tag && now - c.at < (c.keys.length ? TTL : FAILED_TTL);
    if (fresh || wanted.some((w) => w.ip === ip)) continue;
    wanted.push({ ip, tag });
  }
  if (!running && wanted.length) void drain();
}

async function drain() {
  running = true;
  try {
    while (wanted.length) {
      const { ip, tag } = wanted.shift()!;
      const r = await run('ssh-keyscan', ['-T', '3', '-t', 'ed25519,ecdsa', ip], 6_000);
      // A host that doesn't answer is normal (offline, no sshd); ssh-keyscan itself missing is not.
      const broken = !r.ok && /ENOENT|EACCES/.test(r.stderr);
      reportHealth('hostkeys', { ok: !broken, error: broken ? 'ssh-keyscan cannot run' : null });
      cache.set(ip, { keys: parseKeyscan(r.stdout).get(ip) ?? [], at: Date.now(), tag });
    }
  } finally {
    running = false;
  }
}
