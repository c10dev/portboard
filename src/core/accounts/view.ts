// Accounts (docs/accounts.md): what leaves the process. A LocalLogin holds the access token, so each AccountView field
// is assigned one by one from an allowlist: no spread, no copy of the record.

import { detectLogins, type DetectOptions, type LocalLogin } from './detect.ts';
import { hasHome, homeCommand, readHomeLogin } from './homes.ts';
import { fetchQuota, type QuotaResult, type QuotaWindow } from './quota.ts';
import { refreshAccount } from './refresh.ts';
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
  /** an added account that is in use for its provider ("use this account" chose it); false for a CLI login */
  active: boolean;
  /** the shell command that starts the CLI as this account, once it has a folder (docs/accounts.md); null otherwise and for a CLI login */
  command: string | null;
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
    active: false,
    command: null,
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
export function addedView(a: StoredAccount, q: QuotaResult | null, now: number, extra: { active?: boolean; command?: string | null } = {}): AccountView {
  const v = addedFields(a, q, now, extra);
  // the vendor refused the refresh token: sign in again says more than "expired"
  if (a.needsReauth && v.status === 'expired') v.error = 'account needs sign-in again';
  return v;
}

function addedFields(a: StoredAccount, q: QuotaResult | null, now: number, extra: { active?: boolean; command?: string | null }): AccountView {
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
    needsReauth: a.needsReauth === true,
    active: extra.active === true,
    command: extra.command ?? null,
    quota: null,
    error: expired ? (a.needsReauth ? 'account needs sign-in again' : 'access token expired') : null,
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

/**
 * An added account that has a folder, as the list shows it: the login file in the folder is the original, so its expiry
 * (and the refresh expiry the CLI keeps) count. A file that is missing or cannot be read is `unreadable`.
 */
export function homeView(a: StoredAccount, l: LocalLogin | null, q: QuotaResult | null, now: number, extra: { active?: boolean; command?: string | null }): AccountView {
  if (!l || l.status !== 'ok') return { ...addedView(a, null, now, extra), status: 'unreadable', error: 'credentials file unreadable' };
  const v = addedView({ ...a, tokens: { ...a.tokens, expiresAt: l.expiresAt } }, q, now, extra);
  if (l.refreshExpiresAt !== null && Date.parse(l.refreshExpiresAt) < now) v.needsReauth = true;
  return v;
}

/**
 * One added account. With a folder, the file in it is the original of the tokens (the CLI refreshes it): it is read like a
 * CLI login and never refreshed here. Without one, an expired access token is refreshed first when there is a refresh token
 * (never ahead of time, and a failed try rests for a while). Only when `o.refresh` is set: the dashboard asks for it, the read-only MCP tool does not.
 */
async function addedReport(
  a: StoredAccount,
  active: boolean,
  o: DetectOptions & { fetch?: typeof fetch; now?: () => number; accountsPath?: string; accountHomes?: string; refresh?: boolean },
): Promise<AccountView> {
  const now = (o.now ?? Date.now)();
  const homed = await hasHome(a, o);
  const command = homed ? homeCommand(a, { accountHomes: o.accountHomes }) : null;
  const extra = { active, command };
  if (homed) {
    const l = await readHomeLogin(a, o);
    return homeView(a, l, l && l.status === 'ok' ? await fetchQuota(l, { fetch: o.fetch, now: o.now }) : null, now, extra);
  }
  let rec = a;
  const expired = a.tokens.expiresAt !== null && Date.parse(a.tokens.expiresAt) < now;
  if (o.refresh && a.provider !== 'copilot' && expired && a.tokens.refresh && !a.needsReauth) {
    const r = await refreshAccount(a.id, { fetch: o.fetch, now: o.now, accountsPath: o.accountsPath, rest: true });
    if (r.state === 'done') rec = r.account;
    else if (r.state === 'reauth') rec = { ...a, needsReauth: true };
  }
  const l = loginOf(rec);
  return addedView(rec, l ? await fetchQuota(l, { fetch: o.fetch, now: o.now }) : null, now, extra);
}

/** detect → quota → view, for both CLIs, then the added accounts. A login that is missing or unreadable is not asked for limits. */
export async function accountsReport(
  o: DetectOptions & { fetch?: typeof fetch; now?: () => number; accountsPath?: string; accountHomes?: string; refresh?: boolean } = {},
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
        status: 'unreadable', expiresAt: null, needsReauth: false, active: false, command: null, quota: null, error: stored.error,
      },
    ];
  } else {
    added = await Promise.all(stored.accounts.map((a) => addedReport(a, stored.active[a.provider as 'claude' | 'codex'] === a.id, o)));
  }
  return { at: new Date(now()).toISOString(), accounts: [...local, ...added] };
}
