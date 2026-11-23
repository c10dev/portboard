// AI subscription accounts (docs/accounts.md): the plan, expiry and remaining limits of the Claude Code and Codex
// logins on this machine, and of the accounts the owner added here (Claude, ChatGPT/Codex, GitHub Copilot).
//
//   GET /api/accounts               AccountsReport. Off unless portboard.json has accounts.enabled (404 "accounts
//                                   disabled"), and the owner's only (403 "owner only", decided like the audit log's read).
//   POST /api/accounts/login/start  {provider, alias?} → the flow's id and what the owner does next
//   POST /api/accounts/login/finish {flowId, code}     (Claude) → {account}
//   POST /api/accounts/login/poll   {flowId}           (device code) → {state, account?, error?, interval?}
//   POST /api/accounts/login/cancel {flowId}           → {ok: true}
//   POST /api/accounts/use          {id} → {account, command}: the account's own CLI folder and the command that starts the CLI as it
//   POST /api/accounts/remove       {id} → {ok: true}: the record and the folder Portboard made for it
//   POST /api/accounts/proxy/key    {rotate?} → {key, keyFile}: the proxy key (404 "accounts proxy disabled" when the proxy is off)
//   MCP list_accounts               the same report, local stdio server only: no `remote`, so the remote server never
//                                   offers it. There is no MCP tool that adds an account.
//
// Job accounts-proxy (dashboard process only, preview never): every minute it makes the loopback account pool proxy match
// the settings (accounts.enabled and accounts.proxy.enabled, src/core/accounts/proxy.ts) and closes it on shutdown. The proxy
// sends Claude Code's POST /v1/messages (and /count_tokens) to Anthropic and Codex's POST /codex/responses to chatgpt.com, each
// with the token of one added account of that provider.
//
// The seven POST routes are `write: true`: the router checks X-Portboard and the owner, and writes the audit line, before
// a handler runs. Their body keys (flowId, code, provider, alias, id, rotate) are not in the audit log's ID_KEYS, so the line holds
// the key names and never the pasted code. The tokens stay inside src/core/accounts/. An answer holds only the
// allowlisted fields (view.ts), never a StoredAccount.

import { classify } from '../core/access.ts';
import { cancelLogin, finishLogin, LoginError, pollLogin, startLogin, type Provider } from '../core/accounts/flows.ts';
import { AccountError, removeAccountById, useAccount } from '../core/accounts/homes.ts';
import { accountsProxy, proxyConfig, type ProxyConfig } from '../core/accounts/proxy.ts';
import { accountsReport, addedView, homeView } from '../core/accounts/view.ts';
import { SITE } from '../core/site.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Reply } from './types.ts';

type ReportOptions = NonNullable<Parameters<typeof accountsReport>[0]>;

let enabledFn: () => boolean = () => SITE.accounts.enabled;
let optionsFn: () => ReportOptions = () => ({});

/** For tests: replace the accounts.enabled check */
export function setAccountsEnabledForTest(fn: (() => boolean) | null): void {
  enabledFn = fn ?? (() => SITE.accounts.enabled);
}

/** For tests: replace what accountsReport gets (home, env, readFile, fetch, now) */
export function setAccountsOptionsForTest(fn: (() => ReportOptions) | null): void {
  optionsFn = fn ?? (() => ({}));
}

/** What the login flows get: the same fetch, clock and file as the report (tests) */
function loginOptions() {
  const o = optionsFn();
  return { fetch: o.fetch, now: o.now, accountsPath: o.accountsPath };
}

/** The proxy this process drives: the one the report options name (tests), else the process's own */
const proxyOf = () => optionsFn().proxy ?? accountsProxy;

/** The proxy's settings, and nothing while accounts are off */
const proxySettings = (): ProxyConfig => (enabledFn() ? proxyConfig() : { ...proxyConfig(), enabled: false });

/** What "use" and "remove" get: the whole report options, as they read the account's folder the way the report does */
const homesOptions = () => optionsFn();

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot'];
const failed = (err: unknown): Reply => {
  if (err instanceof LoginError || err instanceof AccountError) return reply(err.status, { error: err.text });
  // not one of ours: the text stays out of the answer and the audit line (it could hold a token or a path)
  return reply(502, { error: 'login request failed' });
};

export const accountsFeature: FeatureModule = {
  name: 'accounts',
  order: 2575,
  routes: [
    {
      method: 'GET',
      path: '/api/accounts',
      async handler({ req }, ctx) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        // The same owner decision as the audit log's read: plan, email and limits are the owner's business.
        const c = classify(req, await ctx.owner(), await ctx.policy());
        if (!c.owner) return reply(403, { error: 'owner only', reason: c.reason ?? '' });
        return ok(await accountsReport({ ...optionsFn(), refresh: true }));
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/login/start',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        const provider = (body as { provider?: unknown } | null)?.provider;
        if (typeof provider !== 'string' || !PROVIDERS.includes(provider as Provider)) return failed(new LoginError('invalid login request'));
        try {
          return ok(await startLogin(provider as Provider, (body as { alias?: unknown }).alias, loginOptions()));
        } catch (err) {
          return failed(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/login/finish',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        const b = (body ?? {}) as { flowId?: unknown; code?: unknown };
        try {
          const o = loginOptions();
          const a = await finishLogin(b.flowId, b.code, o);
          return ok({ account: addedView(a, null, (o.now ?? Date.now)()) });
        } catch (err) {
          return failed(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/login/poll',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        try {
          const o = loginOptions();
          const r = await pollLogin((body as { flowId?: unknown } | null)?.flowId, o);
          const { account, ...rest } = r;
          return ok(account ? { ...rest, account: addedView(account, null, (o.now ?? Date.now)()) } : rest);
        } catch (err) {
          return failed(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/login/cancel',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        cancelLogin((body as { flowId?: unknown } | null)?.flowId, loginOptions());
        return ok({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/use',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        try {
          const o = homesOptions();
          const r = await useAccount((body as { id?: unknown } | null)?.id, o);
          // the same rules as the list: read back from the folder file
          return ok({ account: homeView(r.account, r.login, null, (o.now ?? Date.now)(), { active: true, command: r.command }), command: r.command });
        } catch (err) {
          return failed(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/remove',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn()) return reply(404, { error: 'accounts disabled' });
        try {
          await removeAccountById((body as { id?: unknown } | null)?.id, homesOptions());
          return ok({ ok: true });
        } catch (err) {
          return failed(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/proxy/key',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (!enabledFn() || !proxySettings().enabled) return reply(404, { error: 'accounts proxy disabled' });
        try {
          const rotate = (body as { rotate?: unknown } | null)?.rotate === true;
          const key = await proxyOf().key(rotate);
          // a proxy stuck in `error` on a bad key file opens at once with the new key
          if (rotate) await proxyOf().sync(proxySettings());
          // the path is for the owner's own machine, like `command` of /api/accounts/use: the page shows a command that reads the key from it
          return ok({ key, keyFile: proxyOf().keyFile() });
        } catch {
          return reply(500, { error: 'proxy key unusable' });
        }
      },
    },
  ],
  jobs: [
    {
      name: 'accounts-proxy',
      everyMs: 60_000,
      runAtStart: true,
      enabled: (paths) => paths.profile !== 'preview',
      run: () => proxyOf().sync(proxySettings()),
    },
  ],
  shutdown: () => proxyOf().close(),
  tools: [
    {
      def: {
        name: 'list_accounts',
        title: 'AI subscription accounts',
        description:
          'The Claude Code and Codex logins on this machine, and the Claude, Codex and GitHub Copilot accounts the owner added in ' +
          'the dashboard (source "added", with their alias): plan, tier, email (Codex), when the access token expires and the ' +
          'remaining limits (used percent and reset time of the 5-hour and weekly windows; none for Copilot). It reads the CLIs\' ' +
          'two login files (~/.claude/.credentials.json, ~/.codex/auth.json) and Portboard\'s own accounts file, and asks each ' +
          'vendor\'s unofficial usage endpoint (api.anthropic.com, chatgpt.com), cached for 5 minutes. It never refreshes a ' +
          'token (only the dashboard does that, for an added account with no folder) and never returns a token. The answer also has `proxy` (the account pool proxy: enabled, state, port, current account ids (`current.claude`, `current.codex`), resting account ids, last events, counts; never a key; state is `unknown` in this process while the settings are on). Each added account also says whether it is `active` and, once the owner chose "use this account" ' +
          'in the dashboard, the `command` that starts its CLI in its own folder. Read-only: it cannot add, use or remove an account. When accounts.enabled is off in ' +
          'portboard.json it answers "accounts disabled" and reads nothing.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async call() {
        if (!enabledFn()) return text('accounts disabled', true);
        return text(await accountsReport(optionsFn()));
      },
    },
  ],
  ui: [{ pages: ['#settings'], script: 'features/accounts.js' }],
};
