# Accounts

A view of the Claude Code and Codex logins on the machine Portboard runs on, and of the accounts you add in Portboard: plan, email (Codex), when the access token expires, and the remaining limits (the 5-hour window and the weekly window). It is off by default, it is for the owner only, and no token leaves the Portboard process.

It never changes a CLI login: it does not touch `~/.claude` or `~/.codex`, never refreshes a token, and never signs a CLI in or out. The only file it writes is Portboard's own `accounts.json`, and only when the owner adds an account ([Add an account](#add-an-account)).

## Turn it on or off

Set it in `portboard.json` ([config.md](config.md)) and restart Portboard:

```json
{ "accounts": { "enabled": true } }
```

With `enabled` false or missing, `GET /api/accounts` answers `404 {error: "accounts disabled"}`, the MCP tool `list_accounts` answers "accounts disabled", and no login file is read. The Settings › Accounts section then says how to turn it on.

## What it reads

Two files, and only the keys named here. Everything else in them (refresh tokens, MCP logins, scopes, device tokens) is not used and not kept: each file is parsed as a whole JSON document, and the values of the keys named here are the only ones copied out.

| CLI | File | Keys |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json` | `claudeAiOauth.accessToken` (sent to the usage endpoint, kept in memory only), `expiresAt`, `refreshTokenExpiresAt`, `subscriptionType` (plan), `rateLimitTier` (tier) |
| Codex | `$CODEX_HOME/auth.json`, else `~/.codex/auth.json` | `tokens.access_token` (sent to the usage endpoint, kept in memory only), `tokens.account_id`, `tokens.id_token` (only its claims: email and plan; the signature is not checked) |

A missing file is "not signed in" (`none`) on Linux. A file that is not valid JSON, or lacks a needed key, is "can't read" (`unreadable`). Neither is an error for the page.

- A Codex `auth.json` with an API key (`OPENAI_API_KEY`) and no `tokens` is an API-key login, not a subscription login: it shows as `none`. The key is not read further.
- Off Linux, a missing file is `unreadable` with the error `login store not read on this platform`, because macOS keeps these logins in the Keychain, which Portboard does not read. This text is one of the fixed errors (see [Errors](#errors)).
- A `refreshTokenExpiresAt` that is not a number is ignored; the login stays `ok`.

## Where it asks

One read-only `GET` per Claude or Codex login (a signed-in CLI, or an added account), to the hosts below. Copilot accounts send none. No other host is contacted for limits. Adding an account sends sign-in requests to other hosts, listed under [Add an account](#add-an-account).

| CLI | URL |
|---|---|
| Claude Code | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `https://chatgpt.com/backend-api/wham/usage` |

- An answer is reused for 5 minutes. The cache is per login: it is keyed by the provider and a hash of the access token (kept in memory only), so another login or a refreshed token never sees an earlier value. An entry that was not used for 24 hours is dropped at the next request, and the cache holds at most 64 entries (before a new one is added, the least recently used are dropped until 63 are left).
- The cache and the failure wait are per process. The dashboard is one process; each Claude Code session starts its own stdio MCP server, which is another. Each has its own cache and its own wait, so two processes can each send a request in the same minute.
- After any failure, a 401 or 403 included, nothing is sent for 5 minutes. Each further failure doubles the wait, up to 60 minutes; one success clears it. Meanwhile the last good answer is shown marked as stale. Simultaneous requests share one request.
- A 200 answer with no window Portboard knows counts as a failure (`quota response unusable`): it does not replace the last good answer.
- Text from outside is cut before it is kept, whether it comes from an answer or from a login file: window names, plans and tiers are cut at 40 characters, an email at 254. Control characters are removed, and a cut string ends with `…`. A name you give an added account is cut at 40 characters the same way.
- A request times out after 8 seconds, follows no redirect and reads at most 512 KiB.
- A token that has already expired is not sent. Portboard never refreshes one. An expired access token clears when you run the CLI once. When the refresh token has expired too (`needsReauth`), sign in again in the CLI.
- The URLs and request headers are in one block at the top of `src/core/accounts/quota.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit d61cca12 (MIT).

**These are not documented, supported APIs.** They are the endpoints the vendors' own CLIs use. They can change or stop working without notice, and a vendor may treat unusual use of them as a reason to limit an account. Turn the view on only if you accept that risk.

## Add an account

In Settings › Accounts, the owner can add a Claude, a ChatGPT/Codex or a GitHub Copilot account. An added account shows in the same list as the CLI logins, with the mark "Added here" and its name. It works only while `accounts.enabled` is on, and a browser that may not write sees the buttons disabled.

| Account | Steps |
|---|---|
| Claude | Portboard makes a PKCE sign-in link. You open it, sign in, and paste the code the page shows (`code#state`, or the whole redirect URL) back into Portboard. Portboard exchanges it for tokens and reads the plan from the profile |
| ChatGPT / Codex | Portboard asks OpenAI for a device code and shows it with the verification page. You enter the code there. Portboard asks once per interval (5 seconds unless the vendor says more) until you are done |
| GitHub Copilot | The same, with GitHub's device code. Portboard builds the verification address itself from the code. Afterwards it reads your GitHub user id (and the email, when there is one) |

- **Where it asks.** Claude: `claude.ai` (the sign-in page, opened in your browser), `api.anthropic.com` (token exchange and profile). ChatGPT/Codex: `auth.openai.com` only. Copilot: `github.com` and `api.github.com`. No other host.
- **Where it keeps the tokens.** In `accounts.json` in the config folder (`~/.config/portboard/accounts.json`; a preview has its own config folder; `PORTBOARD_ACCOUNTS` moves it), mode `0600`, written through an atomic private write. It holds the access token, the refresh token, the id token (Codex), the identity (Claude account uuid, Codex account id, GitHub user id), the name, the email and the plan. Nothing else has a copy.
- **A broken file is never overwritten.** If `accounts.json` is not valid, is not a regular file, or can be read or written by group or other users (any `0o077` mode bit), adding fails with `accounts file unreadable`, the file stays as it was, and the list shows one line, "added-unreadable", instead of the added accounts. If you edit the file by hand, keep it at 0600 (`chmod 600`), or Portboard will not read it.
- **A write that fails** (a read-only folder, a full disk) fails with `accounts file not written`, and no account is added.
- **The same account twice is one account.** Adding the same provider and identity again replaces the tokens and the shown values; the id, the date added and the name stay (unless you give a new name).
- **A flow lives in memory only.** The PKCE verifier, the state, the device ids and the codes stay in the Portboard process for at most 10 minutes (Claude) or 15 minutes (device codes), at most three open flows per provider. Closing the Settings window cancels the flow, and a flow cancelled while the vendor is still answering is not saved. Every call to a login route first drops the flows that are past their life. A flow ends when it succeeds, fails, is denied, expires or is cancelled, and a Claude flow is used up by its first finish, whatever the outcome. A device-code poll that fails because of a network error, a timeout, a 5xx or a 429 does not end the flow: it answers `pending` with a longer interval, and the next poll asks again.
- **Limits.** A Claude or Codex added account asks for limits like a CLI login does (same requests, same cache and wait), with its stored access token. Copilot has no limits to show: it is listed with its status only, and no usage request is sent for it.
- **Tokens are not refreshed.** The access token of an added account is used as it is. After a few hours it expires, and the account shows `expired` ("access token expired"). Refreshing is a later milestone. Until then, add the account again to get a new token.
- **Removing one.** There is no remove button yet. Edit `accounts.json` by hand: delete the account's record from `accounts`, keeping the file valid JSON. Portboard reads the file on every request, so no restart is needed.
- The URLs, client ids and request headers of the three flows are in one block, `LOGIN_REQUESTS`, at the top of `src/core/accounts/flows.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit d61cca12 (MIT).

Like the usage requests, these sign-in requests use the vendors' public client ids for their own CLIs. They are not documented, supported ways to sign in, and a vendor may refuse or limit them.

## Errors

An error is one of these fixed sentences. None holds a response body, a header, a token or the text you pasted.

| Text | When |
|---|---|
| `credentials file unreadable` | a CLI login file is not valid or lacks a needed key |
| `login store not read on this platform` | off Linux, a CLI login file is missing (the login may be in the Keychain, which Portboard does not read) |
| `quota request refused (HTTP n)`, `quota request failed (HTTP n)`, `quota request failed`, `quota rate limited`, `quota request timed out`, `quota response too large`, `quota response unusable`, `access token expired` | a usage request |
| `accounts file unreadable` | `accounts.json` is not valid, is not a regular file, or is readable or writable by group or others (adding fails; the list shows one line) |
| `accounts file not written` | `accounts.json` could not be written (adding fails; nothing was saved) |
| `login state mismatch` | the pasted code belongs to another sign-in (HTTP 400) |
| `login flow expired`, `login flow not found` | the flow ran out of time, or is not open (HTTP 410, 404) |
| `login denied` | you denied the sign-in on the vendor's page |
| `login request failed (HTTP n)`, `login request failed`, `login request timed out`, `login response unusable` | a sign-in request failed, was not answered in time, or was answered with something Portboard cannot use (HTTP 502) |
| `too many login flows` | three flows of that provider are already open (HTTP 429) |
| `invalid login request` | the request body is not what the route takes (HTTP 400) |

## Who can see it, and what leaves the process

- **Owner only.** `GET /api/accounts` uses the same owner check as the audit log: anyone else gets `403 {error: "owner only", reason}` before any file is read. The four sign-in routes are write routes: the router refuses a caller who is not the owner, and a request without `X-Portboard: 1`, before the route's code runs.
- **No remote MCP.** `list_accounts` is a local stdio tool. It is not in the remote server's tool list or in `RemoteCore`. No MCP tool adds an account.
- **Allowlisted answer.** The answer holds `id`, `provider`, `source`, `alias`, `email`, `plan`, `tier`, `status`, `expiresAt`, `needsReauth`, `quota` and `error`, each copied by name. It has no token, no account id and no id token. The sign-in routes answer with the same view, never with the stored record.
- **No logs.** Tokens are not written to a log, the audit log or an error text. An error is one short fixed sentence (for example `quota request failed (HTTP 500)`). The audit line of a sign-in request holds the names of the body keys (`flowId`, `code`, `provider`, `alias`) and none of their values, so a pasted code is never recorded.

See [security.md](security.md#accounts).

## Answer

```json
{
  "at": "2026-11-20T09:00:00.000Z",
  "accounts": [
    {
      "id": "claude-local", "provider": "claude", "source": "local-cli", "alias": null,
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

`source` is `local-cli` (a CLI login) or `added` (added in Portboard; `id` is `acc-` and 12 hex digits, `alias` is its name). `provider` is `claude`, `codex` or `copilot`. `status` is `ok`, `expired` (the token is past its expiry, or the vendor answered 401 or 403), `none` or `unreadable`. `needsReauth` is true when the refresh token has expired too. `usedPct` is 0 to 100; the remaining share is 100 minus it. `usedPct` or `resetsAt` is `null` for a window when the vendor sends no usable value.

### Sign-in routes

All four are `POST`, owner only, need `X-Portboard: 1`, and answer `404 {error: "accounts disabled"}` while `accounts.enabled` is off. The body is JSON of at most 4 KiB.

| Route | Body | Answer |
|---|---|---|
| `/api/accounts/login/start` | `{provider: "claude" \| "codex" \| "copilot", alias?}` | `{flowId, provider, kind: "paste" \| "device", authorizeUrl?, userCode?, verificationUrl?, interval?, expiresAt}`. `authorizeUrl` (Claude) carries the PKCE challenge and the state, which the sign-in page needs; the verifier and the device ids are never in an answer |
| `/api/accounts/login/finish` | `{flowId, code}` (Claude) | `{account}`, one account as in the list |
| `/api/accounts/login/poll` | `{flowId}` (device codes) | `{state: "pending" \| "done" \| "expired" \| "denied" \| "failed", account?, error?, interval?}`. A poll sooner than `interval` after the last request gets `pending` and no vendor request. `interval` grows by 5 seconds after a `slow_down` |
| `/api/accounts/login/cancel` | `{flowId}` | `{ok: true}` |
