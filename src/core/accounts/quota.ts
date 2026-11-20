// Accounts (docs/accounts.md): the remaining limits of one login, asked from the two unofficial usage endpoints the
// CLIs' own clients use. Read-only GET requests. The token is refreshed never, kept in the answer never, and logged
// never: an error is one of a closed set of short fixed texts, with no response body, header or token in it.

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

const cache = new Map<string, Cached>();

/** For tests */
export function clearQuotaCache(): void {
  cache.clear();
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
        name = typeof model === 'string' && model ? `weekly-${model.toLowerCase()}` : 'weekly-scoped';
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
    out.push({ name: n === 1 ? base : `${base}-${n}`, usedPct: pct(w.used_percent), resetsAt: resetIso(w.reset_at) });
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
  if (l.provider === 'claude') return { ok: true, windows: claudeWindows(body), plan: null, email: null };
  return {
    ok: true,
    windows: codexWindows(body),
    plan: typeof body.plan_type === 'string' && body.plan_type ? body.plan_type : null,
    email: typeof body.email === 'string' && body.email ? body.email : null,
  };
}

/**
 * The limits of one login. Within 5 minutes of a good answer, that answer is reused. After a failure the last good
 * answer comes back marked stale. An expired access token is not sent; no token is ever refreshed here.
 */
export async function fetchQuota(l: LocalLogin, o: { fetch?: typeof fetch; now?: () => number } = {}): Promise<QuotaResult> {
  const now = (o.now ?? Date.now)();
  const key = `${l.provider}:${l.id}`;
  const last = cache.get(key);
  const iso = (ms: number) => new Date(ms).toISOString();
  const fromCache = (c: Cached, stale: boolean) => ({ windows: c.windows, fetchedAt: iso(c.at), stale });
  const fail = (error: string, status: 'ok' | 'expired'): QuotaResult => ({
    quota: last ? fromCache(last, true) : null,
    plan: last?.plan ?? null,
    email: last?.email ?? null,
    status,
    error,
  });

  if (l.status !== 'ok' || !l.accessToken) return { quota: null, plan: null, email: null, status: 'ok', error: l.error };
  if (l.expiresAt !== null && Date.parse(l.expiresAt) < now) return fail('access token expired', 'expired');
  if (last && now - last.at < CACHE_MS) return { quota: fromCache(last, false), plan: last.plan, email: last.email, status: 'ok', error: null };

  const r = await request(l, o.fetch ?? fetch);
  if (!r.ok) return fail(r.error, r.status ?? 'ok');
  const fresh: Cached = { at: now, windows: r.windows, plan: r.plan, email: r.email };
  cache.set(key, fresh);
  return { quota: fromCache(fresh, false), plan: r.plan, email: r.email, status: 'ok', error: null };
}
