# Security

Portboard's dashboard (127.0.0.1 and the Tailscale IP, port 8790) can restart and stop services, publish ports with
`tailscale serve`, delete git worktrees and change alert settings. This page says who can reach it, who can change
things, and what is recorded. The public, read-only remote MCP server (8794, Funnel 443) has its own review:
[remote-mcp/SECURITY-REVIEW.md](remote-mcp/SECURITY-REVIEW.md).

## Who can reach it

- It listens only on loopback and the Tailscale IP, so only processes on this machine and devices in the tailnet can connect. Without Tailscale, loopback only. `PORTBOARD_HOSTS` can add a LAN address; without [token mode](#token-mode-c10devportboard12) it is read-only there, and the server says so at start.
- `tailscale serve` publishes it as `https://devbox.example.ts.net:8443` (8443 → 127.0.0.1:8790), tailnet only. Port 443 is the public, read-only remote MCP server (Funnel → 8794); the dashboard is never on a Funnel port.
- Requests whose `Host` header isn't one of this machine's names get 421. This blocks DNS rebinding. The names are localhost, 127.0.0.1, the host name, the Tailscale names and IPs, the listen addresses, and `PORTBOARD_ALLOWED_HOSTS` (e.g. `devbox.lan`); a wildcard bind (`0.0.0.0`) adds this machine's interface addresses, never "any" (`src/core/hosts.ts`).
- Reads (`GET`) are open to every caller that can connect, with three exceptions that are the owner's only: the audit
  log (`GET /api/audit`, c10dev/portboard#7, [Audit log](#audit-log-c10devportboard30)), service logs
  (`GET /api/ports/:port/logs`), because a dev server often prints tokens and secrets at start, and the Claude Code
  and Codex logins (`GET /api/accounts`, [Accounts](#accounts), 404 while `accounts.enabled` is off). Other callers get
  403 `owner only`. The tailnet is the owner's devices plus anything shared into it, and the port list, devices and
  history are readable by all of them.

## Who can write (c10dev/portboard#29)

Every `POST` route goes through one router (`appRouter` in `src/features/router.ts`). The registry refuses a non-GET
route that isn't declared a write, and the checks run in this order, before the handler and before the body is read:

1. **`X-Portboard: 1`** (CSRF). A custom header forces a CORS preflight, and Portboard never answers one, so a
   cross-site page can't send it. 403 `missing X-Portboard header` otherwise.
2. **The owner** (`src/core/access.ts`, pure function `classify`). 403 `{error: "owner only", reason}` otherwise.
   In [token mode](#token-mode-c10devportboard12) the owner token also counts; the `X-Portboard` check stays.

| Caller | How Portboard sees it | Writes |
|---|---|---|
| A process on this machine: the Claude plugin hooks, `curl`, scripts | `loopback`: socket 127.0.0.1 / ::1, **no** proxy header | yes: the owner (same machine user, who can edit the state files anyway) |
| The dashboard through `https://…ts.net` from a device logged in as the owner | `serve`: socket loopback, `X-Forwarded-*` and `Tailscale-User-Login` = the owner | yes |
| The same, logged in as another user (a node shared into the tailnet) | `serve`, another login | no |
| A tagged device through serve | `serve`, no login header | no |
| Funnel (public), if it ever pointed at 8790 | `serve` with `Tailscale-Funnel-Request` | no |
| A tailnet device on `http://<host or 100.x IP>:8790` | `direct`: any non-loopback socket | no (read-only), whatever `Tailscale-*` headers it sends |
| The stdio MCP server (`src/mcp.ts`) | not HTTP: a child process of a local Claude session | yes (owner); recorded as `mcp` |

This is the default, **tailscale mode**. Token mode adds the owner token: [below](#token-mode-c10devportboard12).

The rule as code:

- **Loopback without proxy markers = the owner.** The markers are `X-Forwarded-For/-Host/-Proto`, `Forwarded`,
  `Tailscale-User-Login/-Name`, `Tailscale-Headers-Info`, `Tailscale-Funnel-Request`, and other proxies' client-address
  headers: `X-Real-IP`, `Via`, `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `X-Cluster-Client-IP`,
  `Fastly-Client-IP`, `X-Original-Forwarded-For` (so an nginx-style local proxy that sets only `X-Real-IP` doesn't make
  its clients the owner; security review v1.0, L5). Any of them makes the request
  `serve`, so a local process can only lose rights by sending one, never gain them. The plugin's SessionEnd route keeps
  its stricter "loopback only, never through serve" check with the same function (`localOnly`).
- **Through serve, only the owner's login.** The owner is `PORTBOARD_OWNER_LOGIN` if set, otherwise this node's
  Tailscale user: `tailscale status --json` → `Self.UserID` → `User[id].LoginName` (cached with the other
  `tailscale status` callers). Logins are compared trimmed and case-insensitively; tailscaled's RFC 2047 encoding of
  non-ASCII values is decoded first. If the server itself is a **tagged** node it has no owning user, so only
  `PORTBOARD_OWNER_LOGIN` can name one; with no owner known, writes through serve are refused and loopback still works.
- **Direct non-loopback access is read-only.** Headers on a direct connection are typed by the client, so they are never
  read for the decision. A direct connection can't write even from the owner's devices; use the https address.

### Write devices

"The owner's login" means every **untagged node logged in as the owner**, and that includes headless servers (on
devbox's tailnet: pve1, nas, gpu-box, docker-vm, the Windows desktop). Through serve, code running on
any of them could restart, stop, expose and delete like the owner's laptop (security review v1.0, M1). So Portboard
identifies the device too, and can be told which devices may write.

- **Which device.** For a `serve` caller the device is the address tailscaled put in `X-Forwarded-For` (it sets the
  header, after deleting the client's; only a single valid IP is used); for a `direct` caller, the socket address
  (its `X-Forwarded-For` is never read). `tailscale whois --json <address>` (argv, no shell, 3 s timeout) gives the
  node's MagicDNS name and stable node ID. Results are cached per address for 3 minutes (1 minute when whois doesn't
  know it), concurrent lookups share one run, at most 512 addresses are kept, and addresses outside 100.64.0.0/10 and
  fd7a:115c:a1e0::/48 (Funnel clients, LAN) are never looked up. Lookups happen only for writes and `/api/whoami`.
- **Recorded.** Every audit line of a serve or direct caller carries `device: {addr, name?, id?}`, and
  `GET /api/whoami` returns it, so a write from `docker-vm` no longer looks like one from the owner's phone.
- **The allowlist.** `writeDevices` in `~/.config/portboard/access.json` (`PORTBOARD_ACCESS` moves it; a preview reads
  its own `previews/<port>/access.json`, never production's), plus `PORTBOARD_WRITE_DEVICES` (comma list), merged:

  ```bash
  umask 077; printf '%s\n' '{"writeDevices":["dev-mac","iphone"]}' > ~/.config/portboard/access.json
  ```

  Or tick the devices on the dashboard's 설정 tab (쓰기 허용 기기, `POST /api/settings/write-devices`, an owner write
  like any other): it writes the file 0600 atomically, keeps its other keys, and refuses a list that leaves out the
  device you are saving from, so a save can't lock you out.

  Entries are node names (short `dev-mac` or full `dev-mac.example.ts.net`, any case) or stable
  node IDs (`nExampleNode1CNTRL`, exact; `tailscale status --json` → `Peer[].ID`). When it is set, a serve write is
  allowed only from a listed device; any other owner-login device gets `403 owner only` with the reason
  `<name>(<100.x>)은(는) 쓰기 허용 기기가 아니에요`, and so does a device whois can't identify. The file is read on
  every write, so an edit applies at once. It must be mode 0600: a file others can read or write, invalid JSON, or a
  `writeDevices` that isn't a list of strings **fails closed** (no serve writes until fixed; loopback still works).
  Loopback, the stdio MCP server and direct callers are unaffected (loopback and MCP are this machine; direct was
  already read-only).
- **Unset** (the default): behaviour as before, any owner-login device may write through serve. The 설정 체크리스트
  then shows a warn item, **쓰기 가능한 기기 제한 안 됨**, listing the owner-login untagged devices from
  `tailscale status` that can currently write, with the command above prefilled with the personal ones (macOS, iOS,
  Android, Windows).
- **Also worth doing outside Portboard:** tag the headless nodes (`tag:server`) so serve sends them no login at all,
  and limit `devbox:443`/`:8790` to the laptop and phone in the tailnet ACL.

`GET /api/whoami` returns `{login, source, owner, canWrite, reason?}`. The dashboard asks once per page; when
`canWrite` is false it shows `🔒 읽기 전용 — <reason>` under the header, greys out every control marked `data-write`,
and `post()` answers with the same reason instead of sending (`public/lib/access.js`, `public/lib/api.js`).

### What tailscale serve sends, and how this was checked

From the tailscaled source (`ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders` and `addProxyForwardedHeaders`):
serve proxies from loopback; it **deletes** any client-supplied `Tailscale-User-Login`, `Tailscale-User-Name`,
`Tailscale-User-Profile-Pic`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info`, then sets them from `WhoIs` of the
peer. A tagged peer gets no user headers; Funnel traffic gets only `Tailscale-Funnel-Request`. It sets (not appends)
`X-Forwarded-For/-Host/-Proto`.

On devbox (tailscaled 1.104.1) the binary contains those header names and both function names. A live capture of what serve sends to
8790 wasn't possible from this user (no root for a packet capture, and the serve config must not be changed). The
remote review confirmed live that tailscaled overwrites a client-supplied `X-Forwarded-For` on the Funnel path
([remote-mcp/SECURITY-REVIEW.md](remote-mcp/SECURITY-REVIEW.md)). Portboard's side was tested end to end on a preview
with a local fake proxy that behaves as above. After a deploy,
`GET https://devbox.example.ts.net:8443/api/whoami` from an owner device should answer `source: "serve"` with the
owner's login; that is the live check for serve itself.

### Threat model

| Threat | Before | Now |
|---|---|---|
| A device shared into the tailnet, or a compromised tagged node, restarts/stops services, deletes worktrees, exposes ports | any tailnet device with `X-Portboard: 1` could | denied (not the owner's login, or direct), and recorded |
| A compromised **untagged server logged in as the owner** (NAS, docker host, Proxmox) writes through serve | allowed, recorded as the owner | with `writeDevices` set: denied, recorded with its device name and address. Without it: still allowed, but the audit line names the device and the checklist warns |
| A local reverse proxy that forwards to 127.0.0.1:8790 and sets only `X-Real-IP`/`Via` | counted as loopback (owner) | a proxy marker: `serve`, no login ⇒ read-only |
| A tailnet peer floods denied POSTs to rotate the audit log away | ~7,000 requests emptied both files | denials go to their own capped file and are coalesced per minute; `audit.jsonl` keeps the writes |
| A page in the owner's browser frames the dashboard and overlays decoy UI (clickjacking) | possible | `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` |
| A tailnet device spoofs `Tailscale-User-Login` | — | ignored on direct connections; stripped and reset by serve |
| A local process spoofs `Tailscale-User-Login` / `X-Forwarded-For` | — | only makes it a non-owner (`serve`); it is already the owner without them |
| A cross-site page in the owner's browser POSTs | blocked by `X-Portboard` | unchanged; now also recorded as `denied` |
| Funnel reaching the dashboard by a config mistake | full write access | `Tailscale-Funnel-Request` ⇒ read-only |
| `tailscale status` fails (tailscaled restarting) | — | owner unknown ⇒ serve writes refused until it answers; loopback unaffected |
| A non-owner reads ports, devices and history | yes | yes: reads stay open to the tailnet (accepted: the dashboard is a read-only view for the tailnet by design) |
| A non-owner reads the audit log (who changed what, from which device, when) | yes | no: `GET /api/audit` answers `403 owner only` (#7) |
| A non-owner reads the plan, email and remaining limits of the logins on this machine | — | no: `GET /api/accounts` answers `403 owner only`, and `404` while `accounts.enabled` is off ([Accounts](#accounts)) |
| Other Unix users on devbox | could use loopback | still can by default: loopback is trusted. **Accepted** (#7): the machine has one login user, and every local process runs as the owner who can edit the state files anyway. If a second user gets a login: token mode with `requireTokenOnLoopback` (#12) |

## Token mode (c10dev/portboard#12)

Everything above depends on Tailscale: the owner is a Tailscale login, a device is a tailnet node. Without it Portboard
is a read-only viewer for everyone but local processes. Token mode is an opt-in second way to be the owner: a secret
the owner holds. Turn it on with `"mode": "token"` in `access.json` or `PORTBOARD_ACCESS_MODE=token`
([config.md](config.md#access-accessjson)); the default stays tailscale mode, where the `Authorization` header is never
read. Setup: [setup.md](setup.md#without-tailscale).

- **The token.** `portboard token` makes `pbt_` + 32 random bytes (base64url), prints it once on stdout, and writes
  only its sha256 to `owner-token.json` (0600, atomically through `writePrivate`). The token is in no file, log or
  audit line. Running it again replaces the hash: the old token stops working at the next request (the file is read
  on every write and `/api/whoami`). A file that isn't 0600 or isn't that shape refuses every token (fail closed).
- **Checking it.** `Authorization: Bearer <token>`. The presented token is hashed and compared with
  `crypto.timingSafeEqual` against the stored 32 bytes, so the time taken says nothing about how much of it matched.
  POSTs still need `X-Portboard: 1`: the token doesn't replace the CSRF check.
- **In the browser.** 설정 › 화면 › 소유자 토큰 keeps it in localStorage (`pb.ownerToken`), and `public/lib/api.js`
  sends it as the header on every `/api` request of that page. Never in a URL (history, logs, Referer). It is not a
  `data-write` control: entering it is how a read-only browser becomes the owner. A cross-site page can't read
  another origin's localStorage, and the custom headers force a preflight Portboard never answers.

| Caller (token mode) | No `Authorization` | The right token | A wrong, malformed or uncheckable token |
|---|---|---|---|
| Loopback, no proxy markers | the owner (`loopback`) | the owner (`token`) | **no** |
| … with `requireTokenOnLoopback` | **no** | the owner (`token`) | no |
| `tailscale serve`, the owner's login | the owner (`serve`, writeDevices applies) | the owner (`token`) | **no** |
| … with `requireTokenOnLoopback` | **no**: on loopback any local process can type serve's headers | the owner (`token`) | no |
| `serve`, another login, a tagged node, another local proxy | no | the owner (`token`) | no |
| **Funnel** (`Tailscale-Funnel-Request`) | no | **no** | no |
| Direct: LAN, tailnet IP, anything not loopback | no | the owner (`token`, with the address) | no |
| The stdio MCP server | the owner (`mcp`), unchanged | — | — |

Decisions behind the table (pure, `classifyToken` in `src/core/access.ts`; every cell is in `test/access-token.test.ts`):

- **Funnel never writes**, checked before the token: the dashboard is never meant to be on Funnel, and if it ends up
  there by a config mistake, a leaked or guessed token must not make the public internet the owner. Funnel requests
  are recognised by the header tailscaled sets (and deletes from clients), the same as in tailscale mode.
- **A wrong token loses rights, even on loopback**, like the proxy markers: sending something can only cost rights
  unless it is the real token. No token made yet, or a broken `owner-token.json`/`access.json`, counts as wrong.
- **`requireTokenOnLoopback`** closes the "loopback has no token" gap for a machine with other Unix users. It also
  drops the serve login on loopback: tailscaled's headers arrive from 127.0.0.1, and with local processes untrusted,
  a local process could type `Tailscale-User-Login: <owner>`. The Claude plugin's hooks (which don't have the token)
  can't write then either.
- **The write-device allowlist** limits serve logins only. The token is its own credential; a device holding it was
  given it by the owner.
- **Recorded** as source `token`, who = the caller's address (`local` on loopback), with the tailnet device when the
  address is one. The audit log is readable with the token too (it is the owner).

| Threat (token mode) | Now |
|---|---|
| Someone on the LAN sniffs plain http and replays the token | possible: the token is a bearer secret. **Accepted**, documented: token mode over the LAN is for a network you trust, or put a TLS proxy on this machine in front (it is a proxy marker, so it is decided as `serve` + token) |
| Guessing the token | 256 bits; denials are logged and coalesced (M2) so a flood can't flush the log |
| Timing the comparison | hashed, then `timingSafeEqual` on 32 bytes |
| The token in logs, URLs, the audit log or the state dir | never: only its sha256, and the audit line names the source, not the secret |
| XSS on the dashboard reads localStorage | the token is exposed (an XSS could also send writes from the page itself). **Accepted**: the CSP is only `frame-ancestors` (L3); rotate with `portboard token` if in doubt |
| A stolen token | `portboard token` again: the old one stops working at the next request, no restart |
| Typo in `mode` | reported at start and on every write; counts as tailscale mode, so it never opens anything |
| Tailscale-only actions without Tailscale | expose/unexpose and the write-device allowlist answer `409` before running anything, and the UI hides them |

## Audit log (c10dev/portboard#30)

Every write through the routes — allowed, denied (no `X-Portboard`, not the owner, a handler's own 403) or failed — and
every write tool of the stdio MCP server is one JSON line in `<state dir>/audit.jsonl` (mode 0600; production
`~/.local/state/portboard/audit.jsonl`, a preview its own). A line holds the time, who (Tailscale login, `local`, or a
direct caller's address), the source (`serve`, `loopback`, `direct`, `mcp`, `token`), the route pattern or tool, the target
identifiers, the result and status, and the answer's short message. Request bodies are never written as they are: only
allowlisted identifier fields (`port`, `ports`, `path`, `paths`, `repo`, `owner`, `key`, `session_id`, booleans such as
`pinned`), and only the **names** of other fields (a label, a device name or a note shows as `fields: ["label"]`).
Denied requests are logged before the body is read. Header text is cut and stripped of control characters. Serve and
direct lines also carry the device (`device: {addr, name?, id?}`, see [Write devices](#write-devices)).

**Who may read it** (c10dev/portboard#7): only the owner, decided like a write (`classify` in `src/core/access.ts`):
a process on this machine talking to 127.0.0.1 directly, or the owner's Tailscale login through `tailscale serve`.
Everyone else, including a direct `http://<tailnet IP>:8790` connection from the owner's own laptop, gets
`403 {error: "owner only", reason}`, and the dashboard's 최근 기록 and the service page's 기록 say "기록은 소유자만 볼 수
있어요" instead of the entries. The write-device allowlist doesn't apply: it limits writes, and an owner device that
may not write can still read what was done. No `tailscale whois` runs for this read. Every other read is unchanged.

Denials can't flush the log (security review v1.0, M2): they go to their own file, `audit-denied.jsonl` (+ `.1`,
256 KB each), and identical ones (same who, source, route, reason and device address) are coalesced: the first is
written at once, repeats within a minute become one line with `count` and `since`. A flood of denied POSTs therefore
writes about one line per minute per kind and never rotates `audit.jsonl`, which keeps allowed and failed writes
(1 MB + one rotation).

## Accounts

Off by default (`accounts.enabled` in `portboard.json`, [accounts.md](accounts.md)). It shows the plan, expiry and remaining limits of the Claude Code and Codex logins on this machine, and of the accounts the owner adds in Portboard (Claude, ChatGPT/Codex, GitHub Copilot).

- **Two files read:** `.credentials.json` of Claude Code and `auth.json` of Codex, only the keys listed in [accounts.md](accounts.md#what-it-reads). Refresh tokens and every other key are not used and not kept (each file is parsed as a whole, and only the listed values are copied out).
- **One file written:** `accounts.json` in the config folder (`PORTBOARD_ACCOUNTS`), mode 0600, only through `writePrivate`, only when the owner adds, uses, removes or refreshes an account. It holds the tokens of the added accounts: Portboard's only copy, and no token leaves it. A file that cannot be read is never overwritten, and neither is one that is not a regular file or that group or others can read or write (`accounts file unreadable`). A failed write is `accounts file not written`. Nothing under `~/.claude` or `~/.codex` is written.
- **Account folders and backups:** "use this account" writes the CLI's login file into `account-homes/<account id>/` (`PORTBOARD_ACCOUNT_HOMES`; folder 0700, file 0600, through `writePrivate`). The id must match `acc-` and 12 hex digits, so it cannot hold a path character. A file that is there is copied once to `<name>.bak` (0600) first. A link where the folder or the file belongs is never followed. The file in the folder is the original of that account's tokens: Portboard reads it back and does not refresh the account. It never sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for itself or for anything else.
- **The delete path:** `POST /api/accounts/remove` deletes the record, then the folder, with `fs.rm(recursive)` only after it checks that the path is a real folder (`lstat`, not a link), that its name matches `acc-` and 12 hex digits, and that `realpath` of its parent is `realpath` of `account-homes`. Anything else is left alone (`account home not written`). A CLI login cannot be removed. Nothing outside `account-homes` is deleted.
- **Requests sent:** a usage `GET` per Claude or Codex login to `api.anthropic.com` and `chatgpt.com`, each with that login's access token. Adding an account sends sign-in requests to `api.anthropic.com` (the sign-in page itself is `claude.ai`, opened in the owner's browser), `auth.openai.com`, `github.com` and `api.github.com`, and nowhere else. The endpoints are unofficial and can change, and a vendor may limit an account for unusual use. An added Claude or Codex account without a folder is refreshed (a `POST` to its vendor's token URL, with its refresh token) when its access token has expired and the dashboard asks for limits, and when the owner chooses "use this account". No CLI login and no account with a folder is refreshed; the read-only MCP tool does not refresh.
- **Owner only:** `GET /api/accounts` runs the audit log's owner check (`classify`) before it reads anything; anyone else gets `403 {error: "owner only", reason}`. The six write routes (`POST /api/accounts/login/start`, `finish`, `poll`, `cancel`, `use`, `remove`) are `write: true` routes of a `FeatureModule`: `appRouter` refuses a caller who is not the owner, and a request without `X-Portboard: 1`, before the route's code runs.
- **Flow state in memory only:** the PKCE verifier, the state, the device ids and the codes live in a Map in the process for at most 10 or 15 minutes, three flows per provider. Every call to a login route drops the flows that are past their life, and a flow cancelled while a vendor answers is not saved. They are in no file, answer, log or audit line. The sign-in link in the `start` answer carries the PKCE challenge and the state, which the vendor's page needs; the verifier never leaves.
- **What the audit line holds:** the route, who and from which device, the result, and the names of the body keys (`flowId`, `code`, `provider`, `alias`, `id`). It holds no value: not the pasted code, not the flow id, not the name, not the account id. The error text of a failed request is one fixed sentence.
- **Not remote:** `list_accounts` is a local stdio tool. It is not in the remote server's tools, in `RemoteCore` or in `REMOTE_READS`. No MCP tool adds, uses or removes an account.
- **Allowlisted answer:** each field of the answer is copied by name (`src/core/accounts/view.ts`). Tokens, the account id and the id token are not in it. `command` holds a folder path, for the owner only, and no token. The sign-in, use and remove routes answer with that view, never with the stored record.
- **No token in logs:** a token is not written to a log, the audit log or an error text. Errors are a closed set of short fixed sentences with no response body, header, token or pasted text.

## Responses, limits and files (security review v1.0, L3, L6, I8)

- **Headers on every answer** (API, static files, 404/421/500): `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'` (no other site can frame the dashboard and overlay its write
  buttons; nothing in `public/` is meant to be framed), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`. The CSP is deliberately only `frame-ancestors`; a `default-src` policy would need an audit of every
  page script first.
- **Server limits**, like the remote server: `headersTimeout` 10 s, `requestTimeout` 30 s (receiving the request, not
  answering it), `keepAliveTimeout` 5 s, and at most 256 connections per listen address.
- **500s** never carry the error's text (it can hold paths and command output, and until #7 the audit log was readable
  by every tailnet peer): the answer is `{error: "서버 오류가 났어요 (요청 ID 1a2b3c4d).", requestId}`, the audit line's detail has
  only the id, and the full error goes to the server log (`journalctl --user -u portboard`) under the same id.
- **State and config files** are written 0600 in 0700 directories, through a temp file with a random name opened
  with `O_EXCL` and renamed over the target (`src/core/atomic.ts`), so a planted file or symlink at a guessable temp
  path is never followed. `deploy/portboard.service` sets `UMask=0077` and `NoNewPrivileges=yes` like the remote unit.
  `scripts/deploy.sh` does not install unit files: after this change, copy the unit to `~/.config/systemd/user/` and
  `systemctl --user daemon-reload` once. Files written before keep their old mode until their next write.

## Open items

- ~~**Loopback has no token**~~: opt-in since #12, token mode with `requireTokenOnLoopback`. The default is unchanged
  (any process on this machine is the owner), accepted for a one-user machine.
- ~~The whole tailnet can read the audit log~~: closed by #7, owner only.

## Other rules

- `expose` is refused unless the port is loopback-only, speaks HTTP, and isn't already registered.
- `GET /api/claude/port-advice` (the Claude Code port nudge) reads, never writes: it runs `git rev-parse` in the `cwd` it is given (an absolute directory, with `core.fsmonitor=false` so no repo-configured hook runs) and answers with the same owner/session facts as `/api/owners`.
