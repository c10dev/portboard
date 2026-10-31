# Remote MCP security review (2026-10-17)

Scope: the read-only remote MCP server (`src/remote.ts`, `src/remote/*`) as it runs in production: public through Tailscale Funnel at `https://devbox.example.ts.net/mcp` (port 443) → `127.0.0.1:8794`. At the time of the review the connector was on Funnel 8443; it moved to 443 on 2026-10-18 because claude.ai never connected to 8443, and the dashboard took 8443 (tailnet only, never Funnel). See [README › Going public](README.md#going-public-done-funnel-443--8794). It was reviewed from an internet attacker's position, then from a tailnet peer and a local process. Issue: c10dev/portboard#3.

**Verdict:** nothing critical, and nothing that leaks data or grants access right now. Production's `remote.json` has `publicUrl` set, `allowLoopbackRedirects: false`, no clients and no tokens. The findings are availability problems, integrity problems in incident response (`revoke`) and hardening. All findings rated medium are fixed on branch `remote-security`, along with the cheap low ones.

Live check: one request with a forged `X-Forwarded-For: 6.6.6.6` and `Tailscale-Funnel-Request` was sent to the public URL with a bogus token. Production logged the real address (`auth-fail ip="funnel:220.120.72.160"`, the VM's own egress), so tailscaled overwrites a client-supplied `X-Forwarded-For`. That one `auth-fail` line in the production journal is from this review.

## Findings

Severity is for this deployment (single owner, Funnel on 443, dashboard tailnet-only on 8443). Statuses as of c10dev/portboard#7 (2026-10-19), which closed the leftovers listed in [Follow-up (#7)](#follow-up-7).

| ID | Severity | Finding | Status | Test |
|---|---|---|---|---|
| S1 | Medium | The failure limiter blocks valid credentials from shared egress addresses | Fixed | `remote-security` S1 |
| S2 | Medium | `Tailscale-Funnel-Request` was trusted from any socket, including tailnet peers | Fixed | `remote-security` S2 |
| S3 | Medium | Unauthenticated amplification: unlimited `/register` writes and CIMD fetches | Fixed | `remote-security` S3 (×4) |
| S4 | Medium | Server and CLI wrote `remote.json` without a shared lock, so `revoke` could be silently undone | Fixed; stale-lock race between two waiters fixed in #7 | `remote-security` S4 (×5) |
| S5 | Low–medium | Anyone could burn the owner's pending approval code with 5 tries | Fixed; IPv6 counted per /64 (#7). Residual (≥4 addresses or /64s can burn a code) accepted | `remote-http` "wrong approval codes…", `remote-security` S5 (×4) |
| S6 | Low–medium | No refresh-token reuse detection | Fixed | `remote-security` S6 (×2) |
| S7 | Low | `/token` accepted requests without `client_id` | Fixed; the hosted clients' expected request is tested (#7), a live claude.ai/ChatGPT check is still to do | `remote-security` S7 (×2) |
| S8 | Low | `client_id=__proto__` / `constructor` reached a crash path (500) | Fixed | `remote-security` S8 |
| S9 | Low | `extraRedirectPrefixes` matched by raw string prefix | Fixed | `remote-security` S9 |
| S10 | Low | Hand-edited config values: `"showAddresses": "false"` loosened redaction; a string `allowedOrigins` matched substrings | Fixed | `remote-security` S10 |
| S11 | Low | The issuer fell back to the Host header if `remote.json` lost `publicUrl` at runtime | Fixed (issuer pinned at start); loopback-redirect default closed for Funnel in #7 | `remote-security` S11 (×2) |
| S12 | Low | `~/.config/portboard` is 775; the temp file had a predictable name and followed links | Fixed | `remote-security` S12 |
| S13 | Low | Attacker-sized tool names in the call log (up to 64 KB × 20 per request) | Fixed | `remote-security` S13 |
| S14 | Low | Absolute paths outside `/home` (`/srv`, `/opt`, `/var`…) passed the text scrub | Fixed | `remote-security` S14 |
| S15 | Low | No cap on concurrent connections | Fixed (`maxConnections = 256`) | — (server option) |
| S16 | Info | Consent phishing with the attacker's own claude.ai / ChatGPT connector | Accepted; the consent page now warns | — |
| S17 | Info | The Origin check compares host names only (any port or scheme on a local name passes) | Accepted | — |
| S18 | Info | Local processes can still send `Tailscale-Funnel-Request` | Accepted | — |
| S19 | Info | `redirect_uri` stays optional at `/token` | Accepted | — |

### S1 · Medium · Shared-egress lockout (fixed)

**Before:** 20 failures from one address in 10 min made `/mcp`, `/token` and `/register` refuse *everything* from that address, valid tokens included. claude.ai calls from Anthropic's egress (`160.79.104.0/21`) and ChatGPT from OpenAI's, shared by every user of those services.

**Exploit:** the attacker adds this server as a connector in their own claude.ai account. They open `https://claude.ai/api/mcp/auth_callback?code=bogus&state=<their state>` about 20 times, or let their connector send a garbage token. Each attempt makes Anthropic's backend send a failing `/token` or `/mcp` request from the shared egress. The owner's connector, calling from the same address, then gets `429` for 10 minutes, and the attacker can renew the block indefinitely.

**Fix:** the limiter now only refuses *failures*. A valid access token, authorization code or refresh token always works. Failures from a blocked address get `429` instead of `400`/`401`. `/register` and `/authorize` still refuse everything from a blocked address, since neither involves the owner's tokens.

### S2 · Medium · Funnel header trusted from any peer (fixed)

**Before:** `viaFunnel()` trusted `Tailscale-Funnel-Request` on any connection, and then took the client address from `X-Forwarded-For`. The server also listens on the tailnet IP.

**Exploit:** any tailnet peer (a compromised device, or a node shared into the tailnet) connects to `100.x.y.z:8794` directly. It sends the header with a fresh `X-Forwarded-For` on each request, so per-address limits never trigger, and it can write forged addresses into the auth log. It can also put failures on someone else's key, for example `X-Forwarded-For: 160.79.104.10` × 20, which combined with S1 locked out claude.ai.

**Fix:** the header counts only when the socket peer is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), which is where tailscaled connects from. Local processes remain trusted (S18).

### S3 · Medium · Unauthenticated amplification (fixed)

**Before:**
- A successful `/register` was never counted. Each one is a read → write → rename of `remote.json`, and 50 of them evict every DCR client without live tokens, such as a client whose owner is midway through consent.
- `/authorize?client_id=https://claude.ai/<random>` made one outbound fetch per distinct URL. Failures were cached only per URL, the cache held at most 100 entries, and `/authorize` wasn't rate-limited at all.
- The CIMD body was read in full before its 16 KB size check.
- The README also claimed that with `allowLoopbackRedirects: false` "a stranger can't register clients at all". That was wrong: `https://claude.ai/api/mcp/auth_callback` passes the allowlist.

**Exploit:** a loop of unauthenticated GETs turns the VM into a request generator against claude.ai and chatgpt.com. That can get the VM's IP rate-limited or blocked by those hosts' edge, which breaks the real CIMD lookups the owner's connectors need. A parallel loop of `/register` calls keeps the disk busy and evicts pending registrations.

**Fix:**
- `/register`: 10 per address per 10 min and 30 per hour in total.
- `/authorize`: an unknown or failing `client_id` counts as a failure, and blocked addresses get `429` before any fetch.
- CIMD: at most 60 fetches per 10 min in total. `client_id` must be a plain https path (no query, port, credentials, root path, or more than 300 characters). The body is streamed with a 16 KB cap and `Content-Length` pre-check, and failing responses are cancelled.
- The README sentence is corrected.

### S4 · Medium · Lost updates between server and CLI (fixed)

**Before:** `Store.update()` serialized writes inside one process only. `node src/remote.ts revoke` and the server's read → modify → write could interleave. A server write that had read the file before the revoke wrote the old token set back. The CLI still printed `revoked N token(s)`.

**Exploit:** an attacker holding a stolen token keeps the server writing, for example with unauthenticated `/register` calls before S3, each one a read-modify-write. The owner's incident response, `revoke`, has a real chance of landing inside a write window and being undone without any visible error. The same race can drop a fresh `approve` code.

**Fix:** every update takes an `O_EXCL` lock file (`remote.json.lock`) shared by both processes. A lock older than 10 s, left by a crashed writer, is broken. The tests reproduce both lost writes without the lock (checked by disabling it).

**Stale-lock race (fixed in #7):** two waiters that both found the stale lock could both break it: the second one's `unlink` removed the fresh lock the first had just taken, and both wrote. Now the waiters that judged one lock file stale race for a marker named after that file (device, inode and nanosecond mtime), created with `O_EXCL`; only the winner unlinks, and only after checking the lock path still holds that same file. A marker older than 10 s (its waiter died between the two steps) is taken over through the next `O_EXCL` marker, so a crash there can't wedge the lock. A holder's release removes the lock only while it is still the file it created. The regression test delays every `stat` of the lock at random so a stale answer arrives after another waiter has re-locked; the old code ran two writers at once there, the new one never does. What remains is the assumption the stale rule always had: a writer that stalls for more than 10 s inside its update is treated as dead.

### S5 · Low–medium · Approval code burn (fixed, with a residual)

**Before:** five wrong tries from anyone burned the pending code. Claude's CIMD `client_id` is public, so anyone could open a valid consent form.

**Exploit:** an attacker posts wrong codes every couple of minutes. Whenever the owner runs `approve`, the code dies before they can type it, which blocks onboarding.

**Fix:** five wrong tries per address lock that address out of the form for 10 min. The code burns only after 20 wrong tries from all addresses together. Brute force stays at about 20 guesses against 2⁴⁰.

**#7:** the global budget is the bound, and it is kept: however many addresses guess, a code gets at most 20 wrong tries, then it is gone and the owner makes a new one (`approve` or 승인 코드 만들기), which starts a fresh budget. The per-address limit now counts an IPv6 client by its /64, so rotating addresses inside one allocation no longer buys extra tries. The burning try is logged as `approval-burned`, so the owner's next "no pending code" has an explanation in the journal. A hand-edited `failures` that isn't a number used to never reach the limit; it now counts from 0.

**Residual (accepted):** an attacker with four or more IPv4 addresses or /64s can still burn a code. That costs the owner a retry, never access. Any scheme that bounds guesses globally can be exhausted by strangers; a global throttle instead of a burn would lock the owner out the same way.

### S6 · Low–medium · Refresh-token reuse (fixed)

**Before:** a rotated refresh token was deleted. A thief who used a stolen refresh token first kept the new token family, and the legitimate client's next refresh failed as ordinary garbage.

**Fix:** a rotated token is kept as `used` until it expires. If it is presented again more than 10 s after rotation, every token of that authorization is revoked and `refresh-reuse` is logged. Within 10 s it is only refused, so a client retrying a lost reply keeps its grant. This follows the OAuth 2.1 / security BCP refresh-token reuse detection for public clients.

### S7–S15 · Low (fixed)

- **S7:** `client_id` is now required at `/token` for both grants (OAuth 2.1 §3.2.2, public clients). Public clients must send it, and the smoke script does. claude.ai and ChatGPT haven't been checked against this build yet; if a real connector fails at `/token` with `client_id is missing`, this check is the first suspect. **#7:** kept as it is. A test now pins the expectation: a hosted client whose `client_id` is its CIMD URL (Claude's and ChatGPT's documented ids), exchanging form-encoded with `resource`, gets tokens and can refresh; without `client_id` the answer is `invalid_grant` with the description `client_id is missing or the code was issued to another client`, which is what to look for in a failing connector. Status: accepted pending the first live connection.
- **CIMD URL shape (from S3), watch item:** a CIMD `client_id` with a query string, a bare `/` path or more than 300 characters is now refused. ChatGPT's documented ids (`https://chatgpt.com/oauth/client.json`, `https://chatgpt.com/oauth/{callback_id}/client.json`) and Claude Code's (`https://claude.ai/oauth/claude-code-client-metadata`) pass. The hosted claude.ai id isn't published. If the first real claude.ai connection fails at `/authorize` with "client metadata URL must be a plain https path", relax the `?`/`#` check in `fetchClientMetadata`. **#7:** the shape is now stricter in one way: the id must already be in canonical URL form (`new URL(id).href === id`) and contain no `?` or `#` at all, so an empty query or fragment, dot segments, an upper-case host or a spelled-out `:443` are refused before any fetch (an empty `?` used to pass, because it leaves `u.search` empty). A test lists the refused shapes and checks that the documented ids are fetched exactly as given. Still a watch item until claude.ai's hosted id is seen.
- **S8:** `resolveClient` used `s.clients[id]`, so `client_id=constructor` returned `Object` and crashed on `redirectUris.length`, giving a 500. It now uses `Object.hasOwn`.
- **S9:** a prefix `https://x.example` admitted `https://x.example.evil/…`. Matching is now by origin plus whole path segments. Production's list is empty.
- **S10:** policy flags count only when they are literally `true`. List settings that aren't arrays are ignored.
- **S11:** `publicUrl` read at start is pinned for the issuer and token audience. This is consistent with the Host allowlist, which already needed a restart. ~~**Residual:** with no file at all, `allowLoopbackRedirects` still defaults to `true`, as documented for local setups.~~ **#7:** unset (no file, or the key left out), loopback redirects are now accepted only for requests that didn't come through Funnel. A flat `false` default would have broken the documented local flows (Claude Code against `http://127.0.0.1:8794`, `scripts/remote-smoke.ts` run before going public, which registers a loopback client before any file exists), and the risk was only ever from the internet. A literal `true` still allows them through Funnel (Claude Code on the public URL), `false` still refuses them everywhere, and anything else (`"true"`) counts as unset.
- **S12:**
  - `ensurePrivate()` now also sets the folder to 700. **On the next production start this changes `~/.config/portboard` from 775 to 700.** Group `dev` has no other members, so the old mode wasn't exploitable today.
  - Temp files get a random name and are created with `O_EXCL`, so a link planted at the old `remote.json.<pid>.tmp` path no longer receives the state.
- **S13:** tool names in the log are cut to 64 characters.
- **S14:** `/srv`, `/opt`, `/var`, `/tmp`, `/mnt`, `/media`, `/data`, `/etc`, `/usr`, `/run`, `/snap` and `/proc` paths in text become `[path]`. URL paths are left alone. Port names can carry them through a unit description, an HTTP title ("Index of /srv/…") or a `tailscale serve` path upstream.
- **S15:** `server.maxConnections = 256` per listener. Funnel puts every internet client on loopback, and the existing header and request timeouts (10 s / 30 s) bound slowloris.

### S16–S19 · Accepted

- **S16, consent phishing:** an attacker adds this server to *their own* claude.ai or ChatGPT account and sends the owner the resulting consent link. If the owner runs `approve` and types the code, the attacker's account gets read access for 30 days. The page can't tell the two claude.ai users apart: same client, same callback. This is inherent to OAuth with hosted public clients. The consent page now says to approve only a flow you started yourself. `node src/remote.ts status` and `revoke <client_id>` remain the remedy.
- **S17, Origin:** `originAllowed` compares the Origin's host name only, so a page on `http://localhost:<any>` or on another port of the tailnet name passes. No CORS headers are sent, so such a page can't read responses. The only state-changing form, the consent form, needs the approval code.
- **S18, local processes:** a process on the VM can still send `Tailscale-Funnel-Request` with any `X-Forwarded-For`. It runs where `remote.json` lives anyway.
- **S19, `redirect_uri` at `/token`:** still checked when sent, not required. PKCE binds the code to the client that started the flow, and `iss` on every redirect defends against mix-up. Requiring it could break a client that omits it and adds no protection here.

## Follow-up (#7)

The leftovers of this review and of the v1.0 dashboard review, closed or given a status in c10dev/portboard#7.

| Item | Status | What changed or why not |
|---|---|---|
| S4 stale-lock race between two waiters | Fixed | `O_EXCL` marker per stale lock file; release checks it still owns the lock. See S4 |
| S5 approval-code burn from ≥4 addresses | Fixed in part; residual accepted | Global 20-try budget kept as the bound; IPv6 per /64; `approval-burned` logged. See S5 |
| S7 `client_id` at `/token` vs. claude.ai / ChatGPT | Accepted pending a live check | Behaviour kept; expectation tested; error text documented |
| S11 `allowLoopbackRedirects` defaulting to `true` without remote.json | Fixed | Unset means local and tailnet only, never through Funnel |
| CIMD URL shape (watch item) | Tightened, still watched | Canonical form, no `?`/`#`; documented ids tested |
| Funnel port in this document | Fixed | 443 (was 8443 at review time) |
| Dashboard: the whole tailnet could read the audit log | Fixed | `GET /api/audit` is the owner's only ([security.md](../security.md#audit-log-c10devportboard30)) |
| Dashboard: loopback has no token | Accepted | One login user on the machine; every local process already is the owner ([security.md](../security.md#open-items)) |

**v1.0 dashboard review items L2, I3, I5, I6, I7 and I9:** status not recorded in the public tree. The v1.0 review document (`docs/security-review/v1.0.md`) is not in this repository, and neither the code, the tests nor the CHANGELOG name these ids. What the tree does record: M1, M2, L1, L3, L4, L5, L6, I1, I2, I4, I8 and I10 are fixed (CHANGELOG 1.x Security section, `test/security-access.test.ts`, `test/security-misc.test.ts`, and comments in `src/`). Nothing in the code can be tied to the six unrecorded ids without the review text, so no status is claimed for them here.

## Widening (#8): worktrees, dev servers and memory

c10dev/portboard#8 adds three read-only tools to the remote set: `list_worktrees`, `list_dev_servers` and `memory_usage`. Their writes (`remove_worktrees`, `start_dev_server`, `stop_dev_server`) stay local only. What each exposes, field by field, is in the [README's allowlist](README.md#tools-allowlist).

| Question | Answer |
|---|---|
| What is new on the internet side? | Repository and branch names, PR numbers and states, which worktrees have uncommitted changes and their sizes; which dev servers run on which port, by `<repo>@<branch>`; memory, swap and PSI numbers, the pressure state, group sizes, session counts, CLI versions, service and container names (already in `list_ports`) and their sizes. Branch names can say what is being worked on: that is the main new disclosure. |
| What stays out? | Every path (worktree, repo, `~`, a dev server's working directory, and the unit name made from it), commit messages and ids, git remote URLs (they can hold credentials), unit descriptions, `package.json` command text, pids, session ids, scan error texts. No flag adds them. Session titles and projects, MCP server and other process names and the memory suggestion texts only with `showProcesses`. |
| Does the remote process do more work? | No scans. `list_worktrees` reads `worktrees-state.json`, which the dashboard's scan job now writes after every scan (0600, atomic), and has no `refresh` argument remotely (a forced scan from the internet would be an amplification lever); `memory_usage` reads `memory-state.json` and answers "no recent sample" rather than reading `/proc` and transcripts. `list_dev_servers` runs the same `systemctl --user list-units/show`, `git worktree list` and `package.json` reads as `GET /api/dev-servers`, cached 2 s like the other sources. |
| Layer 3 | `readOnlyCore` still refuses `worktrees`, `devServers` and `memory`; `REMOTE_READS` is unchanged. The remote tools read them from `RemoteCore`, whose new methods are optional: a core without them answers `<tool> is not available here`. `test/security-misc.test.ts` I1 checks that a `RemoteCore` that has them doesn't leak them through `readOnlyCore`. |
| Tests | `test/remote-redact.test.ts` (#8 fixtures with home and system paths, a credentialed remote URL, commit messages, IPs in script commands, session titles; strict and loose policies), `test/remote-tools.test.ts` (listed read-only, missing methods fail closed, `refresh` refused, the three writes refused before the core), `test/registry.test.ts` (the pinned set), `test/memory.test.ts` and `test/worktrees.test.ts` (the saved-state readers). |

## Widening: machine_status

This adds one read-only tool to the remote set: `machine_status`, the multi-machine view ([multi-host.md](../multi-host.md#machines-machine_status-and-where_to_run)). `find_worktree` and `where_to_run` stay local only. Field by field, what it exposes is in the [README's allowlist](README.md#tools-allowlist).

| Question | Answer |
|---|---|
| What is new on the internet side? | The other machines exist and what they are: their names (host names from `portboard.json` agents and the tailnet), kinds, whether they are online, how old their data is and the error kind; their load (cores, load average, memory, disk free, uptime); Claude Code session counts with CLI version and per session idle time, CPU and memory; their checkouts as `repo@branch` with changed yes/no, in use, ahead/behind and the reserved port; port counts; capabilities and tags; `maxSessions`; which ways a session can be opened there. Machine names and branch names on machines other than the server are the main new disclosure; branch names were already shown for the server itself by `list_worktrees`. |
| What stays out? | Session ids (they name the transcript file and are what `--resume` takes), every path (shared or not), git remote URLs and the GitHub owner/name, last commit dates, uncommitted file counts, the tailnet device id, the launch note texts (they name the SSH target), agent URLs and tokens (never in the list). No flag adds them. A session's project and `repo@branch` only with `showProcesses`, as `memory_usage`'s titles and projects. |
| Does the remote process do more work? | No. It reads `machines-state.json` (cached 2 s), which the dashboard server now writes each time it reads its agents (0600, atomic). `fresh` is refused remotely: a remote call can never make the server contact an agent, so there is no amplification toward other machines. With no saved list it answers an empty list and a note, and a list older than 10 min comes with a note. `stale` is recomputed from the read time, so an old file can't present itself as fresh. |
| Layer 3 | `readOnlyCore` still refuses `machines` and `REMOTE_READS` is unchanged. The tool reads the list from the new optional `RemoteCore.machines`; a core without it answers `machine_status is not available here`. `test/security-misc.test.ts` I1 now includes `machines`. |
| Tests | `test/remote-redact.test.ts` (a fixture with home paths in shared paths and session cwds, full session ids, a git remote, a tailnet id, launch notes and commit dates; strict and loose policies), `test/remote-tools.test.ts` (the remote schema has only `machine` and `include`, a missing method fails closed, `fresh` and bad arguments refused before the core, the old-list note, `find_worktree` and `where_to_run` unknown), `test/registry.test.ts` and `test/remote-http.test.ts` (the pinned set), `test/machines.test.ts` (the saved-list reader drops malformed rows and fails to null). |

## Checked and found sound

| Area | Result |
|---|---|
| Redirect URIs | Exact set match, anchored ChatGPT regex (`[A-Za-z0-9_-]{1,200}$`), userinfo/fragment refused, WHATWG parsing (backslash → path, `@` → userinfo refused). Registered URI must match exactly at `/authorize`. Errors before the redirect URI is trusted are shown as a page, never redirected: no open redirect. |
| PKCE | S256 only at `/authorize`; `plain` → `invalid_request`. Verifier syntax checked (43–128 unreserved) and hashed at `/token`. |
| Codes | 256-bit, in memory, single use (deleted before any check), 60 s, bound to client, redirect URI, challenge and resource. The map only grows on approved consents. |
| Tokens | Opaque 256-bit, stored as SHA-256, bound to `<issuer>/mcp`, 1 h access / 30 d refresh with rotation. `revoke` drops them. |
| CIMD SSRF | Only https on `claude.ai`, `claude.com`, `chatgpt.com`, no port, `redirect: 'error'`, 5 s timeout. DNS is the public resolution of those three names; no user-chosen hosts. |
| Host / DNS rebinding | Host must be a name this machine answers to (421 otherwise). With `publicUrl` set, the Host header never reaches the issuer. |
| Request parsing | 64 KB `/mcp`, 8 KB OAuth bodies, enforced while streaming (chunked bodies included). Batches of 1–20. 20 s per message. `headersTimeout` 10 s, `requestTimeout` 30 s, 64 headers. V8's JSON parser handles 32k-deep nesting, and deep arrays in a batch are answered as notifications. |
| Allowlist | `tools/list` and `tools/call` answer from `REMOTE_TOOL_NAMES` before touching the core. Other methods go to the shared dispatcher, which handles only `initialize`/`ping`/`tools/*` and returns `null` for notifications without running them. `readOnlyCore` throws on writes and logs. `src/remote.ts` imports no write function. The core's newer `history`, `setClientName` and `setAlert` methods are not reachable. **Changed after this review (#16):** the remote now answers `resources/*` and `prompts/*` itself (status resource and two prompts only) and delegates only `ping` and notifications, because the shared dispatcher gained an unredacted `resources/read`. See the README's resources and prompts allowlist. **Changed after this review (#21):** the lists are no longer hard-coded in `src/remote/tools.ts`. Each feature module marks the tools, resources and prompts it offers remotely (`src/features/*`), `buildRegistry()` refuses to mark a tool that isn't `readOnlyHint: true`, remote handlers receive only a `RemoteCore` (`src/remote/core.ts`), and `test/registry.test.ts` pins the exact remote set, so widening it means changing that test. **Widened (#8):** `list_worktrees`, `list_dev_servers` and `memory_usage`, see [Widening (#8)](#widening-8-worktrees-dev-servers-and-memory). **Widened:** `machine_status`, see [Widening: machine_status](#widening-machine_status). |
| Redaction | Projection-only output plus a scrub over every string. Checked live on this VM: `list_ports` (with system ports), `list_devices` and `who_uses_what` contain no IPv4/MAC/home or system path/pid/ssh/cmdline/credential match. Per-host `listening` data, Proxmox fields, alert config and usage history are never copied. |
| Logging | Reasons, client names and addresses only. No token, code, approval code or verifier is logged; tests assert this. Values are JSON-encoded, so there is no log-line injection. |
| `remote.json` | Mode 600, atomic rename, hashes only. Corrupt JSON makes every request fail with 500 (fails closed) and is never overwritten. A missing file means no clients or tokens. |
| Timing | The approval-code hash is compared with `timingSafeEqual`. Tokens and codes are looked up by hash or map key, which gives no useful timing signal for 256-bit secrets. |
| Consent page | Everything escaped, CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `form-action` limited to self and the redirect origin, `Referrer-Policy: no-referrer`. A cross-site POST carries an Origin and is refused with 403. |

## Verification

- `npm test`: all 146 tests pass, including 20 new ones in `test/remote-security.test.ts`.
- `scripts/remote-smoke.ts` passed against a separate instance: `PORTBOARD_REMOTE_PORT=8796 PORTBOARD_REMOTE_HOSTS=127.0.0.1 PORTBOARD_REMOTE_CONFIG=<scratch>/remote.json`, with loopback redirects on. It covered discovery, DCR, consent, PKCE, every tool, the `stop_service` refusal, refresh rotation and revoke.
- Production (`portboard-remote`, Funnel, `~/.config/portboard/remote.json`) was not modified. It was only read, apart from the one probe request above.

### #7

- `npm test` with the new tests: `remote-security` S4 (two waiters on one stale lock, a dead breaker, release ownership), S5 (/64 key, global burn and re-issue, store counting), S7 (hosted-client token exchange), S11 (loopback redirects by request path and flag), CIMD shape; `access` (audit read is the owner's only). The S4 race test fails on the previous lock code.
- Not checked live: claude.ai and ChatGPT against `client_id` at `/token`, and claude.ai's hosted CIMD id.

## Deploying

No config change is needed. After merging, restart `portboard-remote`. Expect one start-up line saying `~/.config/portboard` was set to 700 (S12).
