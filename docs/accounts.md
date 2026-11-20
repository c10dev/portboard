# Accounts

A read-only view of the Claude Code and Codex logins on the machine Portboard runs on: plan, email (Codex), when the access token expires, and the remaining limits (the 5-hour window and the weekly window). It is off by default, it is for the owner only, and no token leaves the Portboard process.

It never changes a login. It never refreshes a token, signs in, signs out or writes a file.

## Turn it on or off

Set it in `portboard.json` ([config.md](config.md)) and restart Portboard:

```json
{ "accounts": { "enabled": true } }
```

With `enabled` false or missing, `GET /api/accounts` answers `404 {error: "accounts disabled"}`, the MCP tool `list_accounts` answers "accounts disabled", and no login file is read. The Settings › Accounts section then says how to turn it on.

## What it reads

Two files, and only the keys named here. Everything else in them (refresh tokens, MCP logins, scopes, device tokens) is neither read nor kept.

| CLI | File | Keys |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json` | `claudeAiOauth.accessToken` (sent to the usage endpoint, kept in memory only), `expiresAt`, `refreshTokenExpiresAt`, `subscriptionType` (plan), `rateLimitTier` (tier) |
| Codex | `$CODEX_HOME/auth.json`, else `~/.codex/auth.json` | `tokens.access_token` (sent to the usage endpoint, kept in memory only), `tokens.account_id`, `tokens.id_token` (only its claims: email and plan; the signature is not checked) |

A missing file is "not signed in" (`none`) on Linux. A file that is not valid JSON, or lacks a needed key, is "can't read" (`unreadable`). Neither is an error for the page.

- A Codex `auth.json` with an API key (`OPENAI_API_KEY`) and no `tokens` is an API-key login, not a subscription login: it shows as `none`. The key is not read further.
- Off Linux, a missing file is `unreadable` with the error `login store not read on this platform`, because macOS keeps these logins in the Keychain, which Portboard does not read.
- A `refreshTokenExpiresAt` that is not a number is ignored; the login stays `ok`.

## Where it asks

Two read-only `GET` requests, one per signed-in CLI, to the hosts below. No other host is contacted.

| CLI | URL |
|---|---|
| Claude Code | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `https://chatgpt.com/backend-api/wham/usage` |

- An answer is reused for 5 minutes. The cache is per login: it is keyed by the provider and a hash of the access token (kept in memory only), so another login or a refreshed token never sees an earlier value.
- After any failure, a 401 or 403 included, nothing is sent for 5 minutes. Each further failure doubles the wait, up to 60 minutes; one success clears it. Meanwhile the last good answer is shown marked as stale. Simultaneous requests share one request.
- A 200 answer with no window Portboard knows counts as a failure (`quota response unusable`): it does not replace the last good answer.
- Text from an answer is cut: window names and plans at 40 characters, an email at 254, control characters removed.
- A request times out after 8 seconds, follows no redirect and reads at most 512 KiB.
- A token that has already expired is not sent. Portboard never refreshes one. An expired access token clears when you run the CLI once. When the refresh token has expired too (`needsReauth`), sign in again in the CLI.
- The URLs and request headers are in one block at the top of `src/core/accounts/quota.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit d61cca12 (MIT).

**These are not documented, supported APIs.** They are the endpoints the vendors' own CLIs use. They can change or stop working without notice, and a vendor may treat unusual use of them as a reason to limit an account. Turn the view on only if you accept that risk.

## Who can see it, and what leaves the process

- **Owner only.** `GET /api/accounts` uses the same owner check as the audit log: anyone else gets `403 {error: "owner only", reason}` before any file is read.
- **No remote MCP.** `list_accounts` is a local stdio tool. It is not in the remote server's tool list or in `RemoteCore`.
- **Allowlisted answer.** The answer holds `id`, `provider`, `source`, `email`, `plan`, `tier`, `status`, `expiresAt`, `needsReauth`, `quota` and `error`, each copied by name. It has no token, no account id and no id token.
- **No logs.** Tokens are not written to a log, the audit log or an error text. An error is one short fixed sentence (for example `quota request failed (HTTP 500)`).

See [security.md](security.md#accounts).

## Answer

```json
{
  "at": "2026-11-20T09:00:00.000Z",
  "accounts": [
    {
      "id": "claude-local", "provider": "claude", "source": "local-cli",
      "email": null, "plan": "max", "tier": "default_claude_max_5x",
      "status": "ok", "expiresAt": "2026-11-20T15:00:00.000Z", "needsReauth": false,
      "quota": {
        "windows": [
          { "name": "5h", "usedPct": 42.5, "resetsAt": "2026-11-20T12:00:00.000Z" },
          { "name": "weekly", "usedPct": 10, "resetsAt": "2026-11-25T00:00:00.000Z" }
        ],
        "fetchedAt": "2026-11-20T09:00:00.000Z", "stale": false
      },
      "error": null
    }
  ]
}
```

`status` is `ok`, `expired` (the token is past its expiry, or the vendor answered 401 or 403), `none` or `unreadable`. `needsReauth` is true when the refresh token has expired too. `usedPct` is 0 to 100; the remaining share is 100 minus it. `usedPct` or `resetsAt` is `null` for a window when the vendor sends no usable value.
