// Request checks shared by every remote endpoint: Host and Origin (DNS rebinding), client address behind
// Tailscale Funnel, a failure-counting rate limiter, and the one log line per auth failure.

import type { IncomingMessage } from 'node:http';

export function hostOf(req: IncomingMessage): string {
  const raw = (req.headers.host ?? '').toLowerCase();
  return raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
}

export function hostAllowed(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  return allowed.has(hostOf(req));
}

/**
 * No Origin: a server-side client (claude.ai and ChatGPT call from their own clouds) — allowed.
 * With Origin: it must be this server under a name it answers to, or listed in allowedOrigins.
 */
export function originAllowed(req: IncomingMessage, hosts: ReadonlySet<string>, extra: readonly string[] = []): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (extra.includes(origin)) return true;
  try {
    return hosts.has(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false; // "null" and other opaque origins
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Funnel traffic reaches us from tailscaled on loopback, which sets Tailscale-Funnel-Request and overwrites
 * X-Forwarded-For with the real client. The header is honoured only on a loopback socket: a tailnet peer talking to
 * the tailnet listener directly could otherwise send it with any X-Forwarded-For and get a fresh rate-limit key per
 * request. Local processes stay trusted: they run on this machine, where remote.json lives.
 */
export function viaFunnel(req: IncomingMessage): boolean {
  return req.headers['tailscale-funnel-request'] !== undefined && LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

export function clientAddress(req: IncomingMessage): string {
  if (viaFunnel(req)) {
    // Last hop: the entry tailscaled adds. Earlier entries are whatever the client sent.
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()!.trim();
    return xff ? `funnel:${xff}` : 'funnel:unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Counts failures per key in a sliding window; blocks the key once it reaches the limit. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;
  constructor(limit = 20, windowMs = 10 * 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0. */
  blocked(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string) {
    this.hit(key);
  }

  /** Same as fail(), for limiters that count attempts rather than failures. */
  hit(key: string) {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
  }
}

export type Logger = (event: string, fields: Record<string, string | number | boolean | undefined>) => void;

/** One line per event on stderr (journald). Callers pass reasons and ids, never tokens or codes. */
export const stderrLogger: Logger = (event, fields) => {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  console.error(`[portboard-remote] ${event} ${kv}`);
};
