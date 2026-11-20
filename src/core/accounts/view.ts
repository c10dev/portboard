// Accounts (docs/accounts.md): what leaves the process. A LocalLogin holds the access token, so each AccountView field
// is assigned one by one from an allowlist: no spread, no copy of the record.

import { detectLogins, type DetectOptions, type LocalLogin } from './detect.ts';
import { fetchQuota, type QuotaResult, type QuotaWindow } from './quota.ts';

export interface AccountView {
  id: string;
  provider: 'claude' | 'codex';
  source: 'local-cli';
  email: string | null;
  plan: string | null;
  tier: string | null;
  status: 'ok' | 'expired' | 'none' | 'unreadable';
  expiresAt: string | null;
  needsReauth: boolean;
  quota: null | { windows: QuotaWindow[]; fetchedAt: string; stale: boolean };
  error: string | null;
}

export interface AccountsReport {
  at: string;
  accounts: AccountView[];
}

function viewOf(l: LocalLogin, q: QuotaResult | null, now: number): AccountView {
  const v: AccountView = {
    id: l.id,
    provider: l.provider,
    source: 'local-cli',
    email: l.email,
    plan: l.plan,
    tier: l.tier,
    status: l.status,
    expiresAt: l.expiresAt,
    needsReauth: l.refreshExpiresAt !== null && Date.parse(l.refreshExpiresAt) < now,
    quota: null,
    error: l.error,
  };
  if (!q) return v;
  v.status = q.status;
  v.error = q.error;
  v.plan = l.provider === 'codex' ? (q.plan ?? l.plan) : (l.plan ?? q.plan);
  if (l.provider === 'codex') v.email = q.email ?? l.email;
  if (q.quota) v.quota = { windows: q.quota.windows.map((w) => ({ name: w.name, usedPct: w.usedPct, resetsAt: w.resetsAt })), fetchedAt: q.quota.fetchedAt, stale: q.quota.stale };
  return v;
}

/** detect → quota → view, for both CLIs. A login that is missing or unreadable is not asked for limits. */
export async function accountsReport(o: DetectOptions & { fetch?: typeof fetch; now?: () => number } = {}): Promise<AccountsReport> {
  const now = o.now ?? Date.now;
  const logins = await detectLogins({ home: o.home, env: o.env, readFile: o.readFile });
  const accounts = await Promise.all(
    logins.map(async (l) => viewOf(l, l.status === 'ok' ? await fetchQuota(l, { fetch: o.fetch, now: o.now }) : null, now())),
  );
  return { at: new Date(now()).toISOString(), accounts };
}
