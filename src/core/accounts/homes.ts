// Accounts (docs/accounts.md): one folder per added Claude or Codex account, made when the owner chooses "use this
// account". The folder holds the CLI's own login file, so `CLAUDE_CONFIG_DIR=<folder> claude` or
// `CODEX_HOME=<folder> codex` starts that CLI as that account. Portboard never sets either variable itself and never
// touches ~/.claude or ~/.codex. Files go through writePrivate (0600, folder 0700). Once a folder exists, the file in it
// is the original of the tokens: the CLI refreshes it, and Portboard reads it back with the same parser as the CLI logins
// (detect.ts) and never refreshes that account. A use and a remove of the same account run one after the other (`inTurn`).

import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PATHS } from '../paths.ts';
import { writePrivate } from '../atomic.ts';
import { detectLogins, type DetectOptions, type LocalLogin } from './detect.ts';
import { LoginError, type LoginOptions } from './flows.ts';
import { pendingRefresh, refreshAccount } from './refresh.ts';
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
  | 'account home not written'
  | 'account home not removed'
  | 'local login cannot be used here';

const ACCOUNT_STATUS: Record<AccountErrorText, number> = {
  'account not found': 404,
  'local login cannot be removed': 400,
  'account cannot be used by the CLI': 400,
  'account needs sign-in again': 409,
  'account home not written': 500,
  'account home not removed': 500,
  'local login cannot be used here': 400,
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

const FILE_NAME = { claude: '.credentials.json', codex: 'auth.json' } as const;

/**
 * Does this account have a folder? Yes when "use" made it (`home`), and also when the login file is in the folder although
 * `home` was cleared (the account was added again): that file is the CLI's, so it is not refreshed or replaced behind its back.
 * Only ENOENT on the file means "no folder file". Any other error means "not known", and an account that may have a folder
 * is treated as one (it is not refreshed). The one place that decides it (the list, the refresh).
 */
export async function hasHome(a: Pick<StoredAccount, 'id' | 'provider' | 'home'>, o: { accountHomes?: string } = {}): Promise<boolean> {
  if (a.provider === 'copilot' || !HOME_ID.test(a.id)) return false;
  if (a.home) return true;
  try {
    return (await lstat(join(rootOf(o), a.id, FILE_NAME[a.provider]))).isFile();
  } catch (err) {
    return !isCode(err, 'ENOENT');
  }
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
      // the CLI's own keys, from the profile at sign-in: `plan` is a display value and is not written here
      ...(a.subscriptionType ? { subscriptionType: a.subscriptionType } : {}),
      ...(a.tier ? { rateLimitTier: a.tier } : {}),
    };
    return { name: FILE_NAME.claude, content: `${JSON.stringify({ claudeAiOauth: oauth }, null, 2)}\n` };
  }
  if (a.provider === 'codex') {
    if (!t.idToken) return null;
    const doc = {
      auth_mode: 'chatgpt',
      tokens: { id_token: t.idToken, access_token: t.access, refresh_token: t.refresh, account_id: a.identity },
      last_refresh: new Date(now).toISOString(),
    };
    return { name: FILE_NAME.codex, content: `${JSON.stringify(doc, null, 2)}\n` };
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
 * Delete the folder of an account. The protection is these three checks: the id matches `acc-` and 12 hex digits (so the
 * name has no separator and no `..`), `lstat` says the path is a real folder and not a link or a file, and `fs.rm` does
 * not follow a link when it deletes. A folder that is not there is fine. Anything else is not deleted and throws
 * `account home not removed`.
 */
export async function removeHome(id: string, root: string): Promise<void> {
  const fail = () => new AccountError('account home not removed');
  if (!HOME_ID.test(id)) throw fail();
  const path = join(root, id);
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return;
    throw fail();
  }
  try {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a folder');
    await rm(path, { recursive: true });
  } catch {
    throw fail();
  }
}

const unreadable = () => new LoginError(UNREADABLE);

/** The last use or remove of each account that has not finished yet: the next one for the same id starts after it */
const turns = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier use or remove of this id has finished (whether it worked or not). Other ids do not wait. */
function inTurn<T>(id: unknown, fn: () => Promise<T>): Promise<T> {
  if (typeof id !== 'string') return fn();
  const job = (turns.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  turns.set(id, job);
  const clear = () => {
    if (turns.get(id) === job) turns.delete(id);
  };
  job.then(clear, clear);
  return job;
}

/** The stored record of a valid id; otherwise an error with a closed text */
async function find(id: unknown, o: HomesOptions, what: 'use' | 'remove'): Promise<StoredAccount> {
  if (typeof id !== 'string' || !(HOME_ID.test(id) || LOCAL_ID.test(id))) throw new LoginError('invalid login request');
  if (LOCAL_ID.test(id)) throw new AccountError(what === 'use' ? 'local login cannot be used here' : 'local login cannot be removed');
  const loaded = await loadAccounts({ path: o.accountsPath });
  if ('error' in loaded) throw unreadable();
  const a = loaded.accounts.find((x) => x.id === id);
  if (!a) throw new AccountError('account not found');
  return a;
}

/** Save a change to one account (inside the store's chain); the store's own errors become the closed texts */
async function change(id: string, o: HomesOptions, fn: Parameters<typeof updateAccount>[1]): Promise<StoredAccount | null> {
  try {
    return await updateAccount(id, fn, { path: o.accountsPath });
  } catch (err) {
    throw (err as Error | null)?.message === UNREADABLE ? unreadable() : new LoginError('accounts file not written');
  }
}

/**
 * "Use this account": the CLI login file in the account's own folder, the account marked active for its provider,
 * and the command that starts the CLI as it.
 * - A use and a remove of the same account run one after the other.
 * - A use waits for a refresh of the same account that is running, then reads the record again.
 * - An account that has no folder yet is refreshed first when its access token has expired. Its record gets `home: true`
 *   before the file is written, so a refresh that starts later stops; when the write fails, the mark is taken back.
 *   A refresh that was already running when the mark was saved puts its new tokens in the record only (refresh.ts), so the use
 *   waits for it once more and writes the latest record to the file. A record that is gone after the write loses its new folder.
 * - An account whose folder is marked is not written again: the file in it is the original, and the CLI may have
 *   refreshed it since. When that file is missing or unreadable the old copy in accounts.json is not written back (its
 *   refresh token may be spent): the account needs to sign in again.
 * Returns the record, the command and the login read back from the folder file (the list's rules).
 */
export function useAccount(id: unknown, o: HomesOptions = {}): Promise<{ account: StoredAccount; command: string; login: LocalLogin | null }> {
  return inTurn(id, () => useNow(id, o));
}

async function useNow(id: unknown, o: HomesOptions): Promise<{ account: StoredAccount; command: string; login: LocalLogin | null }> {
  let wrote = false;
  let a = await find(id, o, 'use');
  const running = pendingRefresh(a.id);
  if (running) {
    await running.catch(() => {});
    a = await find(id, o, 'use');
  }
  if (a.provider === 'copilot') throw new AccountError('account cannot be used by the CLI');
  if (a.needsReauth) throw new AccountError('account needs sign-in again');
  const now = (o.now ?? Date.now)();
  const root = rootOf(o);
  const command = homeCommand(a, { accountHomes: root });
  if (!command) throw new AccountError('account cannot be used by the CLI');
  if (a.home) {
    const l = await readHomeLogin(a, o);
    if (!l || l.status !== 'ok') {
      await change(a.id, o, (x) => ({ ...x, needsReauth: true }));
      throw new AccountError('account needs sign-in again');
    }
  } else {
    if (a.tokens.refresh && a.tokens.expiresAt !== null && Date.parse(a.tokens.expiresAt) < now) {
      const r = await refreshAccount(a.id, { ...o, forUse: true });
      if (r.state === 'reauth') throw new AccountError('account needs sign-in again');
      if (r.state === 'transient') throw new LoginError('login request failed', true);
      if (r.state === 'done') a = r.account;
    }
    if (!fileOf(a, now)) throw new AccountError('account cannot be used by the CLI');
    // the mark first (inside the store's chain), then the file; the record the mark returns is the latest
    let marked = await change(a.id, o, (x) => ({ ...x, home: true }));
    if (!marked) throw new AccountError('account not found');
    try {
      // a refresh that was already running when the mark was saved ends with new tokens in the record only: wait, then write the latest
      const late = pendingRefresh(a.id);
      if (late) {
        await late.catch(() => {});
        marked = await find(a.id, o, 'use');
      }
      const file = fileOf(marked, now);
      if (!file) throw new AccountError('account cannot be used by the CLI');
      await writeHome(marked, file, root);
      wrote = true;
    } catch (err) {
      await change(a.id, o, (x) => {
        const { home: _undo, ...rest } = x;
        return rest;
      }).catch(() => null);
      throw err;
    }
  }
  const saved = await change(a.id, o, (x, active) => {
    active[x.provider as 'claude' | 'codex'] = x.id;
    return { ...x, home: true };
  });
  if (!saved) {
    // the record is gone: the folder this use just wrote has no account
    if (wrote) await removeHome(a.id, root).catch(() => {});
    throw new AccountError('account not found');
  }
  return { account: saved, command, login: await readHomeLogin(saved, o) };
}

/**
 * Remove an added account: its folder first, then its record (and its active mark). The record goes only when the folder is
 * gone or was never there, so a folder that cannot be deleted safely leaves the account listed and the owner can try again.
 */
export function removeAccountById(id: unknown, o: HomesOptions = {}): Promise<void> {
  return inTurn(id, () => removeNow(id, o));
}

async function removeNow(id: unknown, o: HomesOptions): Promise<void> {
  const a = await find(id, o, 'remove');
  await removeHome(a.id, rootOf(o));
  try {
    await removeAccount(a.id, { path: o.accountsPath });
  } catch (err) {
    throw (err as Error | null)?.message === UNREADABLE ? unreadable() : new LoginError('accounts file not written');
  }
}
