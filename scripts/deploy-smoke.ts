// Live smoke checks for scripts/deploy.ts, read-only: health, pages and APIs on 8790, the remote on 8794, the public
// Funnel URL resolved through public DNS (on this server MagicDNS would bypass Funnel), and a scan of every response
// for the secrets portboard holds. Secrets are compared in memory and never printed; results carry status codes,
// sizes and secret *names* only.

import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { Resolver } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, Unit } from './deploy-plan.ts';
import { SITE } from '../src/core/site.ts';

export const LOCAL = 'http://127.0.0.1:8790';
export const REMOTE = 'http://127.0.0.1:8794';
/** remote.json has no publicUrl: portboard.json's publicUrl, else the production default (src/core/site.ts) */
export const PUBLIC_DEFAULT = SITE.publicUrl;
export const PAGES = ['/', '/devices.html', '/service.html', '/dev.html', '/api/ports', '/api/devices', '/api/usage', '/api/worktrees'];

export interface Secret {
  /** what to print: "proxmox secret", "ntfy topic", "remote token hash ×3" */
  name: string;
  value: string;
}

export interface Body {
  /** "/api/devices", "public /mcp" */
  where: string;
  text: string;
}

const readJson = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/** The values that must never appear in a response. Short values are skipped (false hits, not secrets). */
export function secretsFrom(proxmox: any, alerts: any, remote: any): Secret[] {
  const out: Secret[] = [];
  const add = (name: string, v: unknown) => {
    if (typeof v === 'string' && v.length >= 8) out.push({ name, value: v });
  };
  add('proxmox secret', proxmox?.secret);
  add('ntfy topic', alerts?.ntfy?.topic);
  add('webhook url', alerts?.webhook?.url);
  for (const h of Object.keys(remote?.tokens ?? {})) add('remote token hash', h);
  add('remote approval hash', remote?.approval?.hash);
  return out;
}

// The production units set none of the PORTBOARD_* path variables, so these are the default paths on purpose:
// a preview's overrides in this shell must not change what gets scanned for.
export async function loadSecrets(home = homedir()): Promise<Secret[]> {
  return secretsFrom(
    await readJson(join(home, '.config/portboard/proxmox.json')),
    await readJson(join(home, '.local/state/compute-pool/alerts.json')),
    await readJson(join(home, '.config/portboard/remote.json')),
  );
}

/** "proxmox secret 1, ntfy topic 1, remote token hash 4" */
export function describeSecrets(secrets: readonly Secret[]): string {
  const n = new Map<string, number>();
  for (const s of secrets) n.set(s.name, (n.get(s.name) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k} ${v}`).join(', ') || '없음';
}

/** One check over every body × every secret. The detail names the secret kind and the response, never the value. */
export function scanSecrets(bodies: readonly Body[], secrets: readonly Secret[]): Check {
  const hits: string[] = [];
  for (const b of bodies) for (const s of secrets) if (b.text.includes(s.value)) hits.push(`${s.name} → ${b.where}`);
  if (secrets.length === 0) return { name: '비밀값 스캔', ok: false, detail: '비밀값 파일을 하나도 읽지 못함 — 스캔이 의미 없음' };
  return hits.length
    ? { name: '비밀값 스캔', ok: false, detail: `${hits.length}건 노출: ${[...new Set(hits)].join('; ')}` }
    : { name: '비밀값 스캔', ok: true, detail: `응답 ${bodies.length}개 × 비밀값 ${secrets.length}개, 0건` };
}

export interface Res {
  status: number;
  text: string;
  ms: number;
}

/** Status check line; the detail is code, size and time — the body is kept only for the secret scan. */
export function statusCheck(name: string, r: Res | Error, want: number): Check {
  if (r instanceof Error) return { name, ok: false, detail: r.message.slice(0, 120) };
  return { name, ok: r.status === want, detail: `${r.status}${r.status === want ? '' : ` (기대 ${want})`} · ${fmtBytes(r.text.length)} · ${r.ms}ms` };
}

const fmtBytes = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

async function get(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Res | Error> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text(), ms: Date.now() - t0 };
  } catch (e) {
    return new Error(errText(e));
  }
}

// fetch() errors wrap the cause; keep the code (ECONNREFUSED, timeout), nothing from a body.
const errText = (e: unknown) => {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return '시간 초과';
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
};

/** HTTPS to `url` but connecting to `ip` (SNI and Host stay the name), like curl --resolve. */
function viaIp(url: string, ip: string, method: string, body?: string, timeoutMs = 15_000): Promise<Res | Error> {
  const u = new URL(url);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method,
        servername: u.hostname,
        lookup: (_h, opts, cb) => ((opts as { all?: boolean }).all ? (cb as any)(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }));
        res.on('error', (e) => resolve(new Error(errText(e))));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('시간 초과'), { name: 'TimeoutError' })));
    req.on('error', (e) => resolve(new Error(errText(e))));
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry while the answer isn't `want` (the first Funnel request after a restart can fail). */
async function retry(fn: () => Promise<Res | Error>, want: number, tries: number, gapMs: number): Promise<{ r: Res | Error; tries: number }> {
  let r: Res | Error = new Error('시도 안 함');
  for (let i = 1; i <= tries; i++) {
    r = await fn();
    if (!(r instanceof Error) && r.status === want) return { r, tries: i };
    if (i < tries) await sleep(gapMs * i);
  }
  return { r, tries };
}

/** Poll until `url` answers 200 or the time is up. */
async function waitFor(url: string, timeoutMs: number): Promise<Res | Error> {
  const end = Date.now() + timeoutMs;
  const t0 = Date.now();
  let r: Res | Error = new Error('시간 초과');
  while (Date.now() < end) {
    r = await get(url, {}, 3000);
    if (!(r instanceof Error) && r.status === 200) return { ...r, ms: Date.now() - t0 };
    await sleep(500);
  }
  return r instanceof Error ? new Error(`${Math.round(timeoutMs / 1000)}s 안에 응답 없음 (${r.message})`) : r;
}

const systemctl = (args: string[]): Promise<string> =>
  new Promise((resolve) => execFile('systemctl', ['--user', ...args], (_e, out) => resolve(String(out).trim())));

/** is-active plus systemd's automatic-restart counter: a new build that crashes and comes back still counts */
async function unitState(unit: Unit): Promise<{ state: string; restarts: number }> {
  return { state: (await systemctl(['is-active', unit])) || 'unknown', restarts: Number(await systemctl(['show', '-p', 'NRestarts', '--value', unit])) };
}

export function unitCheck(unit: Unit, before: number, after: { state: string; restarts: number }): Check {
  const crashed = Number.isFinite(before) && Number.isFinite(after.restarts) && after.restarts > before;
  return {
    name: `${unit} 유닛`,
    ok: after.state === 'active' && !crashed,
    detail: crashed ? `${after.state}, 체크 도중 ${after.restarts - before}번 죽고 재시작됨` : after.state,
  };
}

export interface SmokeOptions {
  /** units just restarted: wait for them to come up; the others are checked once */
  restarted: readonly Unit[];
  publicUrl?: string;
  waitMs?: number;
  log?: (c: Check) => void;
}

export async function runSmoke(o: SmokeOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const bodies: Body[] = [];
  const add = (c: Check) => {
    checks.push(c);
    o.log?.(c);
  };
  const keep = (where: string, r: Res | Error) => {
    if (!(r instanceof Error)) bodies.push({ where, text: r.text });
  };
  const waitMs = o.waitMs ?? 30_000;

  const units = ['portboard', 'portboard-remote'] as const;
  const before = await Promise.all(units.map(async (u) => (await unitState(u)).restarts));

  const health = o.restarted.includes('portboard') ? await waitFor(`${LOCAL}/api/health`, waitMs) : await get(`${LOCAL}/api/health`);
  add(statusCheck('/api/health', health, 200));
  const remoteUp = o.restarted.includes('portboard-remote')
    ? await waitFor(`${REMOTE}/.well-known/oauth-protected-resource`, waitMs)
    : await get(`${REMOTE}/.well-known/oauth-protected-resource`);
  add(statusCheck('8794 리스너', remoteUp, 200));
  keep('8794 /.well-known/oauth-protected-resource', remoteUp);

  for (const p of PAGES) {
    const r = await get(`${LOCAL}${p}`);
    add(statusCheck(p, r, 200));
    keep(p, r);
  }

  const pub = (o.publicUrl ?? PUBLIC_DEFAULT).replace(/\/+$/, '');
  let ip: string | null = null;
  try {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    ip = (await resolver.resolve4(new URL(pub).hostname))[0] ?? null;
  } catch (e) {
    add({ name: '공개 DNS', ok: false, detail: `1.1.1.1에서 A 레코드 못 받음 (${errText(e)})` });
  }
  if (ip) {
    const prm = await retry(() => viaIp(`${pub}/.well-known/oauth-protected-resource`, ip, 'GET'), 200, 3, 2000);
    add(withTries(statusCheck('공개 /.well-known/oauth-protected-resource', prm.r, 200), prm.tries));
    keep('공개 /.well-known/oauth-protected-resource', prm.r);
    const mcp = await retry(() => viaIp(`${pub}/mcp`, ip, 'POST', '{"jsonrpc":"2.0","id":1,"method":"ping"}'), 401, 3, 2000);
    add(withTries(statusCheck('공개 POST /mcp (토큰 없음)', mcp.r, 401), mcp.tries));
    keep('공개 POST /mcp', mcp.r);
  }

  add(scanSecrets(bodies, await loadSecrets()));
  // last, so a build that dies a few seconds after answering is caught
  for (const [i, u] of units.entries()) add(unitCheck(u, before[i], await unitState(u)));
  return checks;
}

const withTries = (c: Check, tries: number): Check => (tries > 1 ? { ...c, detail: `${c.detail} · ${tries}번째 시도` } : c);
