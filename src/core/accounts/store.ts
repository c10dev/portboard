// Accounts (docs/accounts.md): the accounts added in the dashboard, kept in accounts.json (PATHS.accounts, 0600).
// This file holds the only copy of their tokens. Writes go through writePrivate (src/core/atomic.ts) and one promise
// chain, so two adds never interleave. A file that cannot be read is never overwritten.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
}

export type Loaded = { accounts: StoredAccount[] } | { error: typeof UNREADABLE };

export interface StoreOptions {
  path?: string;
  readFile?: (p: string) => Promise<string>;
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
  };
}

/** The added accounts. A missing file is an empty list; anything else that cannot be read is `accounts file unreadable`. */
export async function loadAccounts(o: StoreOptions = {}): Promise<Loaded> {
  const path = o.path ?? PATHS.accounts;
  let raw: string;
  try {
    raw = await (o.readFile ?? ((p: string) => readFile(p, 'utf8')))(path);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { accounts: [] } : { error: UNREADABLE };
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
  return { accounts };
}

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
    const loaded = await loadAccounts({ path, readFile: o.readFile });
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
    await writePrivate(path, () => `${JSON.stringify({ version: 1, accounts: list }, null, 2)}\n`);
    return next;
  };
  const job = chain.then(run, run);
  chain = job.catch(() => {});
  return job;
}
