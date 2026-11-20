// Accounts (docs/accounts.md): the accounts added in the dashboard, kept in accounts.json (PATHS.accounts, 0600).
// This file holds the only copy of their tokens. Writes go through writePrivate (src/core/atomic.ts) and one promise
// chain, so two adds never interleave. A file that cannot be read is never overwritten.

import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PATHS } from '../paths.ts';
import { writePrivate } from '../atomic.ts';
import { clipOrNull, EMAIL_MAX, NAME_MAX, PLAN_MAX } from './clip.ts';

export const UNREADABLE = 'accounts file unreadable';

/** Internal record. Never send it out as it is: it holds the tokens and the identity. */
export interface StoredAccount {
  /** 'acc-' + 12 random hex */
  id: string;
  provider: 'claude' | 'codex' | 'copilot';
  /** clip 40 */
  alias: string | null;
  /** claude account.uuid, codex accountId, copilot GitHub user.id. Not in any answer. */
  identity: string;
  email: string | null;
  plan: string | null;
  /** ISO */
  addedAt: string;
  tokens: { access: string; refresh: string | null; idToken: string | null; expiresAt: string | null };
  /** the vendor refused the refresh token (400 or 401): the owner adds the account again */
  needsReauth?: boolean;
  /** "use this account" made the account's folder (src/core/accounts/homes.ts): the file in it is the original of the tokens */
  home?: boolean;
}

/** The account that is in use, per provider */
export type Active = { claude?: string; codex?: string };

export type Loaded = { accounts: StoredAccount[]; active: Active } | { error: typeof UNREADABLE };

export interface StoreOptions {
  path?: string;
  readFile?: (p: string) => Promise<string>;
  /** default fs stat; for tests */
  stat?: (p: string) => Promise<{ isFile(): boolean; mode: number }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** null for a missing value, the string, or undefined for any other type */
const strOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : typeof v === 'string' ? v : undefined);

/** One record from the file, or null when its shape is wrong (the whole file is then unreadable) */
function parseAccount(v: unknown): StoredAccount | null {
  if (!isObj(v) || !isObj(v.tokens)) return null;
  const { id, provider, identity, addedAt } = v;
  if (typeof id !== 'string' || !id || typeof identity !== 'string' || !identity || typeof addedAt !== 'string') return null;
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'copilot') return null;
  if (typeof v.tokens.access !== 'string' || !v.tokens.access) return null;
  const alias = strOrNull(v.alias);
  const email = strOrNull(v.email);
  const plan = strOrNull(v.plan);
  const refresh = strOrNull(v.tokens.refresh);
  const idToken = strOrNull(v.tokens.idToken);
  const expiresAt = strOrNull(v.tokens.expiresAt);
  const { needsReauth, home } = v;
  if ((needsReauth !== undefined && typeof needsReauth !== 'boolean') || (home !== undefined && typeof home !== 'boolean')) return null;
  if (alias === undefined || email === undefined || plan === undefined || refresh === undefined || idToken === undefined || expiresAt === undefined) return null;
  return {
    id,
    provider,
    alias: clipOrNull(alias, NAME_MAX),
    identity,
    email: clipOrNull(email, EMAIL_MAX),
    plan: clipOrNull(plan, PLAN_MAX),
    addedAt,
    tokens: { access: v.tokens.access, refresh, idToken, expiresAt },
    ...(needsReauth === true ? { needsReauth: true } : {}),
    ...(home === true ? { home: true } : {}),
  };
}

/** `active` of the file: absent is empty. A mark whose account is gone (the file was edited by hand) is dropped; a value that is not an object is a broken file (null). */
function parseActive(v: unknown, accounts: StoredAccount[]): Active | null {
  if (v === undefined) return {};
  if (!isObj(v)) return null;
  const out: Active = {};
  for (const k of ['claude', 'codex'] as const) {
    const id = v[k];
    if (typeof id === 'string' && accounts.some((a) => a.id === id && a.provider === k)) out[k] = id;
  }
  return out;
}

/**
 * The added accounts. A missing file is an empty list; anything else that cannot be read is `accounts file unreadable`.
 * That includes a file that is not a regular file, or that group or other users may read or write (mode & 0o077): a
 * file edited by hand keeps 0600, or Portboard leaves it alone.
 */
export async function loadAccounts(o: StoreOptions = {}): Promise<Loaded> {
  const path = o.path ?? PATHS.accounts;
  try {
    const st = await (o.stat ?? stat)(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return { error: UNREADABLE };
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { accounts: [], active: {} } : { error: UNREADABLE };
  }
  let raw: string;
  try {
    raw = await (o.readFile ?? ((p: string) => readFile(p, 'utf8')))(path);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { accounts: [], active: {} } : { error: UNREADABLE };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: UNREADABLE };
  }
  if (!isObj(doc) || doc.version !== 1 || !Array.isArray(doc.accounts)) return { error: UNREADABLE };
  const accounts: StoredAccount[] = [];
  for (const a of doc.accounts) {
    const p = parseAccount(a);
    if (!p) return { error: UNREADABLE };
    accounts.push(p);
  }
  const active = parseActive(doc.active, accounts);
  if (!active) return { error: UNREADABLE };
  return { accounts, active };
}

/** The text of the file. `active` is written only when it names an account. */
const serialize = (accounts: StoredAccount[], active: Active): string =>
  `${JSON.stringify({ version: 1, accounts, ...(active.claude || active.codex ? { active } : {}) }, null, 2)}\n`;

/** Adds run one after another: the read and the write of one add finish before the next add reads. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Add an account, or, for the same provider and identity, replace the tokens and the shown values of the record
 * that is there (its id and addedAt stay; so does its alias when none is given). Throws `accounts file unreadable`
 * and writes nothing when the file cannot be read.
 */
export function upsertAccount(a: Omit<StoredAccount, 'id' | 'addedAt'>, o: StoreOptions & { now?: () => number } = {}): Promise<StoredAccount> {
  const run = async (): Promise<StoredAccount> => {
    const path = o.path ?? PATHS.accounts;
    const loaded = await loadAccounts({ path, readFile: o.readFile, stat: o.stat });
    if ('error' in loaded) throw new Error(UNREADABLE);
    const list = loaded.accounts;
    const i = list.findIndex((x) => x.provider === a.provider && x.identity === a.identity);
    const next: StoredAccount =
      i >= 0
        ? { ...a, id: list[i].id, addedAt: list[i].addedAt, alias: a.alias ?? list[i].alias }
        : { ...a, id: `acc-${randomBytes(6).toString('hex')}`, addedAt: new Date((o.now ?? Date.now)()).toISOString() };
    next.alias = clipOrNull(next.alias, NAME_MAX);
    next.email = clipOrNull(next.email, EMAIL_MAX);
    next.plan = clipOrNull(next.plan, PLAN_MAX);
    if (i >= 0) list[i] = next;
    else list.push(next);
    await writePrivate(path, () => serialize(list, loaded.active));
    return next;
  };
  return enqueue(run);
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const job = chain.then(run, run);
  chain = job.catch(() => {});
  return job;
}

/**
 * Change one account inside the chain. `change` gets the record and the active marks and returns the new record, or
 * null to remove it (a removed account that was active is no longer). Returns the record after the change, or null
 * when there is no such account (nothing is written). Throws `accounts file unreadable` and writes nothing when the
 * file cannot be read.
 */
export function updateAccount(
  id: string,
  change: (a: StoredAccount, active: Active) => StoredAccount | null,
  o: StoreOptions = {},
): Promise<StoredAccount | null> {
  return enqueue(async () => {
    const path = o.path ?? PATHS.accounts;
    const loaded = await loadAccounts({ path, readFile: o.readFile, stat: o.stat });
    if ('error' in loaded) throw new Error(UNREADABLE);
    const i = loaded.accounts.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const active = { ...loaded.active };
    const next = change(loaded.accounts[i], active);
    if (next) loaded.accounts[i] = next;
    else {
      loaded.accounts.splice(i, 1);
      for (const k of ['claude', 'codex'] as const) if (active[k] === id) delete active[k];
    }
    await writePrivate(path, () => serialize(loaded.accounts, active));
    return next;
  });
}

/** Take an account out of accounts.json (and out of `active`). True when it was there. */
export async function removeAccount(id: string, o: StoreOptions = {}): Promise<boolean> {
  let found = false;
  await updateAccount(id, () => ((found = true), null), o);
  return found;
}
