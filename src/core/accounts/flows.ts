// Accounts (docs/accounts.md): the three ways to add an account. Claude: PKCE, the owner pastes the code the vendor
// shows. ChatGPT/Codex and GitHub Copilot: a device code the owner enters on the vendor's page. The server never polls
// by itself: the dashboard asks once per interval and a vendor is asked at most once per interval.
//
// A flow lives in memory only (a Map, a short life, three per provider). The PKCE verifier, the state, the device
// ids and every token stay inside this file and the store: a result carries only what the dashboard shows. An error
// is one of a closed set of short fixed texts with no response body, header, token or pasted text in it.

import { createHash, randomBytes } from 'node:crypto';
import { claim, decodeJwtPayload } from './detect.ts';
import { clip, clipOrNull, EMAIL_MAX, NAME_MAX, PLAN_MAX } from './clip.ts';
import { readLimited } from './quota.ts';
import { upsertAccount, UNREADABLE, type StoredAccount, type StoreOptions } from './store.ts';

// Every URL, client id and fixed header of a login lives in this block and nowhere else. The shapes follow opencodex
// commit d61cca12 (MIT): src/oauth/anthropic.ts, anthropic-identity.ts, chatgpt-device.ts, chatgpt-shared.ts and
// github-copilot.ts. No code is copied. A change is made here.
export const LOGIN_REQUESTS = {
  claude: {
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
    profileUrl: 'https://api.anthropic.com/api/oauth/profile',
    // opencodex src/oauth/anthropic.ts:11 stores this public client id base64-encoded
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference',
    tokenHeaders: (): Record<string, string> => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }),
    profileHeaders: (token: string): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'Cache-Control': 'no-cache',
      'User-Agent': 'claude-cli/2.1.321 (external, cli)',
    }),
  },
  codex: {
    userCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    verificationUrl: 'https://auth.openai.com/codex/device',
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    // opencodex sends only Content-Type on the three requests
    jsonHeaders: (): Record<string, string> => ({ 'Content-Type': 'application/json' }),
    formHeaders: (): Record<string, string> => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  },
  copilot: {
    deviceUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    clientId: 'Iv1.b507a08c87ecfe98',
    scope: 'read:user',
    verificationUrl: (userCode: string) => `https://github.com/login/device?user_code=${encodeURIComponent(userCode)}`,
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    formHeaders: (): Record<string, string> => ({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'portboard',
    }),
    userHeaders: (token: string): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portboard',
    }),
  },
};

export type Provider = 'claude' | 'codex' | 'copilot';

/** The closed set of error texts (the dashboard words each in its own language) */
export type LoginErrorText =
  | 'login state mismatch'
  | 'login flow expired'
  | 'login flow not found'
  | 'login denied'
  | `login request failed (HTTP ${number})`
  | 'login request failed'
  | 'login request timed out'
  | 'login response unusable'
  | 'accounts file unreadable'
  | 'accounts file not written'
  | 'too many login flows'
  | 'invalid login request';

const STATUS: [RegExp, number][] = [
  [/^login state mismatch$/, 400],
  [/^invalid login request$/, 400],
  [/^login flow not found$/, 404],
  [/^login flow expired$/, 410],
  [/^too many login flows$/, 429],
  [/^accounts file unreadable$/, 500],
  [/^accounts file not written$/, 500],
  [/^login denied$/, 400],
];

export class LoginError extends Error {
  readonly text: LoginErrorText;
  readonly status: number;
  /** a network error, a timeout, a 5xx or a 429: worth asking again (a device-code poll waits and tries once more) */
  readonly transient: boolean;
  constructor(text: LoginErrorText, transient = false) {
    super(text);
    this.transient = transient;
    this.text = text;
    this.status = STATUS.find(([re]) => re.test(text))?.[1] ?? 502;
  }
}

const CLAUDE_LIFE_MS = 10 * 60_000;
const DEVICE_LIFE_MS = 15 * 60_000;
const MAX_FLOWS = 3;
const MAX_BODY = 512 * 1024;
/** the longest user code taken from a vendor, as sent */
const USER_CODE_MAX = 64;
const MAX_EXPIRES_IN_S = 31_536_000;
const PROFILE_MAX_BODY = 64 * 1024;
export const TOKEN_TIMEOUT_MS = 30_000;
const PROFILE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 15 * 60;
const SLOW_DOWN_S = 5;

export interface LoginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** accounts.json (tests); default PATHS.accounts */
  accountsPath?: string;
}

interface Flow {
  /** the key in `flows`: set when the flow is opened */
  id: string;
  provider: Provider;
  kind: 'paste' | 'device';
  alias: string | null;
  expiresAt: number;
  /** claude */
  verifier?: string;
  state?: string;
  /** codex */
  deviceAuthId?: string;
  /** codex: the code exactly as the vendor sent it (sent back to the vendor as it is) */
  userCode?: string;
  /** codex and copilot: the cut, control-free text shown to the owner */
  shownCode?: string;
  /** copilot */
  deviceCode?: string;
  /** device flows: seconds between two vendor requests, and the earliest time the next one may go out */
  interval: number;
  nextPollAt: number;
  /** a vendor request for this flow is running */
  busy: boolean;
  /** device flows: true until the first vendor answer of a poll arrived (only a failure before it is retried) */
  asking: boolean;
}

const flows = new Map<string, Flow>();

/** For tests */
export function resetFlowsForTest(): void {
  flows.clear();
}

export interface StartResult {
  flowId: string;
  provider: Provider;
  kind: 'paste' | 'device';
  authorizeUrl?: string;
  userCode?: string;
  verificationUrl?: string;
  interval?: number;
  expiresAt: string;
}

export interface PollResult {
  state: 'pending' | 'done' | 'expired' | 'denied' | 'failed';
  account?: StoredAccount;
  error?: string;
  /** seconds until the next poll is useful (it grows after `slow_down`) */
  interval?: number;
}

// ---- small helpers ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const b64url = (b: Buffer) => b.toString('base64url');
const iso = (ms: number) => new Date(ms).toISOString();
const nowOf = (o: LoginOptions) => (o.now ?? Date.now)();

/** A number or a numeric string, else null */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** seconds from the vendor: a number above 0, else the default */
const seconds = (v: unknown, dflt: number): number => {
  const n = num(v);
  return n !== null && n > 0 ? n : dflt;
};

const intervalOf = (v: unknown): number => Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, seconds(v, DEFAULT_INTERVAL_S)));

const isTimeout = (err: unknown) => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
};

interface Answer {
  ok: boolean;
  status: number;
  /** the parsed JSON of a 2xx answer, else null */
  body: unknown;
}

/**
 * One vendor request. A network error or a timeout throws a LoginError. A body of a non-2xx answer is closed unread.
 * A 2xx body over `max` is `login response unusable`; a 2xx body that is not JSON is `body: null`.
 */
export async function vendor(
  o: LoginOptions,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; redirect: 'manual' | 'error'; timeoutMs: number; max?: number; bodyOnError?: boolean },
): Promise<Answer> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: init.redirect,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    throw new LoginError(isTimeout(err) ? 'login request timed out' : 'login request failed', true);
  }
  if (!res.ok && !init.bodyOnError) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, body: null };
  }
  let raw: string | null;
  try {
    raw = await readLimited(res, init.max ?? MAX_BODY);
  } catch (err) {
    throw new LoginError(isTimeout(err) ? 'login request timed out' : 'login request failed', true);
  }
  if (raw === null) {
    if (!res.ok) return { ok: false, status: res.status, body: null };
    throw new LoginError('login response unusable');
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // not JSON: null
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const failedHttp = (status: number): LoginError => new LoginError(`login request failed (HTTP ${status})`, status >= 500 || status === 429);

/** The body of a 2xx answer as an object; anything else is an error */
function objectOf(a: Answer): Record<string, unknown> {
  if (!a.ok) throw failedHttp(a.status);
  if (!isObj(a.body)) throw new LoginError('login response unusable');
  return a.body;
}

// ---- the flow table ----

/**
 * Flows past their life go, at the start of every call. The flow a call is about is kept for that call, which answers
 * `expired` for it (and drops it); the timing is the injected clock's.
 */
function sweep(now: number, keep?: unknown): void {
  for (const [id, f] of flows) if (f.expiresAt <= now && id !== keep) flows.delete(id);
}

function open(f: Omit<Flow, 'id'>, now: number): string {
  sweep(now);
  let n = 0;
  for (const x of flows.values()) if (x.provider === f.provider) n++;
  if (n >= MAX_FLOWS) throw new LoginError('too many login flows');
  const id = randomBytes(16).toString('hex');
  flows.set(id, { ...f, id });
  return id;
}

/** The flow is still the one in the table: not cancelled and not swept since the call began */
const alive = (f: Flow): boolean => flows.get(f.id) === f;

const aliasOf = (alias: unknown): string | null => (typeof alias === 'string' ? clipOrNull(alias.trim(), NAME_MAX) : null);

/** Start a flow. The result holds only what the owner needs to go on. */
export async function startLogin(provider: Provider, alias: unknown, o: LoginOptions = {}): Promise<StartResult> {
  const now = nowOf(o);
  sweep(now);
  if (provider === 'claude') return startClaude(aliasOf(alias), now);
  if (provider === 'codex') return startCodex(aliasOf(alias), now, o);
  if (provider === 'copilot') return startCopilot(aliasOf(alias), now, o);
  throw new LoginError('invalid login request');
}

function startClaude(alias: string | null, now: number): StartResult {
  const spec = LOGIN_REQUESTS.claude;
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const expiresAt = now + CLAUDE_LIFE_MS;
  const flowId = open({ provider: 'claude', kind: 'paste', alias, expiresAt, verifier, state, interval: 0, nextPollAt: 0, busy: false, asking: false }, now);
  const url = new URL(spec.authorizeUrl);
  url.search = new URLSearchParams({
    code: 'true',
    client_id: spec.clientId,
    response_type: 'code',
    redirect_uri: spec.redirectUri,
    scope: spec.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return { flowId, provider: 'claude', kind: 'paste', authorizeUrl: url.toString(), expiresAt: iso(expiresAt) };
}

async function startCodex(alias: string | null, now: number, o: LoginOptions): Promise<StartResult> {
  const spec = LOGIN_REQUESTS.codex;
  sweep(now);
  if ([...flows.values()].filter((f) => f.provider === 'codex').length >= MAX_FLOWS) throw new LoginError('too many login flows');
  const a = await vendor(o, spec.userCodeUrl, {
    method: 'POST',
    headers: spec.jsonHeaders(),
    body: JSON.stringify({ client_id: spec.clientId }),
    redirect: 'manual',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const body = objectOf(a);
  const deviceAuthId = str(body.device_auth_id);
  const userCode = str(body.user_code) ?? str(body.usercode);
  if (!deviceAuthId || !userCode || userCode.length > USER_CODE_MAX) throw new LoginError('login response unusable');
  const interval = intervalOf(body.interval);
  const at = nowOf(o);
  const expiresAt = at + DEVICE_LIFE_MS;
  const shown = clip(userCode, NAME_MAX);
  const flowId = open({ provider: 'codex', kind: 'device', alias, expiresAt, deviceAuthId, userCode, shownCode: shown, interval, nextPollAt: at + interval * 1000, busy: false, asking: false }, at);
  return { flowId, provider: 'codex', kind: 'device', userCode: shown, verificationUrl: spec.verificationUrl, interval, expiresAt: iso(expiresAt) };
}

async function startCopilot(alias: string | null, now: number, o: LoginOptions): Promise<StartResult> {
  const spec = LOGIN_REQUESTS.copilot;
  sweep(now);
  if ([...flows.values()].filter((f) => f.provider === 'copilot').length >= MAX_FLOWS) throw new LoginError('too many login flows');
  const a = await vendor(o, spec.deviceUrl, {
    method: 'POST',
    headers: spec.formHeaders(),
    body: form({ client_id: spec.clientId, scope: spec.scope }),
    redirect: 'manual',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const body = objectOf(a);
  const userCode = str(body.user_code);
  const deviceCode = str(body.device_code);
  if (!userCode || !deviceCode || userCode.length > USER_CODE_MAX) throw new LoginError('login response unusable');
  const interval = intervalOf(body.interval);
  const at = nowOf(o);
  const life = Math.min(seconds(body.expires_in, DEVICE_LIFE_MS / 1000), DEVICE_LIFE_MS / 1000) * 1000;
  const expiresAt = at + life;
  const shown = clip(userCode, NAME_MAX);
  const flowId = open({ provider: 'copilot', kind: 'device', alias, expiresAt, deviceCode, shownCode: shown, interval, nextPollAt: at + interval * 1000, busy: false, asking: false }, at);
  // the address is built here from the code: the answer's own address is not trusted
  return { flowId, provider: 'copilot', kind: 'device', userCode: shown, verificationUrl: spec.verificationUrl(userCode), interval, expiresAt: iso(expiresAt) };
}

// ---- Claude: finish ----

/** `code#state`, a full redirect URL, or a query (`code=…&state=…`; the fragment when the query has none) */
export function parsePasted(text: string): { code: string; state: string | null } | null {
  const s = text.trim();
  if (!s) return null;
  let params: URLSearchParams | null = null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const frag = new URLSearchParams(u.hash.replace(/^#/, ''));
      const code = u.searchParams.get('code') ?? frag.get('code');
      if (!code) return null;
      return { code, state: u.searchParams.get('state') ?? frag.get('state') };
    } catch {
      return null;
    }
  }
  if (/(^|[?&#])code=/.test(s)) {
    const [q, frag = ''] = s.replace(/^\?/, '').split('#');
    params = new URLSearchParams(q);
    const f = new URLSearchParams(frag);
    const code = params.get('code') ?? f.get('code');
    return code ? { code, state: params.get('state') ?? f.get('state') } : null;
  }
  const i = s.indexOf('#');
  const code = (i < 0 ? s : s.slice(0, i)).trim();
  const state = i < 0 ? '' : s.slice(i + 1).trim();
  return code ? { code, state: state || null } : null;
}

/** `expires_in` as an ISO time: a finite number above 0 and at most a year, else one hour */
export function expiresIn(now: number, v: unknown): string {
  const n = num(v);
  return iso(now + (n !== null && n > 0 && n <= MAX_EXPIRES_IN_S ? n : 3600) * 1000);
}

/** The plan and the account uuid from the profile answer; any failure is nulls (the account is added without a plan) */
async function claudeProfile(token: string, o: LoginOptions): Promise<{ plan: string | null; uuid: string | null; tier: string | null; subscriptionType: string | null }> {
  const none = { plan: null, uuid: null, tier: null, subscriptionType: null };
  try {
    const a = await vendor(o, LOGIN_REQUESTS.claude.profileUrl, {
      method: 'GET',
      headers: LOGIN_REQUESTS.claude.profileHeaders(token),
      redirect: 'error',
      timeoutMs: PROFILE_TIMEOUT_MS,
      max: PROFILE_MAX_BODY,
    });
    if (!a.ok || !isObj(a.body)) return none;
    const org = isObj(a.body.organization) ? a.body.organization : {};
    return {
      plan: clipOrNull(str(org.rate_limit_tier) ?? str(org.organization_type), PLAN_MAX),
      tier: clipOrNull(str(org.rate_limit_tier), PLAN_MAX),
      // `claude_max` is `max`, `claude_pro` is `pro`; any other value is none
      subscriptionType: clipOrNull(/^claude_([a-z0-9_]+)$/.exec(str(org.organization_type) ?? '')?.[1] ?? null, PLAN_MAX),
      uuid: isObj(a.body.account) ? str(a.body.account.uuid) : null,
    };
  } catch {
    return none;
  }
}

/** Finish a Claude flow with the text the owner pasted. The flow is used up whatever the outcome. */
export async function finishLogin(flowId: unknown, pasted: unknown, o: LoginOptions = {}): Promise<StoredAccount> {
  const now = nowOf(o);
  sweep(now, flowId);
  const f = typeof flowId === 'string' ? flows.get(flowId) : undefined;
  if (!f || f.kind !== 'paste' || f.busy) throw new LoginError('login flow not found');
  // used up whatever the outcome; until then it stays in the table so a cancel can still stop the save
  f.busy = true;
  try {
    return await finishFlow(f, pasted, now, o);
  } finally {
    flows.delete(f.id);
  }
}

async function finishFlow(f: Flow, pasted: unknown, now: number, o: LoginOptions): Promise<StoredAccount> {
  if (f.expiresAt <= now) throw new LoginError('login flow expired');
  if (typeof pasted !== 'string' || pasted.length > 4096) throw new LoginError('invalid login request');
  const p = parsePasted(pasted);
  if (!p) throw new LoginError('invalid login request');
  if (p.state !== null && p.state !== f.state) throw new LoginError('login state mismatch');
  const spec = LOGIN_REQUESTS.claude;
  const a = await vendor(o, spec.tokenUrl, {
    method: 'POST',
    headers: spec.tokenHeaders(),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: spec.clientId,
      code: p.code,
      state: f.state,
      redirect_uri: spec.redirectUri,
      code_verifier: f.verifier,
    }),
    redirect: 'manual',
    timeoutMs: TOKEN_TIMEOUT_MS,
  });
  const body = objectOf(a);
  const access = str(body.access_token);
  const account = isObj(body.account) ? body.account : {};
  if (!access) throw new LoginError('login response unusable');
  const profile = await claudeProfile(access, o);
  // the token answer's account first, the profile's when it has none
  const identity = str(account.uuid) ?? profile.uuid;
  if (!identity) throw new LoginError('login response unusable');
  return save(
    f,
    { provider: 'claude', alias: f.alias, identity, email: clipOrNull(str(account.email_address), EMAIL_MAX), plan: profile.plan, tier: profile.tier, subscriptionType: profile.subscriptionType, tokens: { access, refresh: str(body.refresh_token), idToken: null, expiresAt: expiresIn(nowOf(o), body.expires_in) } },
    o,
  );
}

/** Store the account, unless the flow was cancelled while the vendor answered. A read failure and a write failure have their own texts. */
async function save(f: Flow, a: Omit<StoredAccount, 'id' | 'addedAt'>, o: LoginOptions): Promise<StoredAccount> {
  if (!alive(f)) throw new LoginError('login flow not found');
  const store: StoreOptions & { now?: () => number } = { path: o.accountsPath, now: o.now };
  try {
    return await upsertAccount(a, store);
  } catch (err) {
    throw new LoginError((err as Error | null)?.message === UNREADABLE ? UNREADABLE : 'accounts file not written');
  }
}

// ---- device codes: poll ----

const done = (account: StoredAccount): PollResult => ({ state: 'done', account });

/** Ask once. Within the interval of the last request nothing is sent and the answer is `pending`. */
export async function pollLogin(flowId: unknown, o: LoginOptions = {}): Promise<PollResult> {
  const now = nowOf(o);
  sweep(now, flowId);
  const f = typeof flowId === 'string' ? flows.get(flowId) : undefined;
  if (!f || f.kind !== 'device') throw new LoginError('login flow not found');
  if (f.expiresAt <= now) {
    flows.delete(f.id);
    return { state: 'expired', error: 'login flow expired' };
  }
  if (f.busy || now < f.nextPollAt) return { state: 'pending', interval: f.interval };
  f.busy = true;
  f.asking = true;
  f.nextPollAt = now + f.interval * 1000;
  try {
    const r = f.provider === 'codex' ? await pollCodex(f, o) : await pollCopilot(f, o);
    if (r.state !== 'pending') flows.delete(f.id);
    else r.interval = f.interval;
    return r;
  } catch (err) {
    // cancelled while the vendor answered: nothing was saved, and the owner is told the flow is gone
    if (err instanceof LoginError && err.text === 'login flow not found') throw err;
    // a failure before the vendor answered, of a kind that passes: the flow stays and the next poll tries again
    if (err instanceof LoginError && err.transient && f.asking && alive(f)) {
      f.interval = Math.min(MAX_INTERVAL_S, f.interval + SLOW_DOWN_S);
      f.nextPollAt = nowOf(o) + f.interval * 1000;
      return { state: 'pending', interval: f.interval };
    }
    flows.delete(f.id);
    return { state: 'failed', error: err instanceof LoginError ? err.text : 'login request failed' };
  } finally {
    f.busy = false;
  }
}

async function pollCodex(f: Flow, o: LoginOptions): Promise<PollResult> {
  const spec = LOGIN_REQUESTS.codex;
  const a = await vendor(o, spec.pollUrl, {
    method: 'POST',
    headers: spec.jsonHeaders(),
    body: JSON.stringify({ device_auth_id: f.deviceAuthId, user_code: f.userCode }),
    redirect: 'manual',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!a.ok && (a.status === 403 || a.status === 404)) return { state: 'pending' };
  const grant = objectOf(a);
  f.asking = false;
  const code = str(grant.authorization_code);
  const verifier = str(grant.code_verifier);
  if (!code || !verifier) throw new LoginError('login response unusable');
  const t = await vendor(o, spec.tokenUrl, {
    method: 'POST',
    headers: spec.formHeaders(),
    body: form({ grant_type: 'authorization_code', client_id: spec.clientId, code, code_verifier: verifier, redirect_uri: spec.redirectUri }),
    redirect: 'manual',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const body = objectOf(t);
  const access = str(body.access_token);
  if (!access) throw new LoginError('login response unusable');
  const idToken = str(body.id_token);
  // the same claim rules as the CLI login file (detect.ts): the id token first, then the access token
  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accessClaims = decodeJwtPayload(access);
  const pick = (key: string, ns: string) => claim(idClaims, key, ns) ?? claim(accessClaims, key, ns);
  const orgs = idClaims?.organizations ?? accessClaims?.organizations;
  const orgId = Array.isArray(orgs) && isObj(orgs[0]) ? str(orgs[0].id) : null;
  const identity = pick('chatgpt_account_id', 'https://api.openai.com/auth') ?? orgId;
  if (!identity) throw new LoginError('login response unusable');
  const account = await save(
    f,
    {
      provider: 'codex',
      alias: f.alias,
      identity,
      email: clipOrNull(pick('email', 'https://api.openai.com/profile'), EMAIL_MAX),
      plan: clipOrNull(pick('chatgpt_plan_type', 'https://api.openai.com/auth'), PLAN_MAX),
      tokens: { access, refresh: str(body.refresh_token), idToken, expiresAt: expiresIn(nowOf(o), body.expires_in) },
    },
    o,
  );
  return done(account);
}

const POLL_CODES = ['authorization_pending', 'slow_down', 'expired_token', 'access_denied'];

async function pollCopilot(f: Flow, o: LoginOptions): Promise<PollResult> {
  const spec = LOGIN_REQUESTS.copilot;
  const a = await vendor(o, spec.tokenUrl, {
    method: 'POST',
    headers: spec.formHeaders(),
    body: form({ client_id: spec.clientId, device_code: f.deviceCode ?? '', grant_type: spec.grantType }),
    redirect: 'manual',
    timeoutMs: REQUEST_TIMEOUT_MS,
    bodyOnError: true,
  });
  // like opencodex: the body's `error` is read first, whatever the HTTP status (a pending answer may be a 400)
  const body = isObj(a.body) ? a.body : {};
  const access = a.ok ? str(body.access_token) : null;
  if (!access) {
    const code = str(body.error);
    if (code === null) {
      if (!a.ok) throw failedHttp(a.status);
      throw new LoginError('login response unusable');
    }
    // a 5xx or a 429 whose `error` is not one of the four codes is the vendor failing, not an answer to the poll: the flow stays
    if ((a.status >= 500 || a.status === 429) && !POLL_CODES.includes(code)) throw failedHttp(a.status);
    f.asking = false;
    switch (code) {
      case 'authorization_pending':
        return { state: 'pending' };
      case 'slow_down':
        f.interval = Math.min(MAX_INTERVAL_S, Math.max(f.interval + SLOW_DOWN_S, num(body.interval) ?? 0));
        f.nextPollAt = nowOf(o) + f.interval * 1000;
        return { state: 'pending' };
      case 'expired_token':
        return { state: 'expired', error: 'login flow expired' };
      case 'access_denied':
        return { state: 'denied', error: 'login denied' };
      default:
        throw new LoginError('login response unusable');
    }
  }
  f.asking = false;
  const u = objectOf(
    await vendor(o, spec.userUrl, { method: 'GET', headers: spec.userHeaders(access), redirect: 'error', timeoutMs: REQUEST_TIMEOUT_MS }),
  );
  const id = typeof u.id === 'number' && Number.isSafeInteger(u.id) ? String(u.id) : str(u.id);
  if (!id) throw new LoginError('login response unusable');
  const email = typeof u.email === 'string' && u.email.includes('@') ? clipOrNull(u.email, EMAIL_MAX) : null;
  const account = await save(
    f,
    { provider: 'copilot', alias: f.alias, identity: id, email, plan: null, tokens: { access, refresh: str(body.refresh_token), idToken: null, expiresAt: null } },
    o,
  );
  return done(account);
}

/** Drop a flow. True when there was one. */
export function cancelLogin(flowId: unknown, o: LoginOptions = {}): boolean {
  sweep(nowOf(o));
  return typeof flowId === 'string' && flows.delete(flowId);
}
