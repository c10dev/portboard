# Remote MCP security review (2026-10-17)

Scope: the read-only remote MCP server (`src/remote.ts`, `src/remote/*`) as it runs in production: public through Tailscale Funnel at `https://devbox.example.ts.net:8443/mcp` → `127.0.0.1:8794`. It was reviewed from an internet attacker's position, then from a tailnet peer and a local process. Issue: c10dev/portboard#3.

**Verdict:** nothing critical, and nothing that leaks data or grants access right now. Production's `remote.json` has `publicUrl` set, `allowLoopbackRedirects: false`, no clients and no tokens. The findings are availability problems, integrity problems in incident response (`revoke`) and hardening. All findings rated medium are fixed on branch `remote-security`, along with the cheap low ones.

Live check: one request with a forged `X-Forwarded-For: 6.6.6.6` and `Tailscale-Funnel-Request` was sent to the public URL with a bogus token. Production logged the real address (`auth-fail ip="funnel:220.120.72.160"`, the VM's own egress), so tailscaled overwrites a client-supplied `X-Forwarded-For`. That one `auth-fail` line in the production journal is from this review.

## Findings

Severity is for this deployment (single owner, Funnel on 8443, dashboard tailnet-only).

| ID | Severity | Finding | Status | Test |
|---|---|---|---|---|
| S1 | Medium | The failure limiter blocks valid credentials from shared egress addresses | Fixed | `remote-security` S1 |
| S2 | Medium | `Tailscale-Funnel-Request` was trusted from any socket, including tailnet peers | Fixed | `remote-security` S2 |
| S3 | Medium | Unauthenticated amplification: unlimited `/register` writes and CIMD fetches | Fixed | `remote-security` S3 (×4) |
| S4 | Medium | Server and CLI wrote `remote.json` without a shared lock, so `revoke` could be silently undone | Fixed | `remote-security` S4 (×3) |
| S5 | Low–medium | Anyone could burn the owner's pending approval code with 5 tries | Fixed (residual: ≥4 addresses) | `remote-http` "wrong approval codes…" |
| S6 | Low–medium | No refresh-token reuse detection | Fixed | `remote-security` S6 (×2) |
| S7 | Low | `/token` accepted requests without `client_id` | Fixed | `remote-security` S7 |
| S8 | Low | `client_id=__proto__` / `constructor` reached a crash path (500) | Fixed | `remote-security` S8 |
| S9 | Low | `extraRedirectPrefixes` matched by raw string prefix | Fixed | `remote-security` S9 |
| S10 | Low | Hand-edited config values: `"showAddresses": "false"` loosened redaction; a string `allowedOrigins` matched substrings | Fixed | `remote-security` S10 |
| S11 | Low | The issuer fell back to the Host header if `remote.json` lost `publicUrl` at runtime | Fixed (issuer pinned at start) | `remote-security` S11 |
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

**Fix:** every update takes an `O_EXCL` lock file (`remote.json.lock`) shared by both processes. A lock older than 10 s, left by a crashed writer, is broken. The tests reproduce both lost writes without the lock (checked by disabling it). **Known gap:** if two waiters both find a stale lock, the second can delete the first's fresh lock. That needs a crashed writer first, so it isn't fixed.

### S5 · Low–medium · Approval code burn (fixed, with a residual)

**Before:** five wrong tries from anyone burned the pending code. Claude's CIMD `client_id` is public, so anyone could open a valid consent form.

**Exploit:** an attacker posts wrong codes every couple of minutes. Whenever the owner runs `approve`, the code dies before they can type it, which blocks onboarding.

**Fix:** five wrong tries per address lock that address out of the form for 10 min. The code burns only after 20 wrong tries from all addresses together. Brute force stays at about 20 guesses against 2⁴⁰. **Residual:** an attacker with four or more addresses (IPv6 makes this cheap) can still burn codes. That costs the owner a retry, never access.

### S6 · Low–medium · Refresh-token reuse (fixed)

**Before:** a rotated refresh token was deleted. A thief who used a stolen refresh token first kept the new token family, and the legitimate client's next refresh failed as ordinary garbage.

**Fix:** a rotated token is kept as `used` until it expires. If it is presented again more than 10 s after rotation, every token of that authorization is revoked and `refresh-reuse` is logged. Within 10 s it is only refused, so a client retrying a lost reply keeps its grant. This follows the OAuth 2.1 / security BCP refresh-token reuse detection for public clients.

### S7–S15 · Low (fixed)

- **S7:** `client_id` is now required at `/token` for both grants (OAuth 2.1 §3.2.2, public clients). Public clients must send it, and the smoke script does. claude.ai and ChatGPT haven't been checked against this build yet; if a real connector fails at `/token` with `client_id is missing`, this check is the first suspect.
- **CIMD URL shape (from S3), watch item:** a CIMD `client_id` with a query string, a bare `/` path or more than 300 characters is now refused. ChatGPT's documented ids (`https://chatgpt.com/oauth/client.json`, `https://chatgpt.com/oauth/{callback_id}/client.json`) and Claude Code's (`https://claude.ai/oauth/claude-code-client-metadata`) pass. The hosted claude.ai id isn't published. If the first real claude.ai connection fails at `/authorize` with "client metadata URL must be a plain https path", relax the `u.search` check in `fetchClientMetadata`.
- **S8:** `resolveClient` used `s.clients[id]`, so `client_id=constructor` returned `Object` and crashed on `redirectUris.length`, giving a 500. It now uses `Object.hasOwn`.
- **S9:** a prefix `https://x.example` admitted `https://x.example.evil/…`. Matching is now by origin plus whole path segments. Production's list is empty.
- **S10:** policy flags count only when they are literally `true`. List settings that aren't arrays are ignored.
- **S11:** `publicUrl` read at start is pinned for the issuer and token audience. This is consistent with the Host allowlist, which already needed a restart. **Residual:** with no file at all, `allowLoopbackRedirects` still defaults to `true`, as documented for local setups.
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
| Allowlist | `tools/list` and `tools/call` answer from `REMOTE_TOOL_NAMES` before touching the core. Other methods go to the shared dispatcher, which handles only `initialize`/`ping`/`tools/*` and returns `null` for notifications without running them. `readOnlyCore` throws on writes and logs. `src/remote.ts` imports no write function. The core's newer `history`, `setClientName` and `setAlert` methods are not reachable. **Changed after this review (#16):** the remote now answers `resources/*` and `prompts/*` itself (status resource and two prompts only) and delegates only `ping` and notifications, because the shared dispatcher gained an unredacted `resources/read`. See the README's resources and prompts allowlist. **Changed after this review (#21):** the lists are no longer hard-coded in `src/remote/tools.ts`. Each feature module marks the tools, resources and prompts it offers remotely (`src/features/*`), `buildRegistry()` refuses to mark a tool that isn't `readOnlyHint: true`, remote handlers receive only a `RemoteCore` (`src/remote/core.ts`), and `test/registry.test.ts` pins the exact remote set, so widening it means changing that test. |
| Redaction | Projection-only output plus a scrub over every string. Checked live on this VM: `list_ports` (with system ports), `list_devices` and `who_uses_what` contain no IPv4/MAC/home or system path/pid/ssh/cmdline/credential match. Per-host `listening` data, Proxmox fields, alert config and usage history are never copied. |
| Logging | Reasons, client names and addresses only. No token, code, approval code or verifier is logged; tests assert this. Values are JSON-encoded, so there is no log-line injection. |
| `remote.json` | Mode 600, atomic rename, hashes only. Corrupt JSON makes every request fail with 500 (fails closed) and is never overwritten. A missing file means no clients or tokens. |
| Timing | The approval-code hash is compared with `timingSafeEqual`. Tokens and codes are looked up by hash or map key, which gives no useful timing signal for 256-bit secrets. |
| Consent page | Everything escaped, CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `form-action` limited to self and the redirect origin, `Referrer-Policy: no-referrer`. A cross-site POST carries an Origin and is refused with 403. |

## Verification

- `npm test`: all 146 tests pass, including 20 new ones in `test/remote-security.test.ts`.
- `scripts/remote-smoke.ts` passed against a separate instance: `PORTBOARD_REMOTE_PORT=8796 PORTBOARD_REMOTE_HOSTS=127.0.0.1 PORTBOARD_REMOTE_CONFIG=<scratch>/remote.json`, with loopback redirects on. It covered discovery, DCR, consent, PKCE, every tool, the `stop_service` refusal, refresh rotation and revoke.
- Production (`portboard-remote`, Funnel, `~/.config/portboard/remote.json`) was not modified. It was only read, apart from the one probe request above.

## Deploying

No config change is needed. After merging, restart `portboard-remote`. Expect one start-up line saying `~/.config/portboard` was set to 700 (S12).
