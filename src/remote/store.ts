// Remote MCP settings and auth state, one file outside the repo, mode 600:
//   ~/.config/portboard/remote.json   (override with PORTBOARD_REMOTE_CONFIG)
//
// Holds hashes only: the approval code, access and refresh tokens are stored as SHA-256. The server and the CLI
// (src/remote.ts approve / revoke) both write it; every change is read → modify → atomic rename, under a lock file
// shared by both processes so a `revoke` can't be overwritten by a server write that read the file before it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PATHS } from '../core/paths.ts';
import type { RedactPolicy } from './redact.ts';

export const REMOTE_CONFIG_PATH = PATHS.remoteConfig;

export interface Client {
  name: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt: number;
}

export interface TokenRecord {
  /** used: a refresh token already rotated, kept until it expires so a replay can be recognised */
  kind: 'access' | 'refresh' | 'used';
  clientId: string;
  clientName: string;
  resource: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  /** One per authorization: every token minted from it by refreshes shares it */
  family?: string;
  /** kind 'used': when it was rotated */
  usedAt?: number;
  /** kind 'access': last accepted on /mcp, written at most once a minute (TOUCH_EVERY_MS). Copied onto the live refresh
   *  token of the same authorization, so "last used" survives the access token's hour (the 설정 tab's 응답 없음) */
  lastUsedAt?: number;
}

export interface RemoteState {
  /** https://<host>.<tailnet>.ts.net (Funnel on 443) once public; unset = derive from the Host header (local testing) */
  publicUrl?: string;
  /** 커넥터 상태 thresholds in days (health.ts): {soonDays, idleDays, hideDays}, each default 7 */
  health?: { soonDays?: number; idleDays?: number; hideDays?: number };
  /** Loosen redaction (both default false) */
  policy?: Partial<RedactPolicy>;
  /** Extra Origins allowed to call (browser-based MCP clients); requests without Origin are always allowed */
  allowedOrigins?: string[];
  /** Extra redirect URI prefixes accepted at registration, e.g. a self-hosted MCP client */
  extraRedirectPrefixes?: string[];
  /**
   * Accept http://127.0.0.1:*, http://localhost:* redirects (Claude Code, MCP inspector). Only a literal true or false
   * counts; unset, they are accepted from loopback and the tailnet but never through Funnel (http.ts redirectOpts).
   */
  allowLoopbackRedirects?: boolean;
  /** Pending one-time approval code (hash), from `node src/remote.ts approve` */
  approval?: { hash: string; expiresAt: number; failures: number } | null;
  /** Dynamically registered clients (RFC 7591) by client_id */
  clients: Record<string, Client>;
  /** sha256(token) → record */
  tokens: Record<string, TokenRecord>;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const MAX_CLIENTS = 50;
/** Wrong tries that burn a pending code, from all addresses together (the server also allows 5 per address, IPv6 per /64). */
export const APPROVAL_MAX_FAILURES = 20;
/** A refresh token replayed this soon after rotation is refused without revoking (a client retrying a lost reply). */
const REUSE_GRACE_MS = 10_000;
const LOCK_STALE_MS = 10_000;
/** How stale an access token's lastUsedAt may get before a request writes it again: one write per token per minute at most. */
export const TOUCH_EVERY_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  private now: () => number;

  constructor(path = REMOTE_CONFIG_PATH, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  async read(): Promise<RemoteState> {
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { clients: {}, tokens: {} };
      throw new Error(`${this.path}: ${err instanceof SyntaxError ? 'not valid JSON' : err?.code ?? 'unreadable'}`);
    }
    return {
      ...raw,
      clients: raw && typeof raw.clients === 'object' && raw.clients ? raw.clients : {},
      tokens: raw && typeof raw.tokens === 'object' && raw.tokens ? raw.tokens : {},
    };
  }

  /** Serialized read → modify → write (mode 600, atomic). Expired tokens are dropped on every write. */
  update<T>(fn: (s: RemoteState) => T | Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      const release = await this.lock();
      try {
        const s = await this.read();
        const result = await fn(s);
        const now = this.now();
        for (const [h, t] of Object.entries(s.tokens)) if (t.expiresAt <= now) delete s.tokens[h];
        if (s.approval && s.approval.expiresAt <= now) s.approval = null;
        await this.write(s);
        return result;
      } finally {
        await release();
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * Cross-process lock (server and CLI): an O_EXCL lock file next to remote.json. One older than 10 s was left by a
   * crashed writer and is broken, by exactly one waiter (breakStale). Release removes the file only while it is still
   * the one this holder created.
   */
  private async lock(): Promise<() => Promise<void>> {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let i = 0; ; i++) {
      try {
        const fh = await open(lock, 'wx', 0o600);
        let mine: BigIntStats;
        try {
          await fh.writeFile(String(process.pid));
          mine = await fh.stat({ bigint: true });
        } finally {
          await fh.close();
        }
        return async () => {
          const cur = await stat(lock, { bigint: true }).catch(() => null);
          if (cur && sameFile(cur, mine)) await unlink(lock).catch(() => {});
        };
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        const st = await stat(lock, { bigint: true }).catch(() => null);
        if (st && Date.now() - Number(st.mtimeMs) > LOCK_STALE_MS) {
          await breakStale(lock, st); // its holder died mid-write
          continue;
        }
        if (i >= 500) throw new Error(`${lock}: still locked`);
        await sleep(5 + Math.random() * 15);
      }
    }
  }

  private async write(s: RemoteState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Unpredictable name and O_EXCL: never follows a link someone planted at the temp path.
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, this.path);
  }

  /** Tightens the file to 600 and its folder to 700 if someone loosened them; returns true when it had to. */
  async ensurePrivate(): Promise<boolean> {
    let changed = false;
    for (const [p, mode] of [[dirname(this.path), 0o700], [this.path, 0o600]] as const) {
      try {
        const st = await stat(p);
        if ((st.mode & 0o077) === 0) continue;
        await chmod(p, mode);
        changed = true;
      } catch {
        // missing: created private on first write
      }
    }
    return changed;
  }

  // ---- approval code ----

  /** New one-time code (replaces any pending one). Returns the plain code: show it once, never store it. */
  async newApprovalCode(ttlMs = 10 * 60_000): Promise<{ code: string; expiresAt: number }> {
    // Crockford base32 without I, L, O, U: 8 chars ≈ 40 bits, shown as XXXX-XXXX
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bytes = randomBytes(8);
    const raw = [...bytes].map((b) => alphabet[b & 31]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = this.now() + ttlMs;
    await this.update((s) => {
      s.approval = { hash: sha256(normalizeCode(code)), expiresAt, failures: 0 };
    });
    return { code, expiresAt };
  }

  /**
   * Single use. APPROVAL_MAX_FAILURES wrong tries (all addresses together) burn the pending code: 'burned' is the try
   * that did it. However many addresses guess, a code gets at most that many guesses against its 2⁴⁰ values; the
   * owner makes a new one (`approve`, or 승인 코드 만들기), which starts a fresh budget.
   */
  consumeApprovalCode(input: string): Promise<'ok' | 'wrong' | 'burned' | 'none'> {
    return this.update((s) => {
      const a = s.approval;
      if (!a || a.expiresAt <= this.now()) {
        s.approval = null;
        return 'none';
      }
      if (sameHash(sha256(normalizeCode(input)), a.hash)) {
        s.approval = null;
        return 'ok';
      }
      // A hand-edited file without a number here still burns (NaN would never reach the limit).
      a.failures = (Number.isFinite(a.failures) && a.failures > 0 ? a.failures : 0) + 1;
      if (a.failures < APPROVAL_MAX_FAILURES) return 'wrong';
      s.approval = null;
      return 'burned';
    });
  }

  // ---- clients ----

  registerClient(name: string, redirectUris: string[]): Promise<string> {
    const id = `pb_${randomToken(16)}`;
    return this.update((s) => {
      const ids = Object.keys(s.clients);
      if (ids.length >= MAX_CLIENTS) {
        // Evict the least recently used one that holds no live tokens.
        const live = new Set(Object.values(s.tokens).filter((t) => t.kind !== 'used').map((t) => t.clientId));
        const victim = ids.filter((c) => !live.has(c)).sort((a, b) => s.clients[a].lastUsedAt - s.clients[b].lastUsedAt)[0];
        if (!victim) throw new Error('too many clients');
        delete s.clients[victim];
      }
      const now = this.now();
      s.clients[id] = { name, redirectUris, createdAt: now, lastUsedAt: now };
      return id;
    });
  }

  // ---- tokens ----

  /** family: pass the refreshed token's family; a new authorization starts a new one. */
  issueTokens(
    client: { id: string; name: string },
    resource: string,
    scope: string,
    family: string = randomToken(12),
    accessTtlMs = 3600_000,
    refreshTtlMs = 30 * 86400_000,
  ) {
    const access = randomToken();
    const refresh = randomToken();
    const now = this.now();
    return this.update((s) => {
      const base = { clientId: client.id, clientName: client.name, resource, scope, createdAt: now, family };
      s.tokens[sha256(access)] = { ...base, kind: 'access', expiresAt: now + accessTtlMs };
      s.tokens[sha256(refresh)] = { ...base, kind: 'refresh', expiresAt: now + refreshTtlMs };
      if (Object.hasOwn(s.clients, client.id)) s.clients[client.id].lastUsedAt = now;
      return { access, refresh, expiresIn: Math.floor(accessTtlMs / 1000), scope };
    });
  }

  /**
   * Refresh-token rotation: the old one stops working whether or not the new pair reaches the client. It is kept as
   * 'used' until it would have expired: presenting it again (more than 10 s later) means two parties hold the same
   * grant, so every token of that authorization is revoked (OAuth 2.1 §4.3.1 / BCP refresh-token reuse detection).
   */
  takeRefreshToken(token: string): Promise<TokenRecord | 'reused' | null> {
    return this.update((s) => {
      const h = sha256(token);
      const t = s.tokens[h];
      if (!t || t.expiresAt <= this.now()) return null;
      if (t.kind === 'used') {
        if (this.now() - (t.usedAt ?? 0) < REUSE_GRACE_MS) return null;
        for (const [k, x] of Object.entries(s.tokens)) if (k === h || (t.family && x.family === t.family)) delete s.tokens[k];
        return 'reused';
      }
      if (t.kind !== 'refresh') return null;
      s.tokens[h] = { ...t, kind: 'used', usedAt: this.now() };
      return t;
    });
  }

  /**
   * Reads remote.json on every call, so a revoke from another process (the CLI, the dashboard's 원격 커넥터 section)
   * takes effect on the next request. Records "last used" on the token and its registered client, at most once a
   * minute per token; a failed write never fails the request.
   */
  async verifyAccessToken(token: string): Promise<TokenRecord | null> {
    const s = await this.read();
    const h = sha256(token);
    const t = s.tokens[h];
    const now = this.now();
    if (!t || t.kind !== 'access' || t.expiresAt <= now) return null;
    if (t.lastUsedAt === undefined || now - t.lastUsedAt >= TOUCH_EVERY_MS) {
      await this.update((x) => {
        const cur = x.tokens[h];
        if (!cur) return; // revoked meanwhile: never bring it back
        cur.lastUsedAt = now;
        if (cur.family) for (const r of Object.values(x.tokens)) if (r.kind === 'refresh' && r.family === cur.family) r.lastUsedAt = now;
        if (Object.hasOwn(x.clients, cur.clientId)) x.clients[cur.clientId].lastUsedAt = now;
      }).catch(() => {});
    }
    return t;
  }

  /**
   * Dashboard: drop the tokens `match` picks (rotated ones too) and, with `client`, that client's registration.
   * Unlike revoke() it leaves a pending approval code alone. Returns how many live tokens went.
   */
  revokeMatching(match: (t: TokenRecord, hash: string) => boolean, client?: string): Promise<number> {
    return this.update((s) => {
      let n = 0;
      for (const [h, t] of Object.entries(s.tokens)) {
        if (!match(t, h)) continue;
        delete s.tokens[h];
        if (t.kind !== 'used') n++;
      }
      if (client !== undefined && Object.hasOwn(s.clients, client)) delete s.clients[client];
      return n;
    });
  }

  /** CLI: drop tokens (all, or one client's) and optionally the client registrations. */
  revoke(clientId?: string): Promise<number> {
    return this.update((s) => {
      let n = 0;
      for (const [h, t] of Object.entries(s.tokens)) {
        if (!clientId || t.clientId === clientId) {
          delete s.tokens[h];
          if (t.kind !== 'used') n++; // rotated refresh tokens were already dead
        }
      }
      if (clientId) delete s.clients[clientId];
      s.approval = null;
      return n;
    });
  }
}

/** The same lock file: same inode and the same modification time to the nanosecond (an inode number can be reused). */
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.dev === b.dev && a.mtimeNs === b.mtimeNs;

/**
 * Removes the stale lock file `st` so that two waiters can never both do it (security review S4). Unlinking after a
 * stat is not enough: a second waiter that also saw the stale file could delete the fresh lock the first one has
 * just taken, and both would write. So the waiters that judged this file stale race for a marker named after it
 * (inode and mtime), created with O_EXCL. Only the winner unlinks, and only after checking that the lock path still
 * holds that same file; the others go back to waiting. A marker older than 10 s belongs to a waiter that died between
 * the two steps (the same rule as the lock itself), and the next one, also O_EXCL, takes over.
 */
async function breakStale(lock: string, st: BigIntStats): Promise<void> {
  const id = `${st.dev}-${st.ino}-${st.mtimeNs}`;
  const markers: string[] = [];
  for (let k = 0; k < 10; k++) {
    const marker = `${lock}.break-${id}${k ? `-${k}` : ''}`;
    markers.push(marker);
    try {
      await (await open(marker, 'wx', 0o600)).close();
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const m = await stat(marker).catch(() => null);
      if (m && Date.now() - m.mtimeMs <= LOCK_STALE_MS) return; // another waiter is breaking it right now
      continue; // a dead breaker's marker
    }
    const cur = await stat(lock, { bigint: true }).catch(() => null);
    if (cur && sameFile(cur, st)) await unlink(lock).catch(() => {});
    // Only the winner cleans up, and only once the stale file is gone: a waiter that makes one of these markers again
    // later finds another file at the lock path, or none, and leaves it alone.
    for (const x of markers) await unlink(x).catch(() => {});
    return;
  }
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
