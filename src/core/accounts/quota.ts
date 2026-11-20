// Accounts (docs/accounts.md): the remaining limits of one login, asked from the two unofficial usage endpoints the
// CLIs' own clients use. Read-only GET requests. The token is refreshed never, kept in the answer never, and logged
// never: an error is one of a closed set of short fixed texts, with no response body, header or token in it.

import { createHash } from 'node:crypto';
import type { LocalLogin } from './detect.ts';

// The two URLs and every request header live in this block and nowhere else. The shapes follow opencodex commit
// d61cca12 (MIT): src/providers/claude-cli-usage.ts (the Claude URL and headers) and
// src/codex/auth-api/main-account-probe.ts (the Codex URL and headers). No code is copied. A header change is made here.
export const QUOTA_REQUESTS = {
  claude: {
    url: 'https://api.anthropic.com/api/oauth/usage',
    headers: (token: string, _accountId: string | null): Record<string, string> => ({
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05',
      Authorization: `Bearer ${token}`,
    }),
  },
  codex: {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    headers: (token: string, accountId: string | null): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    }),
  },
};

export interface QuotaWindow {
  name: '5h' | 'weekly' | string;
  usedPct: number | null;
  resetsAt: string | null;
}

export interface QuotaResult {
  quota: { windows: QuotaWindow[]; fetchedAt: string; stale: boolean } | null;
  plan: string | null;
  email: string | null;
  status: 'ok' | 'expired';
  error: string | null;
}

const TIMEOUT_MS = 8_000;
const CACHE_MS = 5 * 60_000;
const MAX_BODY = 512 * 1024;

interface Cached {
  at: number;
  windows: QuotaWindow[];
  plan: string | null;
  email: string | null;
}

interface Entry {
  good: Cached | null;
  /** the current wait after a failure, ms; 0 when the last request worked */
  delay: number;
  failedUntil: number;
  lastFail: { error: string; status: 'ok' | 'expired' } | null;
}

const FAIL_MIN_MS = 5 * 60_000;
const FAIL_MAX_MS = 60 * 60_000;
const NAME_MAX = 40;
const PLAN_MAX = 40;
const EMAIL_MAX = 254;

/** Keyed by provider and a hash of the access token, so a new login or a refreshed token starts clean. Memory only. */
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<QuotaResult>>();

/** For tests */
export function clearQuotaCache(): void {
  cache.clear();
  inflight.clear();
}

/** Text from a response: control characters out, cut at `max` with an ellipsis */
function clip(v: string, max: number): string {
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ---- parsing ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A number, or a numeric string; else null */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 0–100, clamped; null when it is not a number */
function pct(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

/** A number (above 1e10: ms, else seconds), a numeric string, or a date string → ISO; else null */
function resetIso(v: unknown): string | null {
  let ms: number | null = null;
  const n = num(v);
  if (n !== null) {
    if (n <= 0) return null;
    ms = n > 1e10 ? n : n * 1000;
  } else if (typeof v === 'string' && v) {
    ms = Date.parse(v);
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function claudeWindows(body: Record<string, unknown>): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  const has = (name: string) => out.some((w) => w.name === name);
  if (Array.isArray(body.limits)) {
    for (const row of body.limits) {
      if (!isObj(row)) continue;
      let name: string | null = null;
      if (row.kind === 'session') name = '5h';
      else if (row.kind === 'weekly_all') name = 'weekly';
      else if (row.kind === 'weekly_scoped' && row.is_active !== false) {
        const model = isObj(row.scope) && isObj(row.scope.model) ? row.scope.model.display_name : null;
        name = typeof model === 'string' && model ? clip(`weekly-${model.toLowerCase()}`, NAME_MAX) : 'weekly-scoped';
      }
      if (name && !has(name)) out.push({ name, usedPct: pct(row.percent), resetsAt: resetIso(row.resets_at) });
    }
  }
  const OLD: [string, string][] = [['five_hour', '5h'], ['seven_day', 'weekly'], ['seven_day_opus', 'weekly-opus'], ['seven_day_sonnet', 'weekly-sonnet']];
  for (const [key, name] of OLD) {
    const w = body[key];
    if (!isObj(w) || has(name)) continue;
    out.push({ name, usedPct: pct(w.utilization), resetsAt: resetIso(w.resets_at) });
  }
  return out;
}

function codexWindows(body: Record<string, unknown>): QuotaWindow[] {
  const rl = isObj(body.rate_limit) ? body.rate_limit : {};
  const out: QuotaWindow[] = [];
  const seen = new Map<string, number>();
  for (const key of ['primary_window', 'secondary_window', 'tertiary_window'] as const) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const secs = num(w.limit_window_seconds);
    let base: string;
    if (secs === null) base = key === 'tertiary_window' ? 'monthly' : 'weekly';
    else if (secs < 86_400) base = '5h';
    else if (secs < 2_419_200) base = 'weekly';
    else base = 'monthly';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ name: clip(n === 1 ? base : `${base}-${n}`, NAME_MAX), usedPct: pct(w.used_percent), resetsAt: resetIso(w.reset_at) });
  }
  return out;
}

// ---- request ----

/** The body as text, or null when it is over the limit */
async function readLimited(res: Response): Promise<string | null> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY) return null;
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    return t.length > MAX_BODY ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Parsed = { ok: true; windows: QuotaWindow[]; plan: string | null; email: string | null } | { ok: false; error: string; status?: 'expired' };

async function request(l: LocalLogin, doFetch: typeof fetch): Promise<Parsed> {
  const spec = QUOTA_REQUESTS[l.provider];
  let res: Response;
  try {
    res = await doFetch(spec.url, {
      method: 'GET',
      headers: spec.headers(l.accessToken ?? '', l.accountId),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { ok: false, error: name === 'AbortError' || name === 'TimeoutError' ? 'quota request timed out' : 'quota request failed' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 'expired', error: `quota request refused (HTTP ${res.status})` };
  if (res.status === 429) return { ok: false, error: 'quota rate limited' };
  if (!res.ok) return { ok: false, error: `quota request failed (HTTP ${res.status})` };
  let raw: string | null;
  try {
    raw = await readLimited(res);
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { ok: false, error: name === 'AbortError' || name === 'TimeoutError' ? 'quota request timed out' : 'quota request failed' };
  }
  if (raw === null) return { ok: false, error: 'quota response too large' };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'quota response unusable' };
  }
  if (!isObj(body)) return { ok: false, error: 'quota response unusable' };
  const windows = l.provider === 'claude' ? claudeWindows(body) : codexWindows(body);
  // a 200 with no window we know is an answer we cannot use, not an empty set of limits
  if (windows.length === 0) return { ok: false, error: 'quota response unusable' };
  if (l.provider === 'claude') return { ok: true, windows, plan: null, email: null };
  return {
    ok: true,
    windows,
    plan: typeof body.plan_type === 'string' && clip(body.plan_type, PLAN_MAX) ? clip(body.plan_type, PLAN_MAX) : null,
    email: typeof body.email === 'string' && clip(body.email, EMAIL_MAX) ? clip(body.email, EMAIL_MAX) : null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The limits of one login. Within 5 minutes of a good answer, that answer is reused. After a failure (any, a 401 too)
 * nothing is sent for 5 minutes, then 10, up to 60: the last failure and the last good answer, marked stale, come
 * back meanwhile. Requests for one token at once share one request. An expired access token is not sent; no token is
 * ever refreshed here.
 */
export async function fetchQuota(l: LocalLogin, o: { fetch?: typeof fetch; now?: () => number } = {}): Promise<QuotaResult> {
  const now = (o.now ?? Date.now)();
  if (l.status !== 'ok' || !l.accessToken) return { quota: null, plan: null, email: null, status: 'ok', error: l.error };
  const key = `${l.provider}:${createHash('sha256').update(l.accessToken).digest('hex').slice(0, 16)}`;
  const entry: Entry = cache.get(key) ?? { good: null, delay: 0, failedUntil: 0, lastFail: null };
  const failure = (error: string, status: 'ok' | 'expired'): QuotaResult => ({
    quota: entry.good ? { windows: entry.good.windows, fetchedAt: iso(entry.good.at), stale: true } : null,
    plan: entry.good?.plan ?? null,
    email: entry.good?.email ?? null,
    status,
    error,
  });

  if (l.expiresAt !== null && Date.parse(l.expiresAt) < now) return failure('access token expired', 'expired');
  const g = entry.good;
  if (g && now - g.at < CACHE_MS) return { quota: { windows: g.windows, fetchedAt: iso(g.at), stale: false }, plan: g.plan, email: g.email, status: 'ok', error: null };
  if (entry.lastFail && now < entry.failedUntil) return failure(entry.lastFail.error, entry.lastFail.status);
  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<QuotaResult> => {
    const r = await request(l, o.fetch ?? fetch);
    if (!r.ok) {
      const status = r.status ?? 'ok';
      entry.delay = Math.min(Math.max(entry.delay * 2, FAIL_MIN_MS), FAIL_MAX_MS);
      entry.failedUntil = now + entry.delay;
      entry.lastFail = { error: r.error, status };
      cache.set(key, entry);
      return failure(r.error, status);
    }
    entry.good = { at: now, windows: r.windows, plan: r.plan, email: r.email };
    entry.delay = 0;
    entry.failedUntil = 0;
    entry.lastFail = null;
    cache.set(key, entry);
    return { quota: { windows: r.windows, fetchedAt: iso(now), stale: false }, plan: r.plan, email: r.email, status: 'ok', error: null };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
