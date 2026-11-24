# Accounts

A view of the Claude Code and Codex logins on the machine Portboard runs on, and of the accounts you add in Portboard: plan, email (Codex), when the access token expires, and the remaining limits (the 5-hour window and the weekly window). It is off by default, it is for the owner only, and no token leaves the Portboard process.

It never changes a CLI login: it does not touch `~/.claude` or `~/.codex`, never refreshes the token of a CLI login, and never signs a CLI in or out. It writes only Portboard's own `accounts.json`, the folders under `account-homes/` and, when the [proxy](#proxy) is on, `accounts-proxy.key`, `accounts-lanes.json` (the [Settings](#settings) of the two lanes) and `accounts-usage.jsonl` (the [usage log](#usage-log)). It writes the first three only when the owner adds, uses, removes or (for an added account without a folder) refreshes an account, or turns the proxy on, the lanes file only when the owner changes a switch or the model mapping in Settings, and the usage log each time the proxy sends a request on ([Add an account](#add-an-account), [Use an account](#use-an-account), [Remove an account](#remove-an-account), [Refresh](#refresh), [Proxy](#proxy)).

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

> **Read this first.** The proxy sends Claude Code's requests to Anthropic, and Codex's requests to chatgpt.com, with the OAuth token of an account you added, instead of the sign-in of the CLI. Anthropic's and OpenAI's terms and its handling of subscription tokens outside its own apps can change, and a vendor may limit or close an account for use it does not expect. It is not an official, supported way to use a subscription. Turn it on only for accounts you own, and expect it to stop working without notice. The tests use a fake upstream: nothing here proves that Anthropic or chatgpt.com accepts these requests today.

Turn it on in `portboard.json` and restart Portboard ([config.md](config.md)). Both flags are needed:

```json
{ "accounts": { "enabled": true, "proxy": { "enabled": true, "port": 8795 } } }
```

`port` is a whole number from 1024 to 65535; anything else is 8795. A preview instance never opens the proxy, whatever the settings say.

- **Where it listens.** `127.0.0.1` only. The address is a constant in the code: no setting or variable changes it. Portboard never publishes the port with `tailscale serve`, and `expose_port` refuses it (`account proxy is loopback only`). A preview reads its own copy of `portboard.json`, made once, so it also refuses the port in its own settings and the default 8795, whatever its flags say. It opens in the dashboard process, from the job `accounts-proxy` (every minute: open, close or reopen to match the settings); the stdio MCP server never opens it. A port that is in use leaves the state `port in use` and the next run tries again; Portboard does not stop.
- **The key.** The first time the proxy is on, Portboard makes `accounts-proxy.key` in the config folder (`pbp-` and 32 hex digits, mode `0600`; `PORTBOARD_ACCOUNTS_PROXY_KEY` moves it). A key file that other users can read, or that is not a key, is not read and the state is `error`. The job reads the file again every minute with the same rules: a file that has become loose or odd closes the listener (`error`), and an edited key applies within one run. **Change key** also works in the `error` state: it writes a new key and reopens the proxy at once. Settings › Accounts › Proxy has **Copy Claude command**, **Copy Codex command** and **Change key**. The key is in no answer except `POST /api/accounts/proxy/key`. The copy buttons ask for the key inside the click and give the clipboard a promise of the text (`ClipboardItem`), which Safari and WKWebView need; they fall back to `writeText`. When the clipboard cannot be used, the page draws the same command with the key read from the key file (`ANTHROPIC_AUTH_TOKEN="$(cat '<key file>')"`, or `PORTBOARD_PROXY_KEY="$(cat '<key file>')"` for Codex) in a read-only field, so you can copy it by hand. The key itself is never drawn.
- **Start Claude Code through it.** **Copy Claude command** puts this on the clipboard (with your key and your port):

  ```sh
  ANTHROPIC_BASE_URL=http://127.0.0.1:8795 ANTHROPIC_AUTH_TOKEN=<key> claude
  ```

  In a session started this way, Claude Code does not load your claude.ai connectors (your organization's MCP servers). At start it says that `ANTHROPIC_API_KEY` or another auth source is set and takes precedence over the claude.ai login. The copied command sets only `ANTHROPIC_AUTH_TOKEN`, so with that command it is the other source. Start Claude Code without the proxy when you need those connectors.
- **Start Codex through it.** **Copy Codex command** puts this on the clipboard (with your key and your port). It sets a `portboard` model provider with `-c`, so it does not change `~/.codex/config.toml`:

  ```sh
  PORTBOARD_PROXY_KEY=<key> codex -c 'model_provider="portboard"' -c 'model_providers.portboard={name="portboard",base_url="http://127.0.0.1:8795/codex",env_key="PORTBOARD_PROXY_KEY",wire_api="responses",http_headers={version="0.159.3"}}'
  ```

  Codex sends the key from `env_key` as `Authorization: Bearer <key>`. The provider has no `requires_openai_auth`, so Codex needs no ChatGPT sign-in for it. `0.159.3` is the Codex version whose source was read for this (the `version` header a built-in provider sends and a user provider does not); the command is written in `public/features/accounts.js`. The id and name `openai` are reserved by Codex, so the provider is `portboard`. Codex uses HTTP and SSE for a user provider unless `supports_websockets` is set, so there is no WebSocket path: an upgrade request is `404 not proxied`.

  A request carries the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. A missing or wrong key is `401`. A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, or that has an `Origin` header (a web page), is `403`. For the requests the proxy sends with an account's token (the Claude and Codex lanes and the GPT lane), the key and the caller's cookies, `origin` and `referer` never go upstream. A request relayed by the [desktop route](#desktop-route) goes to `api.anthropic.com` with the session's own headers, cookies included, minus the hop-by-hop and `proxy-*` headers.
- **What it sends on.** `POST /v1/messages` and `POST /v1/messages/count_tokens` to `https://api.anthropic.com` with the same path and query, and `POST /codex/responses` to `https://chatgpt.com/backend-api/codex/responses` with the same query. Everything else is `404 not proxied`, and the paths (no query, 80 characters, at most 20) are counted in `proxy.unproxied`, so you can see whether Claude Code or Codex calls anything else. The body goes on as the bytes it came in (at most 32 MiB, else `413`), and the answer streams back, SSE included. The headers are the client's, except: `authorization` is the account's token, `accept-encoding` is `identity`, `anthropic-beta` gets `oauth-2025-04-20` once, and `anthropic-version` is `2023-06-01` when the client sent none. `expect` is not sent. For Codex the headers are the client's too (`originator`, `session-id`, `x-codex-*`, `user-agent`, `version` go on), except: `authorization` is the account's access token, `chatgpt-account-id` is the account's id (the `account_id` of the login file for an account with a folder, else the id saved with the account; an account added without a `chatgpt_account_id` claim saved the first organization id as that id, which chatgpt.com may refuse, and a `403` is not a switch), and `accept-encoding` is `identity`; the client's `anthropic-beta` and `anthropic-version` are dropped, and none is added. The request goes out through a small adapter over `node:https`, not `fetch`, which would add `accept`, `accept-language` and `sec-fetch-mode`: it sends exactly these headers, does not follow redirects, and ends when the client leaves. Portboard invents no other header. A client that disconnects ends the upstream request. The wait for upstream headers is 60 seconds; there is no limit on the stream. A network failure or that timeout is `502` and no other account is tried. The one exception is the [GPT lane](#gpt-lane): a `/v1/messages` request for a model you listed is converted and sent to the Codex address. On that lane the body is not the bytes it came in, the headers are the lane's own short list and none of the client's, and the answer is converted back to the Anthropic shape. The header, byte and "as it is" statements of this section hold for every other request the proxy sends with an account's token. A request that the [desktop route](#desktop-route) relays keeps the session's own headers and login.
- **Which account.** Only added accounts of the request's provider: Claude accounts for the Claude paths, Codex accounts for the Codex path (never a CLI login or Copilot). The two providers are chosen apart. Order: the account that last answered well (`current.claude` or `current.codex`, memory only), then the account chosen with **Use this account**, then the order in `accounts.json`. Left out: an account that needs to sign in again, one that is resting, and one with no usable token. An account with a folder is read from the login file in its folder and must have a token that lasts more than 60 seconds (a Codex token with no `exp` claim has no known end and is used; a `401` rests it); it is never refreshed here (the CLI refreshes it, [Refresh](#refresh)). An account without a folder that expires within 60 seconds is refreshed first (once); if that fails it is left out for this request. A Codex account with no account id is left out. The proxy never changes which account is `active`.
- **When it switches.** Only on `429` with one of `anthropic-ratelimit-unified-status`, `anthropic-ratelimit-unified-5h-status` or `anthropic-ratelimit-unified-7d-status` equal to `rejected`: the shared limit is used up. A `429` with only `retry-after` is a short rate limit, and the account stays. `401` rests the account too. Every other answer (a `429` that does not switch, `403`, `5xx`, `529`) goes to the client as it is (on the GPT lane it is converted: see [GPT lane](#gpt-lane)). A request uses at most four accounts (three switches). The same request body goes to the next account, and only before the first byte of an answer reaches the client. When no account is left, the last answer goes to the client as it is; when none could be asked, it is `503 no usable account`.
- **When Codex switches.** On `429` and on `402`; the body is not read. `401` rests the account like a Claude account. Every other answer goes to the client as it is (the GPT lane uses the same switching, and converts the answer: see [GPT lane](#gpt-lane)). The count of accounts and the "last answer" rules are the same as above.
- **How long an account rests.** For a rejected Claude limit: `retry-after` (seconds), else the later of the `anthropic-ratelimit-unified-5h-reset` and `-7d-reset` of the windows that are `rejected` (epoch seconds) minus now, else 60 seconds. Zero or less is 60 seconds; more than 6 hours is 6 hours. For Codex: `retry-after` (seconds), else the later `x-codex-primary-reset-at` or `x-codex-secondary-reset-at` (epoch seconds) of the windows whose `-used-percent` is 100 or more, else the earlier of those two resets that is still ahead, else 60 seconds; the same bounds. A `401` rests the account for 10 minutes and does not set `needsReauth` (only the refresh path does). Resting marks and `current` are in memory: a restart clears them.
- **What it records.** The last 100 events in memory: `switch`, `rest`, `token expired` and `no usable account`, each with the time, the provider (`claude` or `codex`), the account ids, the status and the end of a rest. Settings › Accounts › Proxy shows the last 20 and which account rests or is in use. No token, key, header value, body or query string is in an event, a count, the console or an answer.

Error answers of the Codex path are `{"error":{"type":"proxy_error","code":"<text>","message":"<text>"}}` with the same closed texts as the Claude path (`proxy key required` 401, `not allowed` 403, `request too large` 413, `upstream request failed` 502, `no usable account` 503); `code` and `message` hold the same words. `404 not proxied` keeps one shape for both paths.

The URLs, the beta flag and the version header are in one block, `PROXY_REQUESTS`, in `src/core/accounts/proxy.ts`. Their shape follows [opencodex](https://github.com/lidge-jun/opencodex) commit 9e0e298e (MIT); no code is copied. The Codex side follows the source of Codex `rust-v0.159.3`, read on 2026-11-23.

Checked once with the real services on 2026-11-23: a Claude Code session started with **Copy Claude command** got its answer through the proxy with one added Claude account. `proxy.unproxied` stayed empty. The machine also had a `~/.claude` login (the list showed `claude-local` as `ok`). Claude Code sent the proxy key, because the proxy counts a request only after the key check. It printed the connectors warning (see above). Not checked yet: that a rejected limit sends the headers above and that the proxy then switches. That needs two added Claude accounts and a real used-up limit.

Checked once for Codex with the real services on 2026-11-23: a Codex session started with **Copy Codex command** got its answer through the proxy. It used one added ChatGPT/Codex account, which was marked active, so **Use this account** had made its folder. The proxy counted the request and set `current.codex` to that account. It sets `current` only when the answer status is below 400, and Codex showed the answer. So chatgpt.com accepted the request of the user provider. By the code above, that request had the `version` header from the command, no `OpenAI-Beta`, the account's `chatgpt-account-id`, and the client's body. `proxy.unproxied` stayed empty for that request. Before any Codex account was added, the proxy answered `503 no usable account`, and Codex retried it (`Reconnecting... 1/5`). The session was interactive. Not checked yet: that `codex exec` works through the command, and that a real limit answers `429` with `x-codex-*-used-percent: 100` and that the proxy then switches. That needs two added Codex accounts and a real used-up limit. Other paths, for example `/codex/memories/trace_summarize`, may still appear in longer sessions, and `proxy.unproxied` counts them.

### Settings

Settings › Accounts › Proxy has the controls of the two lanes, so you do not edit `portboard.json` or restart Portboard for them. They show only while the proxy is on and its state is known (the proxy itself, `accounts.enabled`, `accounts.proxy.enabled` and `accounts.proxy.port`, stays in `portboard.json` and needs a restart).

- **GPT lane** and **Desktop route** are switches. A change is written and applied at once. If it fails, the switch goes back and the page shows why.
- **Model mapping** lists the Claude names the GPT lane takes and the GPT model each one runs on, one row each (**Add**, **Remove**, **Save**). Save sends the non-empty rows and replaces the whole map. The page checks both patterns before it sends (a printable name of 1 to 128 characters, a model id as in [GPT lane](#gpt-lane)), and at most 32 rows. Claude Code takes a mapped name for a Claude model. The desktop model picker has no GPT entry, so map one Claude name there and pick it.
- **Copy desktop settings** puts the `env` block of the [desktop route](#desktop-route) on the clipboard, with your key and the path of the certificate (the same promise-of-text way as the other copy buttons). It is available while the proxy listens and the route is on. When the clipboard cannot be used, the page shows the same block with `KEY` in the key's place and names the key file. The key is never drawn. Put the block in `.claude/settings.local.json` in the working folder and reopen the session. The file holds the key: keep it readable by you only and do not commit it. Portboard writes no Claude settings file.
- **Unsaved rows.** The mapping rows you typed stay when the block is drawn again (after a switch or a refresh) until you press **Save**; the page says `Unsaved changes.` next to the buttons.
- **Activity** is one line: the requests the GPT lane converted, the authorized `CONNECT`s of the desktop route and how many connections are are open now, and the time of the last one. It is memory only and starts at zero when Portboard starts.

The settings are in `accounts-lanes.json` in the config folder (mode `0600`; `PORTBOARD_ACCOUNTS_LANES` moves it), written with the same private write as the other files:

```json
{"gpt":{"enabled":true,"models":{"claude-haiku-5-5":"gpt-6-astra"}},"desktop":{"enabled":false}}
```

Each top key is optional. A key in the file wins over `accounts.proxy.gpt` or `accounts.proxy.desktop` in `portboard.json`; a key the file lacks falls back to `portboard.json`. The values follow the same rules as in `portboard.json`. A file that group or others can read or write, that is not a regular file, or that is not JSON is not used: both keys fall back to `portboard.json`, and Settings shows a warning. The `accounts-proxy` job reads the file every minute, so an edit applies within a minute. The report's `proxy.lanes` says which file each value came from.

### GPT lane

The GPT lane lets Claude Code run on a GPT model. The proxy converts a Claude Code request (Anthropic Messages) to a Responses request, sends it to chatgpt.com with one added ChatGPT/Codex account, and converts the answer back. It is **off by default** and is part of the proxy: it needs `accounts.enabled` and `accounts.proxy.enabled` too. The switch and the model list are in Settings (see [Settings](#settings)); the example below is the `portboard.json` form, which Settings overrides.

```json
{ "accounts": { "enabled": true, "proxy": { "enabled": true, "port": 8795,
  "gpt": { "enabled": true, "models": { "claude-opus-5-5": "gpt-6-astra" } } } } }
```

- **Which requests.** Only `POST /v1/messages` and `POST /v1/messages/count_tokens` can take the lane. A request takes it when its `model` is a key of `gpt.models` (the value is the GPT model that is asked), or when it starts with `codex/` and the rest is a model id (`codex/gpt-6-astra` asks `gpt-6-astra`). Every other request keeps the pass-through of the Proxy section, byte for byte. `/codex/responses` is never converted. A body that is not JSON is not routed.
- **Settings.** `gpt.models` keeps at most 32 entries. A key is 1 to 128 printable ASCII characters without spaces. A value starts with a letter or digit and holds letters, digits, `.`, `_`, `:` and `-` (128 characters at most). Another entry is dropped.
- **Start.** `ANTHROPIC_BASE_URL=http://127.0.0.1:8795 ANTHROPIC_AUTH_TOKEN=<proxy key> claude --model codex/<id>`, or a model name you mapped. Claude Code prints an `unrecognized_model` warning for a name it does not know and goes on (seen 2026-11-24). The answer carries the model name the client sent. The desktop Code tab is not covered by this way: it forces its own `ANTHROPIC_BASE_URL`. See [Desktop route](#desktop-route).
- **Accounts.** The lane uses the added ChatGPT/Codex accounts and their limits, with the Codex rules of the Proxy section: `current.codex`, a switch on `429` and `402`, a rest on `401`, at most four accounts. `503 no usable account` is the answer only when no account could be asked. When every account that was asked answered a switch status, the last answer goes to the client, converted (for example `429 rate_limit_error`). Its events say `codex`.
- **Converted.** The `system` text becomes `instructions`. Messages become `input` items (text, images, PDF files, `tool_use` as `function_call`, `tool_result` as `function_call_output`, a `system` message as a `developer` message). Tools become `function` tools. `tool_choice`, `disable_parallel_tool_use` and `output_config.effort` (or `thinking`) become `tool_choice`, `parallel_tool_calls` and `reasoning.effort`. A tool name OpenAI does not accept (more than 64 characters or other characters) is shortened with a hash and mapped back in the answer. The session id (see Prompt caching) is the `prompt_cache_key` and the `session-id` header. A `system` text block that starts with `x-anthropic-billing-header:` (Claude Code sends one first; it is for Anthropic only) is not part of `instructions`. A `tool_choice` that names a tool that is not sent (not in `tools`, or deferred and not loaded) is left out. The request always has `stream: true` and `store: false`, because chatgpt.com refuses `stream: false`.
- **Dropped.** `thinking` blocks in the history, `cache_control`, Anthropic server tools (a tool without `input_schema`), `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `metadata` (but see Prompt caching), `context_management`, `mcp_servers`, `container`, `service_tier` and every other field. A tool with `defer_loading: true` is sent only after a `tool_reference` block in the history names it.
- **The answer.** A client that asked for a stream gets Anthropic SSE (`message_start`, text and `tool_use` blocks with `input_json_delta`, `message_delta` with `stop_reason` and `usage`, `message_stop`). A client that asked for none gets one JSON Message built from the final Response, or `502` `upstream request failed` when the stream breaks (a cut, or more than 32 MiB) or ends without `response.completed`; the usage line then has the upstream status. `usage.input_tokens` leaves the cached tokens out (`cache_read_input_tokens` has them). One SSE event may be up to 32 Mi characters (`response.completed` repeats the instructions, tools and output); a larger one is dropped. A stream that ends before `response.completed` ends with an `error` event `codex stream ended early`. A `response.failed` is an `error` event, or `500` for a client that asked for no stream.
- **`count_tokens`** is an estimate (the request bytes divided by 4, rounded up). Nothing goes upstream and no usage line is written.
- **Threads.** A client that thinks it talks to the real Anthropic API through the [desktop route](#desktop-route) sends `thread: {"type": "create"}` on its first request, and `thread: {"type": "continue", "previous_message_id": "<id>"}` on the next ones, with only the new turn in `messages` (and no `tools`). The lane keeps, in memory, the conversation up to each answer it gave, under the `id` of the Message the client received (the `message_start` id of a stream, or the `id` of the JSON Message). Per conversation it keeps the latest entry and the one before it: when a `continue` succeeds, the entry two steps back is removed and the new one is stored, so a second `continue` on the same id (a retry, or a side request from the same message) still works. A `continue` request gets the stored messages in front of its own, and the stored `system` and `tools` when it sends none. It is stored only after a whole answer (`response.completed` or `response.incomplete`); a failed or cut answer stores nothing. At most 64 entries, 256 MiB of JSON in all, 6 hours since the last use; the oldest-used go first, and a thread larger than the budget is not kept. A restart forgets every thread. A `continue` with an id the lane does not know (a restart, an expired or evicted entry, an id two or more steps back, a thread made by Anthropic) is `400 thread not found: the proxy keeps GPT lane threads in memory only; start a new conversation`, and nothing is sent upstream or logged. A request without `thread` (the base-URL way, with the whole history each time) never touches the store. `thread`, `diagnostics` and `data_flow` never go upstream. The store holds conversation text the client sent and the converted answers; it holds no token and no account id. Relayed requests keep Anthropic's own threads.
- **Prompt caching.** chatgpt.com caches a prompt per session. The lane has a session id: the client's `x-claude-code-session-id` when it is a UUID, else a UUID-shaped string made from the first 32 hex characters of the SHA-256 of `metadata.user_id` (the raw value never goes up), else none. The id goes up as the `session-id` header and as `prompt_cache_key`. Repeated identical requests (2026-11-24) reported `cached_tokens: 0` four times without a `session-id` header and with a 32-hex `prompt_cache_key`, and `cached_tokens: 6400` of 6613 on most repeats with a `session-id` header and a UUID key. With the lane, see the live check below.
- **Headers upstream**, and no others: `authorization` (the account's token), `chatgpt-account-id`, `content-type: application/json`, `accept: text/event-stream`, `accept-encoding: identity`, and `session-id` when there is a session id. The only client header the lane reads is `x-claude-code-session-id`, and only to make that id. The client's `user-agent`, `anthropic-*` headers and the proxy key stay here.
- **Errors.** An upstream status of 400 or more is answered with the same status and `{"type":"error","error":{"type","message"}}`. The `type` follows the status (`400`, `422` invalid_request_error; `401` authentication_error; `403` permission_error; `404` not_found_error; `413` request_too_large; `429` rate_limit_error; else api_error). The message is `codex account token refused` for `401`, `chatgpt.com refused the request` for `403`, else `codex: ` and the upstream `detail` or `error.message`. That text is scrubbed first: control characters out; e-mail addresses, ids that start with `org-`, `user-`, `acct-`, `account-`, `proj-`, `sess-`, `req-`, `resp-`, `call-`, `fc-` or `msg-` (or with `_`), UUIDs and any run of 24 or more token characters become `[redacted]`; then 500 characters at most. Only the first 4096 characters of an upstream text are read, and a word cut at that edge is dropped. The same scrubbing holds for the text of a failed stream (`error` event, or the `500` for a client that asked for no stream). It is `codex: upstream error` when there is no text. The lane reads at most 1 MiB of an error body and waits 10 seconds for it; after that the text is dropped and the client gets the mapped status at once. A `3xx`, or a `2xx` whose `content-type` names something other than `text/event-stream`, is `502` `codex: unexpected answer <status>`: the upstream body is cancelled and the usage line has the upstream status and no counts. chatgpt.com sends its stream with no `content-type` (seen 2026-11-24), so an answer without one is read as a stream. `retry-after` is kept. A request the converter cannot read is `400` with `request is not a JSON object` or `messages must be an array`. A network failure is `502` as on the other lanes.
- **Usage lines.** A request on the lane is a `codex` line: the account that answered, `model` is the GPT model that was asked, and the counts are read from the Responses stream with the Codex rules (see Usage log). The cached tokens are in `input`.
- **Limits.** Claude Code assumes the context window of a Claude model. Tool use differs in quality between models. A deferred tool is available only after its `tool_reference`. Prompt caching depends on the session id above; there is no other control of it.
- **Terms.** This sends the requests of a client that is not Codex on a ChatGPT subscription token to `chatgpt.com/backend-api`. OpenAI's "Sign in with ChatGPT" documentation tells third-party apps to use the public Responses API and not `backend-api`. It is not an official way to use a subscription, and an account may be limited or closed for it. Read "Read this first" above: it holds here, and more so. Turn the lane on only for accounts you own, and expect it to stop working without notice.

The tests use a fake upstream and two captured Codex streams (`test/fixtures/accounts-gpt/`). Checked against the live endpoint: see below.

Checked once with the real services on 2026-11-24, with the code of this lane run as a separate proxy on a free loopback port and one added ChatGPT/Codex account that had a folder:

- `claude -p --model codex/gpt-6-astra` (Claude Code 2.1.330) read a file, counted its lines with a shell command, wrote the count to a new file and answered with it. It took three requests, all `200`. Claude Code printed the `unrecognized_model` warning and the connectors warning (see above) and went on.
- `claude -p --model codex/no-such-model-x` got `400` with `codex: ` and chatgpt.com's own `detail`. Claude Code showed it as an API error.
- The usage lines said `codex`, the model `gpt-6-astra` and `cacheRead: 0` on all three requests. That code sent a 32-hex `prompt_cache_key` and no `session-id` header.
- After the change to the session id above, the same kind of task (four requests, all `200`; it also read the new file back with the Read tool) gave `cacheRead` 0, then 14848 of 14991, 14848 of 15065 and 14976 of 15145.
- chatgpt.com sent the stream with no `content-type` header.
- Not checked yet: images, PDF files, deferred tools, a switch to a second account, a long interactive session, and Claude Code's background requests (for example a smaller model for titles). Map those model names too, or they go to Anthropic.

Before the lane was written, a few hand-made requests went through the Codex lane on the same day. chatgpt.com accepted top-level `instructions` and `function` tools, `developer` messages, a `function_call` whose `call_id` is `toolu_…` and `reasoning.effort`. It refused `stream: false` (`400 {"detail":"Stream must be set to true"}`) and a `system` message (`400 {"detail":"System messages are not allowed"}`).

### Desktop route

The desktop route lets a Claude Code session that you cannot start with `ANTHROPIC_BASE_URL` use the proxy. The desktop app's Code tab forces its own `ANTHROPIC_BASE_URL`, so the base-URL way of the [GPT lane](#gpt-lane) does not reach it. The route uses `HTTPS_PROXY` instead. With the route on, the proxy listener also works as an HTTP `CONNECT` proxy. Portboard decrypts `api.anthropic.com` only. A `/v1/messages` request for a model the GPT lane takes goes to the lane, and every other request goes to the real `api.anthropic.com` unchanged, with the session's own login. Every other host is a plain tunnel. The route is **off by default** and is part of the proxy: it needs `accounts.enabled` and `accounts.proxy.enabled` too. The switch and **Copy desktop settings** are in Settings (see [Settings](#settings)); `accounts.proxy.desktop.enabled` in `portboard.json` is the value Settings overrides.

Verified on 2026-11-24 with Claude Code 2.1.330:

- `HTTPS_PROXY` from the `env` block of `settings.json` is used even when the process environment forces `ANTHROPIC_BASE_URL`.
- Credentials in the `HTTPS_PROXY` URL are sent as `Proxy-Authorization: Basic` on every `CONNECT`.
- A self-signed end-entity certificate for `api.anthropic.com` (P-256, not a CA, `serverAuth`), named in `NODE_EXTRA_CA_CERTS` from the `env` block, was trusted: a test `CONNECT` proxy that served it decrypted 14 `api.anthropic.com` requests of `claude -p`.
- The two keys also work from a project's `.claude/settings.local.json`, unlike `ANTHROPIC_BASE_URL`, which a project file cannot set.
- The desktop app's own CLI binary (`~/.claude/remote/ccd-cli/2.1.330-...`) behaves the same with the user settings file.

```json
{ "accounts": { "enabled": true, "proxy": { "enabled": true, "port": 8795,
  "gpt": { "enabled": true, "models": { "claude-haiku-5-5": "gpt-6-astra" } },
  "desktop": { "enabled": true } } } }
```

- **What you add.** Portboard writes none of this: it never edits `~/.claude/settings.json`, never installs the certificate into an operating system trust store and never makes a certificate authority. Add this `env` block to a Claude Code settings file:

  ```json
  { "env": {
    "HTTPS_PROXY": "http://pb:<proxy key>@127.0.0.1:8795",
    "NODE_EXTRA_CA_CERTS": "<config folder>/accounts-proxy-cert.pem"
  } }
  ```

  The user name is any text; the password is the proxy key. The file then holds the proxy key: keep it mode 0600 and out of version control (check that `settings.local.json` is ignored). It applies to every Claude Code session that reads the file, and to the sessions the desktop app starts from it.
- **Where to put it.** The project file `.claude/settings.local.json` of the folder where the GPT sessions run is the recommended place: only sessions opened in that folder use the route. `~/.claude/settings.json` also works, but it is wider: every session of the user uses the route.
- **Threads.** Through this route Claude Code uses Anthropic server-side threads (`thread` in the request body: the later turns carry only the new messages). That is why the GPT lane keeps its own threads in memory: see "Threads" in the [GPT lane](#gpt-lane).
- **Which models.** The desktop model picker shows Claude models only. Map a Claude model name you will pick for GPT sessions in `gpt.models`: every session that picks it goes to GPT. The session's background requests use other model names (for example a smaller model for titles); they are relayed to Anthropic. The rules of the GPT lane decide which request is converted (`gpt.enabled`, `gpt.models`, the `codex/` prefix). With the lane off, every decrypted request is relayed.
- **What is decrypted.** Only `CONNECT api.anthropic.com:443`. Portboard answers with its own certificate, and reads each request in clear text, including the session's claude.ai token. The request is held in memory for the relay and written nowhere. A `POST /v1/messages` or `/v1/messages/count_tokens` whose model the lane takes is converted as on the lane: the session's own `authorization` is not sent anywhere, a Codex account is used, and the usage log gets a `codex` line. The session id for prompt caching is the `x-claude-code-session-id` of the inner request. Any other request is relayed: `https://api.anthropic.com` with the same method, path and query, the client's headers except the hop-by-hop ones (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`), and the body as it came. No account is used, nothing is rewritten and no usage line is written. A request that is not for `api.anthropic.com` (another `Host`) is `421`. A WebSocket upgrade is piped to `api.anthropic.com` without inspection. HTTP/2 is not offered.
- **What is tunneled.** Every other target is a TCP tunnel: Portboard connects (10 seconds), answers `200 Connection Established` and copies the bytes both ways. It does not read them and does not record the host name. An idle tunnel stays open. At most 512 `CONNECT` sockets are open at once (`503` beyond); ordinary requests to the proxy, and the decrypted requests that take the GPT lane, share a limit of 32 open at once (`503 too many requests` beyond). Relayed requests are not counted in it. A decrypted connection has 10 seconds from its handshake to send the complete headers of its first request; after each answer, the next request's complete headers must arrive within 60 seconds (idle time included). While a request or its answer is in progress there is no limit. With the route on, the listener accepts up to 32 + 512 connections. Every HTTPS connection of a session, and of the commands it runs, is one `CONNECT`: that is why the limit is larger while the route is on. An authorized `CONNECT` counts in `counts.requests`.
- **The certificate.** Portboard makes `accounts-proxy-cert.pem` and `accounts-proxy-cert.key` in the config folder when both are missing (mode 0600; `PORTBOARD_ACCOUNTS_PROXY_CERT` and `PORTBOARD_ACCOUNTS_PROXY_CERT_KEY` move them). It is valid for 825 days, for `api.anthropic.com` only, and is not a CA. Portboard never replaces a valid pair by itself: a running session trusts only the certificate it read at start, so a silent replacement would break every one of them. A file that others can read, one missing half, a certificate for another name, a pair that does not match and an expired certificate are not used and the state is `error`. The file pair is checked again every minute. With 30 days or less left, one console line says the date; the route keeps working until it. To make a new pair, delete both files, restart Portboard and restart the sessions (they read the certificate at start).
- **Errors on `CONNECT`.** Answers are written raw and the connection ends: `407` with `Proxy-Authenticate: Basic realm="portboard"` for a missing or wrong key (the password must be the proxy key; `Bearer <key>` also works), `403` for a route that is off, a request with an `Origin` header, or the proxy itself as target, `400` for a target that is not `host:port`, `502` when a tunnel cannot connect, `503` beyond the tunnel limit. A decrypted request to a `Host` other than `api.anthropic.com` is `421`. A relay that cannot reach Anthropic is `502 upstream request failed`.
- **Trust model.** The certificate is trusted only by processes that were started with `NODE_EXTRA_CA_CERTS` pointing at it; its key is in the config folder (0600), the same trust as `accounts.json` and the proxy key. The listener stays on `127.0.0.1`, a `CONNECT` needs the proxy key, and `Origin` is refused. Through the route Portboard sees the session's `api.anthropic.com` requests in clear text. A relayed request is kept in memory only while it is relayed. A GPT lane request that carries a `thread` is kept in memory (the `system`, the messages, the tool results and the converted answers) for at most 6 hours since its last use and 256 MiB in all: a sweep every minute removes the old ones, shutdown clears them, and none of it is written to disk. Other hosts are not decrypted. A key change closes every connection that was opened with the old key (a key file edited by hand applies within the next minute; **Change key** applies at once), and turning the route off closes them all.
- **Blast radius.** Claude Code passes its `env` block to the commands it runs. So `HTTPS_PROXY` with the proxy key reaches every tool command and MCP server of those sessions (`npm`, `gh`, `curl`): their HTTPS goes through the tunnel, and the key shows in `env` output and can end up in a transcript. Every session that reads that settings file also needs Portboard's listener: when Portboard is down or restarting (a deploy restarts it), those sessions and their tool commands cannot reach the network through HTTPS. Recovery: remove the two keys from the settings file and restart the session. The project file keeps this to one folder.
- **Terms.** The [GPT lane](#gpt-lane) terms note applies to the requests it converts. The relay sends the session's own requests to Anthropic unchanged.
- **Checked once with the real services on 2026-11-24.** The code of this route ran as a separate proxy on a free loopback port, with one added ChatGPT/Codex account that had a folder and `gpt.models` mapping `claude-haiku-5-5` to `gpt-6-astra`. A folder's `.claude/settings.local.json` held the two keys of the settings block above. In that folder, `claude -p --model claude-haiku-5-5` (Claude Code 2.1.330) ran with `ANTHROPIC_BASE_URL=https://api.anthropic.com` forced in its environment, as the desktop app does. The task read a file, counted its lines with a shell command, wrote the count to a new file, read it back and answered. Five requests went to the GPT lane, all `200`, and from the third on almost all of the input was read from the cache. The session's other api.anthropic.com requests were relayed with its own login, and the run ended without an error. Before the lane kept threads, the second request of the same task failed: chatgpt.com answered `No tool call found for function call output`, because Claude Code sent only the new turn (see Threads in the GPT lane section).
- **Not checked yet.** The desktop Code tab itself (a session opened from the app in such a folder), a long interactive session, and a restart of Portboard in the middle of a thread (the next turn then gets `400 thread not found`).

### Usage log

For each request the proxy sends on, it appends one line to `accounts-usage.jsonl` in the config folder (mode `0600`, written through `appendPrivate`; `PORTBOARD_ACCOUNTS_USAGE` moves it). A line has these keys and no others:

- `at` (ISO time the request started), `provider` (`claude` or `codex`), `account` (the account id, never an email), `model`, `status`, `input`, `output`, `cacheRead`, `cacheWrite`, `ms`.
- `model` is the `model` string of the request body, cut to 128 characters, else `null`.
- `status` is the upstream status. It is `0` when no answer reached the caller: the upstream failed before its headers (the caller got `502`), the wait for the headers ran out, or the caller left before an answer began.
- The four counts come from the answer while it streams back: a JSON answer's `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), or an SSE answer's `message_start` `message.usage` and the last `message_delta` `usage.output_tokens`. A count that the answer did not carry, or that is not a number, is `null`. `count_tokens` records `input_tokens` as `input` and `null` for the rest. A JSON answer larger than 1 MiB is logged without counts.
- **Codex lines.** A request on the Codex lane gets a line with `provider: "codex"`, the account that answered, the `model` of the body, the status and `ms`. The four counts come from the `usage` of the answer. A Codex SSE answer is read at the events whose `type` is `response.completed` or `response.incomplete`: `response.usage.input_tokens` is `input`, `output_tokens` is `output`, `input_tokens_details.cached_tokens` is `cacheRead` and `input_tokens_details.cache_write_tokens` is `cacheWrite`. No other event is read. An SSE event (or a line) longer than 64 Ki characters is dropped for Claude and longer than 1 Mi characters for Codex (the caps count UTF-16 characters, not bytes), whose `response.completed` holds the whole response. A Codex JSON answer is read from its top-level `usage` with the same four names, up to 1 MiB. A field that is missing or not a number is `null`; a request that ends before `response.completed` has `null` for all four. The Claude rules above and below hold for both lanes.
- **GPT lane lines.** A request that took the [GPT lane](#gpt-lane) is a `codex` line with the Codex rules above: the account that answered, `model` is the GPT model that was asked (not the name the client sent), and the counts are read from the Responses stream before it is converted. `count_tokens` on the lane writes no line.
- **`input` differs between the lanes.** A Codex `input` includes the cached tokens, as OpenAI counts them (`cached_tokens` is a part of it). A Claude `input` leaves the cache out. Do not add the `input` of the two providers to compare them.
- A request that ended early (the caller left, or the upstream broke off after its headers) still gets its line, with the counts seen so far and the upstream status.
- A request that moved to another account (a rejected limit) gets one line, for the account that answered last. When no account is left, the last answer goes to the caller and the line is for the account that gave it.

It never records a request or answer body, a token, the proxy key, a header value or an email. The counts are read from a copy of the stream; the bytes the caller gets do not change.

- **503 `no usable account` is not logged:** there is no account to name.
- **Best effort.** A failed write is dropped without a message and never changes an answer. A log file that group or others can read or write, or that is not a regular file, is neither read nor written.
- **30 days.** A line older than 30 days is not counted by the summary. Once a day (the first write of each UTC day after a start) the file is rewritten through `writePrivate` with only the lines of the last 30 days; a line that is not valid is dropped then.
- **Cleanup moves forward only, and tries again.** The rewrite runs when a line's date is later than the day of the last rewrite (an older `at` never starts one). A rewrite that fails is not counted as done: the next line tries again.
- **Size.** The file holds at most 30 days of lines, and the summary reads the whole file. The model name is read by parsing the whole request body as JSON (within the 32 MiB body limit); only the `model` string is kept.
- **Shutdown.** When Portboard closes the proxy, it waits up to 2 seconds for the lines of requests it cuts off and for writes still running, then goes on.
- **`unavailable`.** When the log file exists but cannot be read (group or others can read or write it, it is not a regular file, or a read error), the answer of `GET /api/accounts/usage` has `unavailable: true` with zero totals and no rows: the zeros then mean "unknown", not "no requests". A file that is not there is an empty log, and the answer has no `unavailable`.
- **`GET /api/accounts/usage?days=N`** gives `{days, totals, rows}` for the last `N` days (a whole number from 1 to 30, default 7; else `400 invalid days`). The checks are those of `GET /api/accounts`: `404 accounts disabled`, then `403 owner only`. `rows` group the lines by UTC `day`, `provider`, `account` and `model`, with `requests` and the sums of the four counts (a request without a count adds nothing to that sum; `null` when no request had it). `totals` has `{requests, recorded}` for `claude` and `codex`: `recorded` counts the requests with both `input` and `output`.

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
| `invalid days` | `GET /api/accounts/usage` got a `days` that is not a whole number from 1 to 30 (HTTP 400) |
| `accounts proxy disabled` | the proxy key route was called while the proxy is off (HTTP 404) |
| `proxy key unusable` | the key route could not read or write the key file, for example a file that other users can read (HTTP 500) |

## Who can see it, and what leaves the process

- **Owner only.** `GET /api/accounts` uses the same owner check as the audit log: anyone else gets `403 {error: "owner only", reason}` before any file is read. The eight write routes (the four sign-in routes, `use`, `remove`, the proxy key route and the lanes route) are `write: true`: the router refuses a caller who is not the owner, and a request without `X-Portboard: 1`, before the route's code runs.
- **No remote MCP.** `list_accounts` is a local stdio tool. It is not in the remote server's tool list or in `RemoteCore`. No MCP tool adds, uses or removes an account.
- **Allowlisted answer.** The answer holds `id`, `provider`, `source`, `alias`, `email`, `plan`, `tier`, `status`, `expiresAt`, `needsReauth`, `active`, `command`, `quota` and `error`, each copied by name. It has no token, no account id and no id token. The sign-in routes answer with the same view, never with the stored record.
- **No logs.** Tokens are not written to a log, the audit log or an error text. An error is one short fixed sentence (for example `quota request failed (HTTP 500)`). The audit line of a sign-in, use or remove request holds the names of the body keys (`flowId`, `code`, `provider`, `alias`, `id`, `rotate`, `gpt`, `desktop`) and none of their values, so a pasted code and an account id are never recorded.

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
    "unproxied": [{ "path": "/v1/models", "count": 2 }],
    "lanes": {
      "gpt": { "enabled": true, "models": { "claude-haiku-5-5": "gpt-6-astra" } }, "desktop": { "enabled": false },
      "source": { "gpt": "file", "desktop": "config" }, "unreadable": false
    },
    "activity": {
      "gpt": { "requests": 4, "lastAt": "2026-11-20T09:00:00.000Z" },
      "desktop": { "connects": 0, "open": 0, "lastAt": null }
    }
  }
}
```

`proxy.lanes` is the GPT lane and the desktop route in effect (a process that never opened the proxy, such as the stdio MCP server, reads them from the lanes file, then `portboard.json`), `source` says per lane whether the value came from `accounts-lanes.json` (`file`) or `portboard.json` (`config`), and `unreadable` is true when the lanes file could not be used. `proxy.activity` counts, since Portboard started: `gpt.requests` (requests the GPT lane converted), `desktop.connects` (authorized `CONNECT`s), `desktop.open` (tunnels and decrypted connections open now) and the time of the last one of each (`lastAt`, ISO, or `null`). No host name, request text, key or token is in either.

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

`POST /api/accounts/proxy/key`: `write: true` (owner only, needs `X-Portboard: 1`), body JSON of at most 4 KiB, `{rotate?: boolean}`. It answers `{key, keyFile, certFile}` (the proxy key, made on first use, the absolute path of the key file, and the absolute path of the [desktop route](#desktop-route) certificate, whether or not the file exists yet), and with `rotate: true` it first writes a new key, so the old one is `401` from then on and the `CONNECT` connections of the [desktop route](#desktop-route) that were opened with it are closed. It answers `404 {error: "accounts proxy disabled"}` while the proxy is off, and `500 {error: "proxy key unusable"}` when the key file cannot be used. The audit line holds the key name `rotate` and no key.

### Lanes route

`POST /api/accounts/proxy/lanes`: `write: true` (owner only, needs `X-Portboard: 1`), body JSON of at most 16 KiB, `{gpt?: {enabled?: boolean, models?: {<name>: <model id>}}, desktop?: {enabled?: boolean}}`. It merges the body over the lanes in effect (a field that is not sent keeps its value; `models` sent replaces the whole map), writes `accounts-lanes.json` with both keys, applies the result to the running proxy at once and answers `{lanes, source}`. It answers `404 {error: "accounts disabled"}` while accounts are off, `404 {error: "accounts proxy disabled"}` while the proxy is off, and `400 {error: "invalid lanes"}` for an unknown top-level or nested key, an `enabled` that is not a boolean, `models` that is not an object, more than 32 entries, a name that is not 1 to 128 printable ASCII characters, or a model id that does not match the GPT lane's rule (the input is not echoed), and `500 {error: "lanes not written"}` when the write fails. Requests run one at a time, so two at once both apply. When the request turns the desktop route on and the proxy cannot start it (its certificate cannot be used: see [the certificate](#desktop-route)), the previous lanes are written back, the proxy opens again without the route and the answer is `500 {error: "desktop route certificate unusable"}`. A lanes file that could not be read is replaced by a good one made from the values in effect. The audit line holds the key names `gpt` and `desktop` and no value.
