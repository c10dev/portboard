# Accounts

A view of the Claude Code and Codex logins on the machine Portboard runs on, and of the accounts you add in Portboard: plan, email (Codex), when the access token expires, and the remaining limits (the 5-hour window and the weekly window). It is off by default, it is for the owner only, and no token leaves the Portboard process.

It never changes a CLI login: it does not touch `~/.claude` or `~/.codex`, never refreshes the token of a CLI login, and never signs a CLI in or out. It writes only Portboard's own `accounts.json`, the folders under `account-homes/` and, when the [proxy](#proxy) is on, `accounts-proxy.key`. It writes them only when the owner adds, uses, removes or (for an added account without a folder) refreshes an account, or turns the proxy on ([Add an account](#add-an-account), [Use an account](#use-an-account), [Remove an account](#remove-an-account), [Refresh](#refresh), [Proxy](#proxy)).

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
- A token that has already expired is not sent. Portboard never refreshes the token of a CLI login (an added account without a folder is refreshed: see [Refresh](#refresh)). An expired access token clears when you run the CLI once. When the refresh token has expired too (`needsReauth`), sign in again in the CLI.
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
- **The same account twice is one account.** Adding the same provider and identity again replaces the tokens and the shown values; the id, the date added and the name stay (unless you give a new name). If the account already has a folder with a login file in it, it stays a folder account: the file in the folder is still the original, so the list reads it and Portboard does not refresh the account. The next **Use this account** writes the new login over that file and keeps the old one as `.bak`.
- **A flow lives in memory only.** The PKCE verifier, the state, the device ids and the codes stay in the Portboard process for at most 10 minutes (Claude) or 15 minutes (device codes; a GitHub Copilot flow lives at most 15 minutes, even when the vendor offers more), at most three open flows per provider. Closing the Settings window cancels the flow, and a flow cancelled while the vendor is still answering is not saved. Every call to a login route first drops the flows that are past their life. A flow ends when it succeeds, fails, is denied, expires or is cancelled, and a Claude flow is used up by its first finish, whatever the outcome. A device-code poll that fails because of a network error, a timeout, a 5xx or a 429 *before the vendor's first answer* to that poll does not end the flow: it answers `pending` with a longer interval, and the next poll asks again. A failure after the vendor has answered ends the flow. The exception is a GitHub Copilot answer with a 5xx or a 429 status whose `error` is not `authorization_pending`, `slow_down`, `expired_token` or `access_denied`: that is the vendor failing, not an answer, and it counts as a failure before the first answer.
- **Limits.** A Claude or Codex added account asks for limits like a CLI login does (same requests, same cache and wait), with its stored access token. Copilot has no limits to show: it is listed with its status only, and no usage request is sent for it.
- **Tokens.** An added Claude or Codex account is refreshed when its access token has expired ([Refresh](#refresh)). To remove an account, use the button ([Remove an account](#remove-an-account)).
- The URLs, client ids and request headers of the three flows are in one block, `LOGIN_REQUESTS`, at the top of `src/core/accounts/flows.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit d61cca12 (MIT).

Like the usage requests, these sign-in requests use the vendors' public client ids for their own CLIs. They are not documented, supported ways to sign in, and a vendor may refuse or limit them.

## Use an account

For an added Claude or Codex account, **Use this account** makes a folder for it, `account-homes/<account id>/` in the config folder (`~/.config/portboard/account-homes/`; `PORTBOARD_ACCOUNT_HOMES` moves it), mode `0700`, and writes the CLI's own login file into it (mode `0600`, through `writePrivate`). Then it shows the command that starts the CLI as that account, with a copy button:

| Account | File in the folder | Command |
|---|---|---|
| Claude | `.credentials.json`: `{claudeAiOauth: {accessToken, refreshToken, expiresAt (ms), scopes, subscriptionType, rateLimitTier}}` | `CLAUDE_CONFIG_DIR='<folder>' claude` |
| ChatGPT / Codex | `auth.json`: `{auth_mode: "chatgpt", tokens: {id_token, access_token, refresh_token, account_id}, last_refresh}` | `CODEX_HOME='<folder>' codex` |

- **Nothing else changes.** `~/.claude`, `~/.codex`, the CLI processes that are running and the environment of Portboard stay as they are. Portboard never sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` itself and does not start or stop a CLI: you run the command in a terminal.
- **Not verified with a real CLI yet.** The file shapes follow the keys the CLI logins are read from (see [What it reads](#what-it-reads)) and the shapes opencodex accepts. Whether Claude Code is signed in by `.credentials.json` alone, with no other file in the folder, has not been checked by running it. The owner checks it once.
- **A file that is there is kept once.** Before a login file is written over another file, the old one is copied to `<name>.bak` in the same folder (mode `0600`). Only one `.bak` is kept.
- **The file in the folder is the original.** The CLI refreshes it. Using an account again does not write over the login file while the record has the folder mark (`home`); an account that was added again has no mark, so its next use replaces the file and keeps the old one as `.bak` (see above). The list (and the answer of **Use this account**) reads the folder's file with the same rules as a CLI login (limits, expiry). Portboard does not refresh an account that has a folder: refresh tokens turn over, so two refreshers would cut one of them off. A folder file that is missing or cannot be read shows as `unreadable`, and **Use this account** then answers `account needs sign-in again` and marks the account `needsReauth`: the old copy in `accounts.json` is not written back, because its refresh token may be spent. The `.bak` stays.
- **What the Claude file holds.** `claudeAiOauth` has `accessToken`, `refreshToken`, `expiresAt` and `scopes`; `subscriptionType` (`max`, `pro`: the profile's `organization_type` without `claude_`) and `rateLimitTier` (the profile's `organization.rate_limit_tier`) are written only when the sign-in stored them (an account added before that has neither key). The plan text shown in the list is not written there.
- **Use, remove and refresh do not race.** A use and a remove of the same account run one after the other, so no folder with tokens is left for a record that is gone (a use that finds its record gone after it wrote the folder deletes that folder). A use waits for a refresh of the same account that is running, then reads the record again. It saves the folder mark (`home`) before it writes the file, so a refresh that starts later stops. A refresh that was already running when the mark was saved keeps its new tokens in `accounts.json` only (its old refresh token is spent), and the use waits for it once more and writes the latest record to the file. When the file cannot be written, the mark is taken back. When that late refresh ends with the vendor refusing the refresh token (400 or 401), the use answers 409 `account needs sign-in again`, takes the folder mark back, saves `needsReauth` in the record and writes no folder file.
- **Active.** Choosing an account marks it `active` for its provider in `accounts.json` (`active: {claude?, codex?}`); one account per provider. Removing the active account clears the mark. The mark records the owner's choice. It does not say which login a running CLI uses.
- **Who cannot be used.** A GitHub Copilot account has no CLI and no folder. An account without a refresh token (or, for Codex, without an id token) cannot be used by the CLI: `account cannot be used by the CLI`. An account that needs to sign in again: `account needs sign-in again`.
- **The command holds a folder path** (the owner's answer only). It holds no token.

## Remove an account

**Remove** asks first. It deletes the account's folder first, then the account's record from `accounts.json` (and its `active` mark). The record goes only when the folder is gone or was never there, so a folder that cannot be deleted leaves the account listed and you can try again. Only an added account can be removed: a CLI login (`claude-local`, `codex-…`) is `local login cannot be removed`. The folder is deleted only when all of these hold: it is named `acc-` and 12 hex digits, and `lstat` says it is a real folder (not a link, not a file). The delete itself does not follow a link: a link inside the folder is deleted as a link, and what it points to stays. Otherwise the folder is left alone and the answer is `account home not removed`. Nothing outside `account-homes` is deleted.

## Refresh

Only an added Claude or Codex account **without a folder** is refreshed, and only with a refresh token:

- when the dashboard asks for limits and the access token has expired (never ahead of time); the MCP tool `list_accounts` is read-only and does not refresh;
- and when you choose **Use this account** for an account whose access token has expired.

| Account | Request |
|---|---|
| Claude | `POST` to the token URL of `LOGIN_REQUESTS.claude`, JSON `{grant_type: "refresh_token", client_id, refresh_token}`, the headers of `LOGIN_REQUESTS.claude.tokenHeaders()`. A new refresh token replaces the old one; with none, the old one stays |
| ChatGPT / Codex | `POST` to the token URL of `LOGIN_REQUESTS.codex`, JSON `{client_id, grant_type: "refresh_token", refresh_token}`, the headers of `LOGIN_REQUESTS.codex.jsonHeaders()`. A new id token replaces the old one |

- A refresh of one account runs once at a time: requests at the same moment share one. The record is read again before the request, and a token that has not expired is not refreshed.
- A refresh happens inside a dashboard read (`GET /api/accounts`), not in a write route, so it has no audit line. It does write `accounts.json`, also on an install where writes are refused (`PORTBOARD_READ_ONLY`): the router refuses `use` and `remove` there, but not this read.
- The vendor answers 400 or 401 (for example `invalid_grant`): the account gets `needsReauth` in `accounts.json` and is not asked again. The list shows "Sign in again"; add the account again to clear it.
- Any other failure (network, timeout, 5xx, 429, an answer without a token) is a transient failure: nothing is changed, and the dashboard waits 5 minutes before it asks again. Using the account asks at once.
- The request uses the same helper as the sign-in requests (timeout, body limit, no redirect, closed error texts). No URL, client id or header is defined for it apart from `LOGIN_REQUESTS`.

## Proxy

The proxy lets Claude Code use an added Claude account, and Codex an added ChatGPT/Codex account, through Portboard. It moves to the next added account of the same kind when one hits its limit. It is **off by default**. This is for the owner's own subscriptions on the owner's own machine.

> **Read this first.** The proxy sends Claude Code's requests to Anthropic, and Codex's requests to chatgpt.com, with the OAuth token of an account you added, instead of the sign-in of the CLI. Anthropic's and OpenAI's terms and its handling of subscription tokens outside its own apps can change, and a vendor may limit or close an account for use it does not expect. It is not an official, supported way to use a subscription. Turn it on only for accounts you own, and expect it to stop working without notice. The tests use a fake upstream: nothing here proves that Anthropic accepts these requests today.

Turn it on in `portboard.json` and restart Portboard ([config.md](config.md)). Both flags are needed:

```json
{ "accounts": { "enabled": true, "proxy": { "enabled": true, "port": 8795 } } }
```

`port` is a whole number from 1024 to 65535; anything else is 8795. A preview instance never opens the proxy, whatever the settings say.

- **Where it listens.** `127.0.0.1` only. The address is a constant in the code: no setting or variable changes it. Portboard never publishes the port with `tailscale serve`, and `expose_port` refuses it (`account proxy is loopback only`). A preview reads its own copy of `portboard.json`, made once, so it also refuses the port in its own settings and the default 8795, whatever its flags say. It opens in the dashboard process, from the job `accounts-proxy` (every minute: open, close or reopen to match the settings); the stdio MCP server never opens it. A port that is in use leaves the state `port in use` and the next run tries again; Portboard does not stop.
- **The key.** The first time the proxy is on, Portboard makes `accounts-proxy.key` in the config folder (`pbp-` and 32 hex digits, mode `0600`; `PORTBOARD_ACCOUNTS_PROXY_KEY` moves it). A key file that other users can read, or that is not a key, is not read and the state is `error`. The job reads the file again every minute with the same rules: a file that has become loose or odd closes the listener (`error`), and an edited key applies within one run. **Change key** also works in the `error` state: it writes a new key and reopens the proxy at once. Settings › Accounts › Proxy has **Copy Claude command**, **Copy Codex command** and **Change key**. The key is in no answer except `POST /api/accounts/proxy/key`. The copy buttons ask for the key inside the click and gives the clipboard a promise of the text (`ClipboardItem`), which Safari and WKWebView need; it falls back to `writeText`. When the clipboard cannot be used, the page draws the same command with the key read from the key file (`ANTHROPIC_AUTH_TOKEN="$(cat '<key file>')"`, or `PORTBOARD_PROXY_KEY="$(cat '<key file>')"` for Codex) in a read-only field, so you can copy it by hand. The key itself is never drawn.
- **Start Claude Code through it.** **Copy Claude command** puts this on the clipboard (with your key and your port):

  ```sh
  ANTHROPIC_BASE_URL=http://127.0.0.1:8795 ANTHROPIC_AUTH_TOKEN=<key> claude
  ```
- **Start Codex through it.** **Copy Codex command** puts this on the clipboard (with your key and your port). It sets a `portboard` model provider with `-c`, so it does not change `~/.codex/config.toml`:

  ```sh
  PORTBOARD_PROXY_KEY=<key> codex -c 'model_provider="portboard"' -c 'model_providers.portboard={name="portboard",base_url="http://127.0.0.1:8795/codex",env_key="PORTBOARD_PROXY_KEY",wire_api="responses",http_headers={version="0.159.3"}}'
  ```

  Codex sends the key from `env_key` as `Authorization: Bearer <key>`. The provider has no `requires_openai_auth`, so Codex needs no ChatGPT sign-in for it. `0.159.3` is the Codex version whose source was read for this (the `version` header a built-in provider sends and a user provider does not); the command is written in `public/features/accounts.js`. The id and name `openai` are reserved by Codex, so the provider is `portboard`. Codex uses HTTP and SSE for a user provider unless `supports_websockets` is set, so there is no WebSocket path: an upgrade request is `404 not proxied`.

  A request carries the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. A missing or wrong key is `401`. A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, or that has an `Origin` header (a web page), is `403`. The key and the caller's cookies, `origin` and `referer` never go upstream.
- **What it sends on.** `POST /v1/messages` and `POST /v1/messages/count_tokens` to `https://api.anthropic.com` with the same path and query, and `POST /codex/responses` to `https://chatgpt.com/backend-api/codex/responses` with the same query. Everything else is `404 not proxied`, and the paths (no query, 80 characters, at most 20) are counted in `proxy.unproxied`, so you can see whether Claude Code calls anything else. The body goes on as the bytes it came in (at most 32 MiB, else `413`), and the answer streams back, SSE included. The headers are the client's, except: `authorization` is the account's token, `accept-encoding` is `identity`, `anthropic-beta` gets `oauth-2025-04-20` once, and `anthropic-version` is `2023-06-01` when the client sent none. `expect` is not sent. For Codex the headers are the client's too (`originator`, `session-id`, `x-codex-*`, `user-agent`, `version` go on), except: `authorization` is the account's access token, `chatgpt-account-id` is the account's id (the `account_id` of the login file for an account with a folder, else the id saved with the account), and `accept-encoding` is `identity`; none of the Claude headers is added. The request goes out through a small adapter over `node:https`, not `fetch`, which would add `accept`, `accept-language` and `sec-fetch-mode`: it sends exactly these headers, does not follow redirects, and ends when the client leaves. Portboard invents no other header. A client that disconnects ends the upstream request. The wait for upstream headers is 60 seconds; there is no limit on the stream. A network failure or that timeout is `502` and no other account is tried.
- **Which account.** Only added accounts of the request's provider: Claude accounts for the Claude paths, Codex accounts for the Codex path (never a CLI login or Copilot). The two providers are chosen apart. Order: the account that last answered well (`current.claude` or `current.codex`, memory only), then the account chosen with **Use this account**, then the order in `accounts.json`. Left out: an account that needs to sign in again, one that is resting, and one with no usable token. An account with a folder is read from the login file in its folder and must have a token that lasts more than 60 seconds (a Codex token with no `exp` claim has no known end and is used; a `401` rests it); it is never refreshed here (the CLI refreshes it, [Refresh](#refresh)). An account without a folder that expires within 60 seconds is refreshed first (once); if that fails it is left out for this request. A Codex account with no account id is left out. The proxy never changes which account is `active`.
- **When it switches.** Only on `429` with one of `anthropic-ratelimit-unified-status`, `anthropic-ratelimit-unified-5h-status` or `anthropic-ratelimit-unified-7d-status` equal to `rejected`: the shared limit is used up. A `429` with only `retry-after` is a short rate limit, and the account stays. `401` rests the account too. Every other answer (a `429` that does not switch, `403`, `5xx`, `529`) goes to the client as it is. A request uses at most four accounts (three switches). The same request body goes to the next account, and only before the first byte of an answer reaches the client. When no account is left, the last answer goes to the client as it is; when none could be asked, it is `503 no usable account`.
- **When Codex switches.** On `429` and on `402`; the body is not read. `401` rests the account like a Claude account. Every other answer goes to the client as it is. The count of accounts and the "last answer" rules are the same as above.
- **How long an account rests.** For a rejected Claude limit: `retry-after` (seconds), else the later of the `anthropic-ratelimit-unified-5h-reset` and `-7d-reset` of the windows that are `rejected` (epoch seconds) minus now, else 60 seconds. Zero or less is 60 seconds; more than 6 hours is 6 hours. For Codex: `retry-after` (seconds), else the later `x-codex-primary-reset-at` or `x-codex-secondary-reset-at` (epoch seconds) of the windows whose `-used-percent` is 100 or more, else the earlier of those two resets that is still ahead, else 60 seconds; the same bounds. A `401` rests the account for 10 minutes and does not set `needsReauth` (only the refresh path does). Resting marks and `current` are in memory: a restart clears them.
- **What it records.** The last 100 events in memory: `switch`, `rest`, `token expired` and `no usable account`, each with the time, the provider (`claude` or `codex`), the account ids, the status and the end of a rest. Settings › Accounts › Proxy shows the last 20 and which account rests or is in use. No token, key, header value, body or query string is in an event, a count, the console or an answer.

Error answers of the Codex path are `{"error":{"type":"proxy_error","code":"<text>","message":"<text>"}}` with the same closed texts as the Claude path (`proxy key required` 401, `not allowed` 403, `request too large` 413, `upstream request failed` 502, `no usable account` 503); `code` and `message` hold the same words. `404 not proxied` keeps one shape for both paths.

The URLs, the beta flag and the version header are in one block, `PROXY_REQUESTS`, in `src/core/accounts/proxy.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit 9e0e298e (MIT); no code is copied. The Codex side follows the source of Codex `rust-v0.159.3`, read on 2026-11-23.

Not checked with the real services: that Claude Code works with only these two paths, that Anthropic accepts a subscription token with `oauth-2025-04-20` for these requests, that a rejected limit sends the headers above, and what Claude Code does when `ANTHROPIC_AUTH_TOKEN` and a `~/.claude` login are both present.

Not checked for Codex (the tests use a fake upstream and a fake client; the real `codex` was not run): that `codex exec` works through the command above; that chatgpt.com accepts the request of a user provider (it has the `version` header from the command, and no `OpenAI-Beta`) and the body; whether Codex calls another path (for example `/codex/memories/trace_summarize`; any such call is counted in `proxy.unproxied`); and that a real limit answers `429` with `x-codex-*-used-percent: 100`.

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
| `invalid login request` | the request body is not what the route takes, or an id that is not `acc-` and 12 hex digits (HTTP 400) |
| `account not found` | no added account has that id (HTTP 404) |
| `local login cannot be removed` | the id is a CLI login (HTTP 400) |
| `account cannot be used by the CLI` | Copilot, or an account without the refresh or id token the CLI needs (HTTP 400) |
| `account needs sign-in again` | the vendor refused the refresh token, or the login file in the account's folder is missing or cannot be read (HTTP 409 for **Use this account**; in the list it is the error of an expired account that needs to sign in again) |
| `account home not written` | the account's folder or login file could not be written (HTTP 500) |
| `account home not removed` | the account's folder could not be deleted safely; the account stays listed (HTTP 500) |
| `local login cannot be used here` | `use` was called with the id of a CLI login (HTTP 400) |
| `accounts proxy disabled` | the proxy key route was called while the proxy is off (HTTP 404) |
| `proxy key unusable` | the key route could not read or write the key file, for example a file that other users can read (HTTP 500) |

## Who can see it, and what leaves the process

- **Owner only.** `GET /api/accounts` uses the same owner check as the audit log: anyone else gets `403 {error: "owner only", reason}` before any file is read. The seven write routes (the four sign-in routes, `use`, `remove` and the proxy key route) are `write: true`: the router refuses a caller who is not the owner, and a request without `X-Portboard: 1`, before the route's code runs.
- **No remote MCP.** `list_accounts` is a local stdio tool. It is not in the remote server's tool list or in `RemoteCore`. No MCP tool adds, uses or removes an account.
- **Allowlisted answer.** The answer holds `id`, `provider`, `source`, `alias`, `email`, `plan`, `tier`, `status`, `expiresAt`, `needsReauth`, `active`, `command`, `quota` and `error`, each copied by name. It has no token, no account id and no id token. The sign-in routes answer with the same view, never with the stored record.
- **No logs.** Tokens are not written to a log, the audit log or an error text. An error is one short fixed sentence (for example `quota request failed (HTTP 500)`). The audit line of a sign-in, use or remove request holds the names of the body keys (`flowId`, `code`, `provider`, `alias`, `id`, `rotate`) and none of their values, so a pasted code and an account id are never recorded.

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
  ],
  "proxy": {
    "enabled": true, "state": "listening", "port": 8795, "url": "http://127.0.0.1:8795",
    "current": { "claude": "acc-0123456789ab", "codex": null },
    "resting": [{ "id": "acc-ba9876543210", "until": "2026-11-20T12:00:00.000Z" }],
    "events": [
      { "at": "2026-11-20T09:00:00.000Z", "provider": "claude", "kind": "switch", "from": "acc-ba9876543210", "to": "acc-0123456789ab", "status": 429, "restUntil": null }
    ],
    "counts": { "requests": 12, "switches": 1 },
    "unproxied": [{ "path": "/v1/models", "count": 2 }]
  }
}
```

`source` is `local-cli` (a CLI login) or `added` (added in Portboard; `id` is `acc-` and 12 hex digits, `alias` is its name). `provider` is `claude`, `codex` or `copilot`. `status` is `ok`, `expired` (the token is past its expiry, or the vendor answered 401 or 403), `none` or `unreadable`. `needsReauth` is true when the refresh token has expired too, or the vendor refused it. `active` is true for the added account chosen with "use this account" for its provider (always false for a CLI login). `command` is the shell command that starts the CLI as an added account that has a folder, else `null`. `usedPct` is 0 to 100; the remaining share is 100 minus it. `usedPct` or `resetsAt` is `null` for a window when the vendor sends no usable value.

`proxy` is the [proxy](#proxy): `enabled` (both settings on, and not a preview), `state` (`off`, `listening`, `port in use`, `error`, or `unknown`), `port`, `url` (while listening), `current.claude` and `current.codex` (account ids, or `null`), `resting` (account ids and the end of the rest), `events` (newest first, at most 20) and `counts`. It holds no key and no token. The MCP tool `list_accounts` returns the same `proxy`; in the stdio MCP process, which never opens the proxy, `enabled` follows the settings and `state` is `unknown` while they are on (the dashboard's proxy may be listening; the counts and events in that answer are that process's own). Only requests that pass the `Host`, `Origin` and key checks raise `counts.requests`.

### Sign-in routes

All four are `POST`, owner only, need `X-Portboard: 1`, and answer `404 {error: "accounts disabled"}` while `accounts.enabled` is off. The body is JSON of at most 4 KiB.

| Route | Body | Answer |
|---|---|---|
| `/api/accounts/login/start` | `{provider: "claude" \| "codex" \| "copilot", alias?}` | `{flowId, provider, kind: "paste" \| "device", authorizeUrl?, userCode?, verificationUrl?, interval?, expiresAt}`. `authorizeUrl` (Claude) carries the PKCE challenge and the state, which the sign-in page needs; the verifier and the device ids are never in an answer |
| `/api/accounts/login/finish` | `{flowId, code}` (Claude) | `{account}`, one account as in the list |
| `/api/accounts/login/poll` | `{flowId}` (device codes) | `{state: "pending" \| "done" \| "expired" \| "denied" \| "failed", account?, error?, interval?}`. A poll sooner than `interval` after the last request gets `pending` and no vendor request. `interval` grows by 5 seconds after a `slow_down` |
| `/api/accounts/login/cancel` | `{flowId}` | `{ok: true}` |

### Use and remove routes

Both are `POST`, owner only, need `X-Portboard: 1`, and answer `404 {error: "accounts disabled"}` while `accounts.enabled` is off. The body is JSON of at most 4 KiB.

| Route | Body | Answer |
|---|---|---|
| `/api/accounts/use` | `{id}` | `{account, command}`: the account as in the list (`active: true`, `command`) and the command |
| `/api/accounts/remove` | `{id}` | `{ok: true}` |

### Proxy key route

`POST /api/accounts/proxy/key`: `write: true` (owner only, needs `X-Portboard: 1`), body JSON of at most 4 KiB, `{rotate?: boolean}`. It answers `{key, keyFile}` (the proxy key, made on first use, and the absolute path of the key file), and with `rotate: true` it first writes a new key, so the old one is `401` from then on. It answers `404 {error: "accounts proxy disabled"}` while the proxy is off, and `500 {error: "proxy key unusable"}` when the key file cannot be used. The audit line holds the key name `rotate` and no key.
