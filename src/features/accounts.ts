// AI subscription accounts, read-only (docs/accounts.md): the plan, expiry and remaining limits of the Claude Code and
// Codex logins on this machine.
//
//   GET /api/accounts   AccountsReport. Off unless portboard.json has accounts.enabled (404 "accounts disabled"), and
//                       the owner's only (403 "owner only", decided like the audit log's read).
//   MCP list_accounts   the same report, local stdio server only: no `remote`, so the remote server never offers it.
//
// The access tokens stay inside src/core/accounts/. The answer holds only the allowlisted fields (view.ts).

import { classify } from '../core/access.ts';
import { accountsReport } from '../core/accounts/view.ts';
import { SITE } from '../core/site.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

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
        return ok(await accountsReport(optionsFn()));
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_accounts',
        title: 'AI subscription accounts',
        description:
          'The Claude Code and Codex logins on this machine: plan, tier, email (Codex), when the access token expires and the ' +
          'remaining limits (used percent and reset time of the 5-hour and weekly windows). It reads the CLIs\' two login files ' +
          '(~/.claude/.credentials.json, ~/.codex/auth.json) and asks each vendor\'s unofficial usage endpoint (api.anthropic.com, ' +
          'chatgpt.com), cached for 5 minutes. It never refreshes a token and never returns a token. Read-only. When ' +
          'accounts.enabled is off in portboard.json it answers "accounts disabled" and reads nothing.',
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
