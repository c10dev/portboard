// Accounts (docs/accounts.md): what leaves the process. A LocalLogin holds the access token, so each AccountView field
// is assigned one by one from an allowlist: no spread, no copy of the record.

import { detectLogins, type DetectOptions, type LocalLogin } from './detect.ts';
import { fetchQuota, type QuotaResult, type QuotaWindow } from './quota.ts';
import { loadAccounts, type StoredAccount } from './store.ts';

export interface AccountView {
  id: string;
  provider: 'claude' | 'codex' | 'copilot';
  source: 'local-cli' | 'added';
  /** the name the owner gave an added account; null for a CLI login */
  alias: string | null;
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
    alias: null,
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

/** An added account as the dashboard sees it. Field by field: the tokens and the identity stay in the record. */
export function addedView(a: StoredAccount, q: QuotaResult | null, now: number): AccountView {
  const expired = a.tokens.expiresAt !== null && Date.parse(a.tokens.expiresAt) < now;
  const v: AccountView = {
    id: a.id,
    provider: a.provider,
    source: 'added',
    alias: a.alias,
    email: a.email,
    plan: a.plan,
    tier: null,
    status: expired ? 'expired' : 'ok',
    expiresAt: a.tokens.expiresAt,
    needsReauth: false,
    quota: null,
    error: expired ? 'access token expired' : null,
  };
  if (!q) return v;
  v.status = q.status;
  v.error = q.error;
  v.plan = a.provider === 'codex' ? (q.plan ?? a.plan) : (a.plan ?? q.plan);
  if (a.provider === 'codex') v.email = q.email ?? a.email;
  if (q.quota) v.quota = { windows: q.quota.windows.map((w) => ({ name: w.name, usedPct: w.usedPct, resetsAt: w.resetsAt })), fetchedAt: q.quota.fetchedAt, stale: q.quota.stale };
  return v;
}

/** The record of an added Claude or Codex account in the shape fetchQuota takes. Copilot has no limits to ask for. */
function loginOf(a: StoredAccount): LocalLogin | null {
  if (a.provider === 'copilot') return null;
  return {
    provider: a.provider,
    id: a.id,
    status: 'ok',
    email: a.email,
    plan: a.plan,
    tier: null,
    expiresAt: a.tokens.expiresAt,
    refreshExpiresAt: null,
    accountId: a.provider === 'codex' ? a.identity : null,
    accessToken: a.tokens.access,
    error: null,
  };
}

/** detect → quota → view, for both CLIs, then the added accounts. A login that is missing or unreadable is not asked for limits. */
export async function accountsReport(
  o: DetectOptions & { fetch?: typeof fetch; now?: () => number; accountsPath?: string } = {},
): Promise<AccountsReport> {
  const now = o.now ?? Date.now;
  const logins = await detectLogins({ home: o.home, env: o.env, readFile: o.readFile, platform: o.platform });
  const local = await Promise.all(
    logins.map(async (l) => viewOf(l, l.status === 'ok' ? await fetchQuota(l, { fetch: o.fetch, now: o.now }) : null, now())),
  );
  const stored = await loadAccounts({ path: o.accountsPath });
  let added: AccountView[];
  if ('error' in stored) {
    added = [
      {
        id: 'added-unreadable', provider: 'claude', source: 'added', alias: null, email: null, plan: null, tier: null,
        status: 'unreadable', expiresAt: null, needsReauth: false, quota: null, error: stored.error,
      },
    ];
  } else {
    added = await Promise.all(
      stored.accounts.map(async (a) => {
        const l = loginOf(a);
        return addedView(a, l ? await fetchQuota(l, { fetch: o.fetch, now: o.now }) : null, now());
      }),
    );
  }
  return { at: new Date(now()).toISOString(), accounts: [...local, ...added] };
}
