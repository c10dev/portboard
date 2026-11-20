// Accounts (docs/accounts.md): the Claude Code and Codex logins on this machine, read from the two files the CLIs
// keep. Only the keys named below are read. The access token stays inside a LocalLogin (never in an answer):
// view.ts copies the allowed fields. Nothing here throws, and nothing is logged.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Internal record. Never send it out as it is: it holds the access token. */
export interface LocalLogin {
  provider: 'claude' | 'codex';
  id: string;
  status: 'ok' | 'none' | 'unreadable';
  email: string | null;
  plan: string | null;
  tier: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  /** codex: the ChatGPT-Account-Id request header. Not in any answer. */
  accountId: string | null;
  accessToken: string | null;
  error: string | null;
}

export interface DetectOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  readFile?: (p: string) => Promise<string>;
}

const UNREADABLE = 'credentials file unreadable';

/** The payload of a JWT as an object. The signature is not checked: the claims are for display only. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    if (typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const v: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** ms epoch; a value of 1e10 or less is seconds */
function epochMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e10 ? v : v * 1000;
}

const iso = (ms: number | null): string | null => {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

type Read = { kind: 'none' } | { kind: 'bad' } | { kind: 'json'; value: unknown };

async function readJson(path: string, read: (p: string) => Promise<string>): Promise<Read> {
  let raw: string;
  try {
    raw = await read(path);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { kind: 'none' } : { kind: 'bad' };
  }
  try {
    return { kind: 'json', value: JSON.parse(raw) };
  } catch {
    return { kind: 'bad' };
  }
}

function blank(provider: 'claude' | 'codex', status: 'none' | 'unreadable'): LocalLogin {
  return {
    provider,
    id: provider === 'claude' ? 'claude-local' : 'codex-local',
    status,
    email: null,
    plan: null,
    tier: null,
    expiresAt: null,
    refreshExpiresAt: null,
    accountId: null,
    accessToken: null,
    error: status === 'unreadable' ? UNREADABLE : null,
  };
}

async function detectClaude(o: Required<DetectOptions>): Promise<LocalLogin> {
  const dir = o.env.CLAUDE_CONFIG_DIR || join(o.home, '.claude');
  const r = await readJson(join(dir, '.credentials.json'), o.readFile);
  if (r.kind === 'none') return blank('claude', 'none');
  if (r.kind === 'bad' || !isObj(r.value) || !isObj(r.value.claudeAiOauth)) return blank('claude', 'unreadable');
  const c = r.value.claudeAiOauth;
  const accessToken = str(c.accessToken);
  const expires = epochMs(c.expiresAt);
  if (!accessToken || expires === null) return blank('claude', 'unreadable');
  const hasRefreshExp = c.refreshTokenExpiresAt !== undefined && c.refreshTokenExpiresAt !== null;
  if (hasRefreshExp && epochMs(c.refreshTokenExpiresAt) === null) return blank('claude', 'unreadable');
  return {
    provider: 'claude',
    id: 'claude-local',
    status: 'ok',
    email: null,
    plan: str(c.subscriptionType),
    tier: str(c.rateLimitTier),
    expiresAt: iso(expires),
    refreshExpiresAt: iso(epochMs(c.refreshTokenExpiresAt)),
    accountId: null,
    accessToken,
    error: null,
  };
}

/** A claim at the top level, else under a namespace the OpenAI token uses */
function claim(p: Record<string, unknown> | null, key: string, ns: string): string | null {
  if (!p) return null;
  const top = str(p[key]);
  if (top) return top;
  const inner = p[ns];
  return isObj(inner) ? str(inner[key]) : null;
}

const optionalString = (v: unknown) => v === undefined || v === null || typeof v === 'string';

async function detectCodex(o: Required<DetectOptions>): Promise<LocalLogin> {
  const dir = o.env.CODEX_HOME || join(o.home, '.codex');
  const r = await readJson(join(dir, 'auth.json'), o.readFile);
  if (r.kind === 'none') return blank('codex', 'none');
  if (r.kind === 'bad' || !isObj(r.value) || !isObj(r.value.tokens)) return blank('codex', 'unreadable');
  const tk = r.value.tokens;
  const accessToken = str(tk.access_token);
  if (!accessToken || !optionalString(tk.account_id) || !optionalString(tk.id_token)) return blank('codex', 'unreadable');
  const accountId = str(tk.account_id);
  // The id_token string is decoded and dropped: only claims leave this function.
  const idClaims = typeof tk.id_token === 'string' ? decodeJwtPayload(tk.id_token) : null;
  const accessClaims = decodeJwtPayload(accessToken);
  const pick = (key: string, ns: string) => claim(idClaims, key, ns) ?? claim(accessClaims, key, ns);
  const exp = accessClaims ? epochMs(accessClaims.exp) : null;
  return {
    provider: 'codex',
    id: accountId ? `codex-${createHash('sha256').update(accountId).digest('hex').slice(0, 12)}` : 'codex-local',
    status: 'ok',
    email: pick('email', 'https://api.openai.com/profile'),
    plan: pick('chatgpt_plan_type', 'https://api.openai.com/auth'),
    tier: null,
    expiresAt: iso(exp),
    refreshExpiresAt: null,
    accountId,
    accessToken,
    error: null,
  };
}

/** [claude, codex], always both. A missing file is `none`; a file that cannot be used is `unreadable`. */
export async function detectLogins(o: DetectOptions = {}): Promise<LocalLogin[]> {
  const full: Required<DetectOptions> = {
    home: o.home ?? homedir(),
    env: o.env ?? process.env,
    readFile: o.readFile ?? ((p) => readFile(p, 'utf8')),
  };
  return [await detectClaude(full), await detectCodex(full)];
}
