// Accounts proxy (docs/accounts.md#proxy): which added Claude account serves the next request, which accounts rest, and
// the last 100 things that happened. All of it lives in memory: a restart clears the resting marks and `current`. This file
// reads a token only to hand it to the proxy for one request: no event, count or text here holds a token, the proxy key, a
// header value, a body or a query string. The folder rule of refresh.ts holds: an account with a folder is the CLI's to
// refresh, so the pool reads its login file and never refreshes it.

import { hasHome, readHomeLogin, type HomesOptions } from './homes.ts';
import { refreshAccount } from './refresh.ts';
import { loadAccounts, type StoredAccount } from './store.ts';

/** A token that expires within this long is not used (an account without a folder is refreshed first) */
export const TOKEN_SKEW_MS = 60_000;
/** The ring of events kept in memory */
export const EVENTS_KEPT = 100;
/** A rest when the response names no end, and the bounds of every rest (opencodex codex/routing/cooldown-math.ts:27) */
export const DEFAULT_REST_MS = 60_000;
export const MAX_REST_MS = 6 * 3_600_000;
/** An account that answered 401 rests this long: the proxy never marks `needsReauth`, only the refresh path does */
export const UNAUTHORIZED_REST_MS = 10 * 60_000;
/** A `token expired` event for the same account is written at most once in this long (the ring stays readable) */
export const EXPIRED_NOTE_MS = 60_000;

export type ProxyEventKind = 'switch' | 'rest' | 'token expired' | 'no usable account';

export interface ProxyEvent {
  /** ISO */
  at: string;
  provider: 'claude';
  kind: ProxyEventKind;
  /** account id */
  from: string | null;
  /** account id */
  to: string | null;
  status: number | null;
  /** ISO */
  restUntil: string | null;
}

/** The same options as the other account code: fetch, now, accountsPath, accountHomes, home, env, readFile, platform */
export type PoolOptions = HomesOptions;

/** What a response says about the account that answered: it hit a shared limit, its token was refused, or neither */
export type Verdict = { kind: 'limit'; restMs: number } | { kind: 'unauthorized'; restMs: number } | null;

const UNIFIED = ['anthropic-ratelimit-unified-status', 'anthropic-ratelimit-unified-5h-status', 'anthropic-ratelimit-unified-7d-status'] as const;

const clampRest = (ms: number): number => (ms <= 0 ? DEFAULT_REST_MS : Math.min(ms, MAX_REST_MS));

/**
 * A 429 with a header that says the shared limit is `rejected` moves the request to the next account. A 429 with only
 * `retry-after` is a short rate limit: the account stays. A 401 rests the account for 10 minutes. Anything else passes through.
 */
export function verdictOf(status: number, h: Pick<Headers, 'get'>, now: number): Verdict {
  if (status === 401) return { kind: 'unauthorized', restMs: UNAUTHORIZED_REST_MS };
  if (status !== 429 || !UNIFIED.some((k) => h.get(k) === 'rejected')) return null;
  const retry = h.get('retry-after');
  if (retry !== null && /^\d+(\.\d+)?$/.test(retry.trim())) return { kind: 'limit', restMs: clampRest(Number(retry) * 1000) };
  // the later reset of the windows that are rejected, as epoch seconds
  let latest = NaN;
  for (const w of ['5h', '7d'] as const) {
    if (h.get(`anthropic-ratelimit-unified-${w}-status`) !== 'rejected') continue;
    const at = Number(h.get(`anthropic-ratelimit-unified-${w}-reset`));
    if (Number.isFinite(at) && !(at <= latest)) latest = at;
  }
  return { kind: 'limit', restMs: clampRest(Number.isFinite(latest) ? latest * 1000 - now : DEFAULT_REST_MS) };
}

export class Pool {
  /** the account that last answered well; memory only */
  current: string | null = null;
  switches = 0;
  private readonly resting = new Map<string, number>();
  private readonly ring: ProxyEvent[] = [];
  /** when each account last got a `token expired` event */
  private readonly expiredNoted = new Map<string, number>();

  private readonly o: PoolOptions;

  constructor(o: PoolOptions = {}) {
    this.o = o;
  }

  now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The newest `n` events, newest first */
  recent(n: number): ProxyEvent[] {
    return this.ring.slice(-n).reverse();
  }

  /** The accounts that rest now, with the end of the rest */
  restingNow(): { id: string; until: string }[] {
    const now = this.now();
    return [...this.resting].filter(([, until]) => until > now).map(([id, until]) => ({ id, until: new Date(until).toISOString() }));
  }

  note(e: { kind: ProxyEventKind; from?: string | null; to?: string | null; status?: number | null; restUntil?: number | null }): void {
    this.ring.push({
      at: new Date(this.now()).toISOString(),
      provider: 'claude',
      kind: e.kind,
      from: e.from ?? null,
      to: e.to ?? null,
      status: e.status ?? null,
      restUntil: e.restUntil == null ? null : new Date(e.restUntil).toISOString(),
    });
    if (this.ring.length > EVENTS_KEPT) this.ring.splice(0, this.ring.length - EVENTS_KEPT);
  }

  /** Let the account rest for `ms` (the end is kept in memory only) and record it */
  rest(id: string, ms: number, status: number): void {
    const until = this.now() + ms;
    this.resting.set(id, until);
    this.note({ kind: 'rest', from: id, status, restUntil: until });
  }

  /** The request moved from `from` to `to` after a response with `status` */
  switched(from: string, to: string, status: number): void {
    this.switches++;
    this.note({ kind: 'switch', from, to, status });
  }

  /**
   * The account for the next try of one request, or null when none is left. Order: `current`, the account "use this
   * account" chose, then the file's order. Left out: an account in `skip` (this request already used or dropped it), one that
   * needs a new sign-in, one that rests, and one with no usable token. Every account looked at goes into `skip`.
   */
  async next(skip: Set<string>): Promise<{ id: string; token: string } | null> {
    const loaded = await loadAccounts({ path: this.o.accountsPath });
    if ('error' in loaded) return null;
    const claude = loaded.accounts.filter((a) => a.provider === 'claude');
    const first = [this.current, loaded.active.claude].flatMap((id) => claude.filter((a) => a.id === id));
    const order = [...new Set([...first, ...claude])];
    for (const a of order) {
      if (skip.has(a.id) || a.needsReauth === true) continue;
      if ((this.resting.get(a.id) ?? 0) > this.now()) continue;
      skip.add(a.id);
      const token = await this.tokenOf(a);
      if (token) return { id: a.id, token };
      // one line per account per minute: an expired folder account is looked at on every request
      const now = this.now();
      if (now - (this.expiredNoted.get(a.id) ?? -Infinity) >= EXPIRED_NOTE_MS) {
        this.expiredNoted.set(a.id, now);
        this.note({ kind: 'token expired', to: a.id });
      }
    }
    return null;
  }

  /** The access token to send, or null. A folder account is read from its login file and never refreshed. */
  private async tokenOf(a: StoredAccount): Promise<string | null> {
    const at = this.now() + TOKEN_SKEW_MS;
    if (await hasHome(a, this.o)) {
      const l = await readHomeLogin(a, this.o);
      const exp = l?.expiresAt ? Date.parse(l.expiresAt) : NaN;
      return l && l.status === 'ok' && l.accessToken && exp > at ? l.accessToken : null;
    }
    const exp = a.tokens.expiresAt === null ? Infinity : Date.parse(a.tokens.expiresAt);
    if (exp > at) return a.tokens.access;
    const r = await refreshAccount(a.id, { ...this.o, rest: true, skewMs: TOKEN_SKEW_MS });
    return r.state === 'done' ? r.account.tokens.access : null;
  }
}
