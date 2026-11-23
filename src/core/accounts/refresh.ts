// Accounts (docs/accounts.md): the refresh of an added Claude or Codex account that has no folder of its own. An
// account with a folder is never refreshed here: the CLI refreshes the file in the folder, and refresh tokens turn
// over, so two refreshers would cut one of them off. (A refresh that was already running when a use marked the account
// saves its new tokens in the record only, because the old refresh token is spent.) The request URLs, client ids and headers are LOGIN_REQUESTS
// (flows.ts); the request goes through the same `vendor()` helper (timeout, body limit, closed errors).

import { expiresIn, LOGIN_REQUESTS, LoginError, TOKEN_TIMEOUT_MS, vendor } from './flows.ts';
import { hasHome, homeFileState, type HomesOptions } from './homes.ts';
import { loadAccounts, updateAccount, type StoredAccount } from './store.ts';

export type RefreshOutcome =
  /** new tokens are saved; `account` is the record after the change */
  | { state: 'done'; account: StoredAccount }
  /** the vendor refused the refresh token (400 or 401): `needsReauth` is saved */
  | { state: 'reauth' }
  /** the vendor refused the refresh token of an account that a use marked meanwhile: no record change, the use decides */
  | { state: 'refused' }
  /** nothing to refresh with: no such account, no refresh token, Copilot, or an account with a folder */
  | { state: 'unusable' }
  /** a failure that passes (network, timeout, 5xx, 429, an answer without a token, a file that cannot be used): asked again later */
  | { state: 'transient' };

/** After a transient failure the quota path does not ask again for this long (a use asks at once) */
const REST_MS = 5 * 60_000;

const inflight = new Map<string, Promise<RefreshOutcome>>();
const restUntil = new Map<string, number>();

/** For tests */
export function resetRefreshForTest(): void {
  inflight.clear();
  restUntil.clear();
}

/** The refresh of this account that is running now, if any: a use waits for it before it reads the record */
export function pendingRefresh(id: string): Promise<RefreshOutcome> | undefined {
  return inflight.get(id);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** True while a failed refresh of this account is resting (the quota path then skips it) */
export function refreshResting(id: string, now: number): boolean {
  return (restUntil.get(id) ?? 0) > now;
}

/**
 * Refresh one account. Calls for the same account at once share one request. `rest`: honour the wait after a
 * transient failure (the quota path); a use of the account passes false. `skewMs`: a token that expires within this
 * many ms counts as expired (default 0; only the proxy asks for 60 s, pool.ts).
 */
export function refreshAccount(id: string, o: HomesOptions & { rest?: boolean; forUse?: boolean; skewMs?: number } = {}): Promise<RefreshOutcome> {
  const now = (o.now ?? Date.now)();
  if (o.rest && refreshResting(id, now)) return Promise.resolve({ state: 'transient' });
  const running = inflight.get(id);
  if (running) return running;
  const job = run(id, o)
    .then((r) => {
      if (r.state === 'transient') restUntil.set(id, now + REST_MS);
      else restUntil.delete(id);
      return r;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/**
 * `forUse`: a use of the account asks. A folder login file that is there then does not stop the refresh (the use is about to
 * replace it); only the `home` mark does.
 */
async function run(id: string, o: HomesOptions & { forUse?: boolean; skewMs?: number }): Promise<RefreshOutcome> {
  const loaded = await loadAccounts({ path: o.accountsPath });
  if ('error' in loaded) return { state: 'transient' };
  const a = loaded.accounts.find((x) => x.id === id);
  if (!a || a.provider === 'copilot' || !a.tokens.refresh) return { state: 'unusable' };
  // an account with a folder is the CLI's to refresh
  if (a.home || (!o.forUse && (await hasHome(a, o)))) return { state: 'unusable' };
  // the record was read again: a refresh that finished meanwhile left a token that has not expired
  const at0 = (o.now ?? Date.now)();
  if (a.tokens.expiresAt === null || Date.parse(a.tokens.expiresAt) >= at0 + (o.skewMs ?? 0)) return { state: 'done', account: a };
  const refresh = a.tokens.refresh;
  const spec = a.provider === 'claude' ? LOGIN_REQUESTS.claude : LOGIN_REQUESTS.codex;
  const request =
    a.provider === 'claude'
      ? { headers: LOGIN_REQUESTS.claude.tokenHeaders(), body: { grant_type: 'refresh_token', client_id: LOGIN_REQUESTS.claude.clientId, refresh_token: refresh } }
      : { headers: LOGIN_REQUESTS.codex.jsonHeaders(), body: { client_id: LOGIN_REQUESTS.codex.clientId, grant_type: 'refresh_token', refresh_token: refresh } };
  let answer;
  try {
    answer = await vendor(o, spec.tokenUrl, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      redirect: 'manual',
      timeoutMs: TOKEN_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof LoginError) return { state: 'transient' };
    throw err;
  }
  if (!answer.ok) {
    if (answer.status !== 400 && answer.status !== 401) return { state: 'transient' };
    try {
      let marked = false;
      await updateAccount(id, (x) => (x.home ? ((marked = true), x) : { ...x, needsReauth: true }), { path: o.accountsPath });
      if (marked) return { state: 'refused' };
    } catch {
      return { state: 'transient' };
    }
    return { state: 'reauth' };
  }
  const body = isObj(answer.body) ? answer.body : null;
  const access = body ? str(body.access_token) : null;
  if (!body || !access) return { state: 'transient' };
  const at = (o.now ?? Date.now)();
  // no `home` mark and a login file in the folder: it is the CLI's original, so this answer is skipped (the `if` below)
  // (a file that is not known to be there, state 'unknown', does not skip: the old refresh token is spent, so the new tokens are kept in the record)
  const fileThere = !o.forUse && (await homeFileState(a, o)) === 'file';
  try {
    let skipped = false;
    const saved = await updateAccount(
      id,
      (x) => {
        // no folder mark and a folder login file known to be there: the CLI owns the tokens, so this answer is not saved
        // (with the mark, a use marked the account while the vendor answered: the refresh token it spent is replaced,
        // so the new tokens below go into the record, the use writes the folder file from the record, and `home` stays)
        if (!x.home && fileThere) {
          skipped = true;
          return x;
        }
        const { needsReauth: _gone, ...rest } = x;
        return {
          ...rest,
          tokens: {
            access,
            // no new refresh token: the old one stays
            refresh: str(body.refresh_token) ?? x.tokens.refresh,
            idToken: x.provider === 'codex' ? (str(body.id_token) ?? x.tokens.idToken) : x.tokens.idToken,
            expiresAt: expiresIn(at, body.expires_in),
          },
        };
      },
      { path: o.accountsPath },
    );
    return saved && !skipped ? { state: 'done', account: saved } : { state: 'unusable' };
  } catch {
    return { state: 'transient' };
  }
}
