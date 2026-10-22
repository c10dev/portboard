// Tailscale node info and `tailscale serve` (tailnet-only HTTPS proxy) control.

import { forgetShared, run, runShared } from './exec.ts';

export interface TailscaleInfo {
  available: boolean;
  dnsName: string | null; // e.g. <host>.<tailnet>.ts.net
  hostName: string | null;
  ips: string[];
  /** tailscaled's own PeerAPI listeners on the Tailscale IPs (random ports, new on every tailscaled start) */
  peerApiPorts?: number[];
}

/** One `tailscale serve` HTTPS listener, e.g. https :443 → http://127.0.0.1:8790 */
export interface ServeEntry {
  httpsPort: number;
  upstream: string;
  /** Local port the proxy points at, when the upstream is a localhost URL */
  upstreamPort: number | null;
  /** AllowFunnel: also published to the public internet (Tailscale Funnel), not just the tailnet */
  funnel?: boolean;
}

export async function tailscaleInfo(): Promise<TailscaleInfo> {
  const r = await runShared('tailscale', ['status', '--json']);
  if (!r.ok) return { available: false, dnsName: null, hostName: null, ips: [] };
  try {
    const self = JSON.parse(r.stdout).Self ?? {};
    return {
      available: true,
      dnsName: typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null,
      hostName: self.HostName ?? null,
      ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
      peerApiPorts: peerApiPorts(self.PeerAPIURL),
    };
  } catch {
    return { available: false, dnsName: null, hostName: null, ips: [] };
  }
}

/** Self.PeerAPIURL: ["http://100.64.10.1:33819", "http://[fd7a:…]:63055"] → [33819, 63055] */
export function peerApiPorts(urls: unknown): number[] {
  if (!Array.isArray(urls)) return [];
  const out = new Set<number>();
  for (const u of urls) {
    const m = typeof u === 'string' ? /:(\d{1,5})\/?$/.exec(u) : null;
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

/** The dashboard's https address on the tailnet: the serve port that proxies to it (443 → no port in the URL). */
export function dashboardUrl(dnsName: string | null, serve: ServeEntry[], port: number): string | null {
  if (!dnsName) return null;
  const e = serve.find((x) => x.upstreamPort === port);
  if (!e) return null;
  return e.httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${e.httpsPort}`;
}

export async function serveStatus(): Promise<ServeEntry[]> {
  const r = await runShared('tailscale', ['serve', 'status', '--json'], 2_000);
  return r.ok ? parseServe(r.stdout) : [];
}

export function parseServe(json: string): ServeEntry[] {
  let cfg: any;
  try {
    cfg = JSON.parse(json);
  } catch {
    return [];
  }
  const out: ServeEntry[] = [];
  for (const [hostPort, web] of Object.entries<any>(cfg?.Web ?? {})) {
    const httpsPort = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
    const upstream = web?.Handlers?.['/']?.Proxy;
    if (!Number.isInteger(httpsPort) || typeof upstream !== 'string') continue;
    const funnel = cfg?.AllowFunnel?.[hostPort] === true;
    out.push({ httpsPort, upstream, upstreamPort: localPort(upstream), ...(funnel ? { funnel } : {}) });
  }
  return out.sort((x, y) => x.httpsPort - y.httpsPort);
}

function localPort(upstream: string): number | null {
  try {
    const u = new URL(/^\w+:\/\//.test(upstream) ? upstream : `http://${upstream}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

/**
 * The entry expose_port makes for `port` (serveOn: https:<port> → 127.0.0.1:<port>, tailnet only), or null.
 * unexpose turns off only this one, so an entry someone set up by hand (the dashboard's own https:443, a Funnel)
 * stays.
 */
export function exposedEntry(serve: ServeEntry[], port: number): ServeEntry | null {
  return serve.find((e) => e.httpsPort === port && e.upstreamPort === port && !e.funnel) ?? null;
}

/** Public URL for a serve entry; :443 is left out. */
export function servedUrl(dnsName: string, httpsPort: number): string {
  return httpsPort === 443 ? `https://${dnsName}/` : `https://${dnsName}:${httpsPort}`;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Set when the tailnet admin must turn Serve on first (one-time, in the browser). */
  enableUrl?: string;
}

const NEEDS_ENABLE = /https:\/\/login\.tailscale\.com\/f\/serve\S*\s/;

export async function serveOn(port: number): Promise<ActionResult> {
  const r = await run('tailscale', ['serve', '--bg', '--yes', `--https=${port}`, `http://127.0.0.1:${port}`], 20_000, NEEDS_ENABLE);
  forgetShared('tailscale', ['serve', 'status', '--json']);
  return result(r, `https:${port} → 127.0.0.1:${port}`);
}

export async function serveOff(port: number): Promise<ActionResult> {
  const r = await run('tailscale', ['serve', '--yes', `--https=${port}`, 'off'], 20_000, NEEDS_ENABLE);
  forgetShared('tailscale', ['serve', 'status', '--json']);
  return result(r, `https:${port} off`);
}

function result(r: { ok: boolean; stdout: string; stderr: string }, okMsg: string): ActionResult {
  if (r.ok) return { ok: true, message: okMsg };
  // The CLI prints some errors on stdout and then blocks waiting, so read both and keep what came before the timeout.
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const enableUrl = /https:\/\/login\.tailscale\.com\/f\/serve\S*/.exec(text)?.[0];
  if (enableUrl) {
    return { ok: false, message: `Serve is not enabled on this tailnet. Enable it once: ${enableUrl}`, enableUrl };
  }
  if (/access denied|permission|operator/i.test(text)) {
    return { ok: false, message: 'Permission denied. Run once on the server: sudo tailscale set --operator=$USER' };
  }
  return { ok: false, message: text.split('\n').filter(Boolean).slice(0, 3).join(' ') };
}

