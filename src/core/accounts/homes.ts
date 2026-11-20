// Accounts (docs/accounts.md): one folder per added Claude or Codex account, made when the owner chooses "use this
// account". The folder holds the CLI's own login file, so `CLAUDE_CONFIG_DIR=<folder> claude` or
// `CODEX_HOME=<folder> codex` starts that CLI as that account. Portboard never sets either variable itself and never
// touches ~/.claude or ~/.codex. Files go through writePrivate (0600, folder 0700). Once a folder exists, the file in it
// is the original of the tokens: the CLI refreshes it, and Portboard reads it back with the same parser as the CLI logins
// (detect.ts) and never refreshes that account.

import { chmod, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PATHS } from '../paths.ts';
import { writePrivate } from '../atomic.ts';
import { detectLogins, type DetectOptions, type LocalLogin } from './detect.ts';
import { LoginError, type LoginOptions } from './flows.ts';
import { refreshAccount } from './refresh.ts';
import { loadAccounts, removeAccount, updateAccount, UNREADABLE, type StoredAccount } from './store.ts';

/** The id of an added account: `acc-` and 12 hex digits. Nothing else is a folder name. */
export const HOME_ID = /^acc-[0-9a-f]{12}$/;
/** The ids of the CLI logins read from ~/.claude and ~/.codex (detect.ts): they have no record to remove */
const LOCAL_ID = /^(claude-local|codex-local|codex-[0-9a-f]{12})$/;

export type AccountErrorText =
  | 'account not found'
  | 'local login cannot be removed'
  | 'account cannot be used by the CLI'
  | 'account needs sign-in again'
  | 'account home not written';

const ACCOUNT_STATUS: Record<AccountErrorText, number> = {
  'account not found': 404,
  'local login cannot be removed': 400,
  'account cannot be used by the CLI': 400,
  'account needs sign-in again': 409,
  'account home not written': 500,
};

/** One of the closed texts above: no path, token or response text in it */
export class AccountError extends Error {
  readonly text: AccountErrorText;
  readonly status: number;
  constructor(text: AccountErrorText) {
    super(text);
    this.text = text;
    this.status = ACCOUNT_STATUS[text];
  }
}

export interface HomesOptions extends LoginOptions, DetectOptions {
  /** the folder that holds the account folders (tests); default PATHS.accountHomes */
  accountHomes?: string;
}

const rootOf = (o: { accountHomes?: string }) => o.accountHomes ?? PATHS.accountHomes;
const isCode = (err: unknown, code: string) => (err as { code?: unknown } | null)?.code === code;

/** `'…'` with every quote inside closed and reopened: safe to paste into a POSIX shell */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that starts the CLI as this account; null for a provider with no CLI or an id that is not a folder name */
export function homeCommand(a: Pick<StoredAccount, 'id' | 'provider'>, o: { accountHomes?: string } = {}): string | null {
  if (!HOME_ID.test(a.id)) return null;
  const dir = shellQuote(join(rootOf(o), a.id));
  if (a.provider === 'claude') return `CLAUDE_CONFIG_DIR=${dir} claude`;
  if (a.provider === 'codex') return `CODEX_HOME=${dir} codex`;
  return null;
}

/** The CLI login of an account that has a folder, read with the parser of the CLI logins (detect.ts). Never throws. */
export async function readHomeLogin(a: StoredAccount, o: HomesOptions = {}): Promise<LocalLogin | null> {
  if (a.provider === 'copilot' || !HOME_ID.test(a.id)) return null;
  const dir = join(rootOf(o), a.id);
  // both variables point at this folder, so no read ever falls back to ~/.claude or ~/.codex
  const logins = await detectLogins({ home: o.home, env: { CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir }, readFile: o.readFile, platform: o.platform });
  return logins.find((l) => l.provider === a.provider) ?? null;
}

interface HomeFile {
  name: string;
  content: string;
}

/** The login file for the CLI, or null when the account lacks what the CLI needs */
function fileOf(a: StoredAccount, now: number): HomeFile | null {
  const t = a.tokens;
  if (!t.access || !t.refresh) return null;
  if (a.provider === 'claude') {
    const expires = t.expiresAt === null ? NaN : Date.parse(t.expiresAt);
    if (!Number.isFinite(expires)) return null;
    const oauth = {
      accessToken: t.access,
      refreshToken: t.refresh,
      expiresAt: expires,
      scopes: ['user:inference', 'user:profile'],
      ...(a.plan ? { subscriptionType: a.plan } : {}),
    };
    return { name: '.credentials.json', content: `${JSON.stringify({ claudeAiOauth: oauth }, null, 2)}\n` };
  }
  if (a.provider === 'codex') {
    if (!t.idToken) return null;
    const doc = {
      auth_mode: 'chatgpt',
      tokens: { id_token: t.idToken, access_token: t.access, refresh_token: t.refresh, account_id: a.identity },
      last_refresh: new Date(now).toISOString(),
    };
    return { name: 'auth.json', content: `${JSON.stringify(doc, null, 2)}\n` };
  }
  return null;
}

/** Make the folder (0700) and write the login file (0600). A file that is there is kept once, as `<name>.bak`. */
async function writeHome(a: StoredAccount, file: HomeFile, root: string): Promise<void> {
  try {
    if ((await mkdir(root, { recursive: true, mode: 0o700 })) !== undefined) await chmod(root, 0o700);
    const dir = join(root, a.id);
    const st = await lstat(dir).catch((err: unknown) => {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    });
    // a link or a file where the folder belongs is never followed
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error('not a folder');
    if (!st) await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, file.name);
    const old = await lstat(path).catch((err: unknown) => {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    });
    if (old) {
      if (old.isSymbolicLink() || !old.isFile()) throw new Error('not a file');
      await writePrivate(`${path}.bak`, await readFile(path, 'utf8'));
    }
    await writePrivate(path, file.content);
  } catch {
    throw new AccountError('account home not written');
  }
}

/**
 * Delete the folder of an account. It goes only when it is a real folder (not a link), named like an account id,
 * directly under the account-homes folder (checked with realpath, so a link in between does not count).
 * A folder that is not there is fine. Anything else is not deleted and throws `account home not written`.
 */
export async function removeHome(id: string, root: string): Promise<void> {
  if (!HOME_ID.test(id)) throw new AccountError('account home not written');
  const path = join(root, id);
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return;
    throw new AccountError('account home not written');
  }
  try {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a folder');
    if ((await realpath(dirname(path))) !== (await realpath(root))) throw new Error('not under the root');
    await rm(path, { recursive: true });
  } catch {
    throw new AccountError('account home not written');
  }
}

const unreadable = () => new LoginError(UNREADABLE);

/** The stored record of a valid id; otherwise an error with a closed text */
async function find(id: unknown, o: HomesOptions): Promise<StoredAccount> {
  if (typeof id !== 'string' || !(HOME_ID.test(id) || LOCAL_ID.test(id))) throw new LoginError('invalid login request');
  const loaded = await loadAccounts({ path: o.accountsPath });
  if ('error' in loaded) throw unreadable();
  const a = loaded.accounts.find((x) => x.id === id);
  if (!a) throw new AccountError(LOCAL_ID.test(id) ? 'local login cannot be removed' : 'account not found');
  return a;
}

/**
 * "Use this account": the CLI login file in the account's own folder, the account marked active for its provider,
 * and the command that starts the CLI as it. An account that has no folder yet is refreshed first when its access
 * token has expired. An account whose folder already holds a readable login is not written again: that file is the
 * original, and the CLI may have refreshed it since.
 */
export async function useAccount(id: unknown, o: HomesOptions = {}): Promise<{ account: StoredAccount; command: string }> {
  let a = await find(id, o);
  if (a.provider === 'copilot') throw new AccountError('account cannot be used by the CLI');
  if (a.needsReauth) throw new AccountError('account needs sign-in again');
  const now = (o.now ?? Date.now)();
  const root = rootOf(o);
  const command = homeCommand(a, { accountHomes: root });
  if (!command) throw new AccountError('account cannot be used by the CLI');
  const existing = a.home ? await readHomeLogin(a, o) : null;
  if (!existing || existing.status !== 'ok') {
    if (!a.home && a.tokens.refresh && a.tokens.expiresAt !== null && Date.parse(a.tokens.expiresAt) < now) {
      const r = await refreshAccount(a.id, o);
      if (r.state === 'reauth') throw new AccountError('account needs sign-in again');
      if (r.state === 'transient') throw new LoginError('login request failed', true);
      if (r.state === 'done') a = r.account;
    }
    const file = fileOf(a, now);
    if (!file) throw new AccountError('account cannot be used by the CLI');
    await writeHome(a, file, root);
  }
  let saved: StoredAccount | null;
  try {
    saved = await updateAccount(
      a.id,
      (x, active) => {
        active[x.provider as 'claude' | 'codex'] = x.id;
        return { ...x, home: true };
      },
      { path: o.accountsPath },
    );
  } catch (err) {
    throw (err as Error | null)?.message === UNREADABLE ? unreadable() : new LoginError('accounts file not written');
  }
  if (!saved) throw new AccountError('account not found');
  return { account: saved, command };
}

/**
 * Remove an added account: its record (and its active mark) first, then its folder. When the folder cannot be deleted
 * safely, the record is gone all the same and the answer is `account home not written`.
 */
export async function removeAccountById(id: unknown, o: HomesOptions = {}): Promise<void> {
  const a = await find(id, o);
  try {
    await removeAccount(a.id, { path: o.accountsPath });
  } catch (err) {
    throw (err as Error | null)?.message === UNREADABLE ? unreadable() : new LoginError('accounts file not written');
  }
  await removeHome(a.id, rootOf(o));
}
