// Accounts proxy (docs/accounts.md#proxy): which added Claude or Codex account serves the next request, which accounts rest, and
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

export type ProxyProvider = 'claude' | 'codex';
export type ProxyEventKind = 'switch' | 'rest' | 'token expired' | 'no usable account';

export interface ProxyEvent {
  /** ISO */
  at: string;
  provider: ProxyProvider;
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
 * Claude: a 429 with a header that says the shared limit is `rejected` moves the request to the next account. A 429 with only
 * `retry-after` is a short rate limit: the account stays. Codex: a 429 or a 402 moves it (the body is not read). A 401 rests the
 * account for 10 minutes. Anything else passes through.
 */
export function verdictOf(provider: ProxyProvider, status: number, h: Pick<Headers, 'get'>, now: number): Verdict {
  if (status === 401) return { kind: 'unauthorized', restMs: UNAUTHORIZED_REST_MS };
  return provider === 'codex' ? codexVerdict(status, h, now) : claudeVerdict(status, h, now);
}

const retryAfterMs = (h: Pick<Headers, 'get'>): number | null => {
  const retry = h.get('retry-after');
  return retry !== null && /^\d+(\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : null;
};

function claudeVerdict(status: number, h: Pick<Headers, 'get'>, now: number): Verdict {
  if (status !== 429 || !UNIFIED.some((k) => h.get(k) === 'rejected')) return null;
  const retry = retryAfterMs(h);
  if (retry !== null) return { kind: 'limit', restMs: clampRest(retry) };
  // the later reset of the windows that are rejected, as epoch seconds
  let latest = NaN;
  for (const w of ['5h', '7d'] as const) {
    if (h.get(`anthropic-ratelimit-unified-${w}-status`) !== 'rejected') continue;
    const at = Number(h.get(`anthropic-ratelimit-unified-${w}-reset`));
    if (Number.isFinite(at) && !(at <= latest)) latest = at;
  }
  return { kind: 'limit', restMs: clampRest(Number.isFinite(latest) ? latest * 1000 - now : DEFAULT_REST_MS) };
}

/** `x-codex-<window>-reset-at` as epoch seconds, or NaN (rate_limits.rs in Codex rust-v0.159.3 names these headers) */
const codexReset = (h: Pick<Headers, 'get'>, w: 'primary' | 'secondary'): number => {
  const v = h.get(`x-codex-${w}-reset-at`);
  return v !== null && v.trim() !== '' ? Number(v) : NaN;
};

/**
 * 429 and 402 are a switch (opencodex core-codex-account.ts:437-445). The rest: `retry-after`, else the later reset of the
 * windows that are used up (100 percent or more), else the earlier reset that is still ahead, else 60 s.
 */
function codexVerdict(status: number, h: Pick<Headers, 'get'>, now: number): Verdict {
  if (status !== 429 && status !== 402) return null;
  const retry = retryAfterMs(h);
  if (retry !== null) return { kind: 'limit', restMs: clampRest(retry) };
  const windows = (['primary', 'secondary'] as const).map((w) => ({ used: Number(h.get(`x-codex-${w}-used-percent`)), reset: codexReset(h, w) }));
  const full = windows.filter((w) => w.used >= 100 && Number.isFinite(w.reset)).map((w) => w.reset);
  if (full.length) return { kind: 'limit', restMs: clampRest(Math.max(...full) * 1000 - now) };
  const ahead = windows.map((w) => w.reset).filter((r) => Number.isFinite(r) && r * 1000 > now);
  return { kind: 'limit', restMs: clampRest(ahead.length ? Math.min(...ahead) * 1000 - now : DEFAULT_REST_MS) };
}

export class Pool {
  /** the account that last answered well, per provider; memory only */
  current: { claude: string | null; codex: string | null } = { claude: null, codex: null };
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

  private readonly noAccountNoted: Record<ProxyProvider, number> = { claude: -Infinity, codex: -Infinity };

  /** `no usable account`: at most one line per minute and provider, as for `token expired` */
  noteNoAccount(provider: ProxyProvider): void {
    const now = this.now();
    if (now - this.noAccountNoted[provider] < EXPIRED_NOTE_MS) return;
    this.noAccountNoted[provider] = now;
    this.note({ provider, kind: 'no usable account', status: 503 });
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

  note(e: { provider: ProxyProvider; kind: ProxyEventKind; from?: string | null; to?: string | null; status?: number | null; restUntil?: number | null }): void {
    this.ring.push({
      at: new Date(this.now()).toISOString(),
      provider: e.provider,
      kind: e.kind,
      from: e.from ?? null,
      to: e.to ?? null,
      status: e.status ?? null,
      restUntil: e.restUntil == null ? null : new Date(e.restUntil).toISOString(),
    });
    if (this.ring.length > EVENTS_KEPT) this.ring.splice(0, this.ring.length - EVENTS_KEPT);
  }

  /** Let the account rest for `ms` (the end is kept in memory only) and record it */
  rest(provider: ProxyProvider, id: string, ms: number, status: number): void {
    const until = this.now() + ms;
    this.resting.set(id, until);
    this.note({ provider, kind: 'rest', from: id, status, restUntil: until });
  }

  /** The request moved from `from` to `to` after a response with `status` */
  switched(provider: ProxyProvider, from: string, to: string, status: number): void {
    this.switches++;
    this.note({ provider, kind: 'switch', from, to, status });
  }

  /**
   * The account for the next try of one request, or null when none is left. Only added accounts of `provider`. Order:
   * `current[provider]`, the account "use this account" chose, then the file's order. Left out: an account in `skip` (this
   * request already used or dropped it), one that needs a new sign-in, one that rests, one with no usable token, and (Codex)
   * one with no account id. Every account looked at goes into `skip`. `accountId` is set for Codex only.
   */
  async next(provider: ProxyProvider, skip: Set<string>): Promise<{ id: string; token: string; accountId: string | null } | null> {
    const loaded = await loadAccounts({ path: this.o.accountsPath });
    if ('error' in loaded) return null;
    const mine = loaded.accounts.filter((a) => a.provider === provider);
    const first = [this.current[provider], loaded.active[provider]].flatMap((id) => mine.filter((a) => a.id === id));
    const order = [...new Set([...first, ...mine])];
    for (const a of order) {
      if (skip.has(a.id) || a.needsReauth === true) continue;
      if ((this.resting.get(a.id) ?? 0) > this.now()) continue;
      skip.add(a.id);
      const got = await this.tokenOf(a);
      // a Codex account with no account id cannot be sent: it is left out without a note
      if (got === 'no id') continue;
      if (got) return { id: a.id, ...got };
      // one line per account per minute: an expired folder account is looked at on every request
      const now = this.now();
      if (now - (this.expiredNoted.get(a.id) ?? -Infinity) >= EXPIRED_NOTE_MS) {
        this.expiredNoted.set(a.id, now);
        this.note({ provider, kind: 'token expired', to: a.id });
      }
    }
    return null;
  }

  /** The access token to send (and, for Codex, the account id), or null. A folder account is read from its login file and never refreshed. */
  private async tokenOf(a: StoredAccount): Promise<{ token: string; accountId: string | null } | 'no id' | null> {
    const codex = a.provider === 'codex';
    const at = this.now() + TOKEN_SKEW_MS;
    if (await hasHome(a, this.o)) {
      const l = await readHomeLogin(a, this.o);
      if (!l || l.status !== 'ok' || !l.accessToken) return null;
      // a Codex token with no exp claim has no known end: it is used, and a 401 rests the account
      const exp = l.expiresAt ? Date.parse(l.expiresAt) : codex ? Infinity : NaN;
      if (codex && !l.accountId) return 'no id';
      return exp > at ? { token: l.accessToken, accountId: codex ? l.accountId : null } : null;
    }
    const accountId = codex ? a.identity || null : null;
    if (codex && !accountId) return 'no id';
    const exp = a.tokens.expiresAt === null ? Infinity : Date.parse(a.tokens.expiresAt);
    if (exp > at) return { token: a.tokens.access, accountId };
    const r = await refreshAccount(a.id, { ...this.o, rest: true, skewMs: TOKEN_SKEW_MS });
    return r.state === 'done' ? { token: r.account.tokens.access, accountId } : null;
  }
}
