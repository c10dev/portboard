# Remote MCP (read-only) for claude.ai and ChatGPT

`src/remote.ts` serves Portboard as a **read-only** MCP server over Streamable HTTP with its own small OAuth 2.1 authorization server, so claude.ai custom connectors and ChatGPT can query it. It is a separate process on its own port (8794). It listens on loopback and the Tailscale IP only. **It is not on the internet until someone runs the Funnel command in [Going public](#going-public-not-done).** That step needs the owner's approval.

```
node src/remote.ts                 # serve on 127.0.0.1:8794 and the tailnet IP (PORTBOARD_REMOTE_PORT, PORTBOARD_REMOTE_HOSTS)
node src/remote.ts approve         # one-time approval code for the consent page (10 min, single use)
node src/remote.ts status          # clients, live tokens, pending code — never the secrets
node src/remote.ts revoke [id]     # drop all tokens, or one client's tokens and registration
                                   # (or per client / per authorization from the dashboard: 설정 tab → 원격 커넥터)
node scripts/remote-smoke.ts [url] # end-to-end check (discovery → OAuth → every tool, resource and prompt → refresh → revoke)
```

| File | Role |
|---|---|
| `src/remote.ts` | entry point and CLI; binds loopback + tailnet, refuses wildcard addresses |
| `src/remote/http.ts` | Streamable HTTP transport and OAuth endpoints (a handler factory, tested on port 0) |
| `src/remote/oauth.ts` | metadata documents, redirect allowlist, CIMD fetch, PKCE, consent page |
| `src/remote/tools.ts` | the remote JSON-RPC surface: lists and dispatches what the feature modules mark remote (`src/features/*`), wrapping `src/mcp/rpc.ts` |
| `src/remote/core.ts` | `RemoteCore` (what the remote may read) and `readOnlyCore()` (writes and logs throw) |
| `src/remote/redact.ts` | what may leave the tailnet (projection + scrub) |
| `src/remote/store.ts` | `~/.config/portboard/remote.json` (mode 600, hashes only); records an access token's last use at most once a minute |
| `src/remote/admin.ts` | the dashboard's view of that file (derived `c-…`/`g-…` ids, no secrets) and its revokes (#31); served by `src/features/remote-connector.ts` on the dashboard only |
| `src/remote/guard.ts` | Host / Origin checks, Funnel client address, failure rate limiter, auth log |
| `deploy/portboard-remote.service` | systemd user unit, **not installed** |

## What the clients need (researched 2026-10-17)

### claude.ai custom connectors

- **Transport:** Streamable HTTP is recommended. Legacy HTTP+SSE still works but is being deprecated. ([building](https://claude.com/docs/connectors/building))
- **Auth:**
  - Available to everyone: `none`, OAuth with Dynamic Client Registration, and OAuth with Client ID Metadata Documents (CIMD).
  - In the dialog you can also paste your own client ID and secret.
  - Static bearer headers are a limited beta, so they aren't an option for us.
  - Claude uses CIMD only when the AS metadata has `client_id_metadata_document_supported: true` and lists `none` in `token_endpoint_auth_methods_supported`. Otherwise it uses DCR.
  - ([authentication](https://claude.com/docs/connectors/building/authentication))
- **Discovery:**
  - The first unauthenticated request must get a `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - The PRM `resource` must equal the URL the user typed, path included.
  - Only the first `authorization_servers` entry is used.
  - PKCE S256 is always required.
  - The token endpoint must take form encoding, rotate refresh tokens, and answer within 10 s.
- **Callback:** `https://claude.ai/api/mcp/auth_callback`. `https://claude.com/api/mcp/auth_callback` is unconfirmed but allowlisted. Claude Code uses loopback redirects.
- **Where calls come from:** Anthropic's cloud, not the browser. Egress `160.79.104.0/21` ([IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)).
- **Plans and UI:** Free (one connector), Pro, Max, Team and Enterprise.
  - Pro/Max: Customize → Connectors → Add custom connector.
  - Team/Enterprise: an Owner adds it under Organization settings → Connectors.
  - Auth settings can't be edited later; you remove the connector and add it again.
  - ([add custom connector](https://claude.com/docs/connectors/custom/add-unlisted), [support article](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp))

### ChatGPT (developer mode / custom MCP server)

- **Transport:** Streamable HTTP at a public HTTPS `…/mcp` URL. SSE for custom servers is unconfirmed. ([connect](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/))
- **Auth:**
  - Options are none, OAuth 2.1, or mixed per tool.
  - ChatGPT cannot send custom API keys, so a static bearer token doesn't work.
  - Client registration: CIMD preferred (`https://chatgpt.com/oauth/client.json`), DCR still supported.
  - It sends `resource` on both authorize and token. S256 must be advertised.
  - ([auth](https://developers.openai.com/apps-sdk/build/auth))
- **Redirect:**
  - `https://chatgpt.com/connector_platform_oauth_redirect`, used when the AS advertises `authorization_response_iss_parameter_supported` and returns `iss` on every response.
  - Otherwise a per-connection `https://chatgpt.com/connector/oauth/{id}`.
- **Egress IPs:** https://openai.com/chatgpt-connectors.json. It changes, so OpenAI says to refresh it automatically.
- **Plans: unconfirmed.**
  - At the September 2025 launch, Plus and Pro got full developer mode.
  - Later help-center text says full MCP is Business/Enterprise/Edu only, and Pro is read/fetch.
  - Check in the account. Portboard is read-only, so it fits either way.
- **UI:** the current path is chatgpt.com → Plugins/Apps → + → Add custom MCP server (older: Settings → Apps & Connectors → Advanced → Developer mode → Create).
- **`search` / `fetch` tools:** only needed for deep research and company knowledge, so not added.

### MCP spec

The 2026-07-28 revision makes CIMD a SHOULD and deprecates DCR (kept for compatibility) ([client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)). Neither client documents support for the 2026-07-28 handshake yet. This server speaks `initialize` with 2025-11-25 / 2025-06-18 / 2025-03-26.

## Auth: what was built and why

**OAuth 2.1 + PKCE, single user, with a one-time approval code.** This is the only option both clients accept that isn't anonymous:
- ChatGPT has no static-key option.
- claude.ai offers static headers only as a limited beta.
- A secret URL path would be the fallback, but it ends up in client configs, browser history and logs, and it can't be revoked per client.

- **Discovery:**
  - `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728).
  - `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (RFC 8414 document).
  - Advertised: `S256` only, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`.
- **Clients:** both need to be public clients (no secret).
  - **CIMD:** a `client_id` that is an `https://` URL on `claude.ai`, `claude.com` or `chatgpt.com` (with a path, no query, port or credentials) is fetched with no redirects, a 16 KB streaming cap and a 5 s timeout. It must contain `client_id` equal to its own URL, and it is cached for 10 min. URLs on other hosts are never fetched (no SSRF). An unknown `client_id` counts as a failure for the requester's address, and all requesters together get at most 60 fetches per 10 min, so nobody can use this server to hammer those hosts.
  - **DCR** (`/register`): registrations are persisted, at most 50. The least recently used client without live tokens is evicted. Registering is limited to 10 per address per 10 min and 30 per hour in total.
  - **Redirect URIs:** must match the allowlist below in both cases. A stranger can register a client, but can't get a code delivered anywhere but claude.ai, chatgpt.com or loopback.
    - `https://claude.ai/api/mcp/auth_callback`
    - `https://claude.com/api/mcp/auth_callback`
    - `https://chatgpt.com/connector_platform_oauth_redirect`
    - `https://chatgpt.com/connector/oauth/<id>`
    - `http://127.0.0.1:*`, `http://localhost:*` (Claude Code, MCP inspector; `allowLoopbackRedirects: false` turns this off)
    - `extraRedirectPrefixes` from remote.json, matched by origin and whole path segments (`https://x.example/cb` admits `/cb` and `/cb/…`, not `https://x.example.evil/` or `/cbx`)
- **Consent (`/authorize`):**
  - The page names the client and its redirect host, says what is and isn't shared, and asks for an **approval code**.
  - You make the code on the dashboard's 설정 tab (**승인 코드 만들기**, `POST /api/remote/approval-code`: owner only, audited without the code, tailnet only) or on the server with `node src/remote.ts approve`; the consent page links the tab (its https address from `tailscale serve status`, or `PORTBOARD_DASHBOARD_URL`). 8 characters of Crockford base32 (~40 bits), valid 10 minutes, single use.
  - Only its SHA-256 is stored. Five wrong tries lock that address out of the form for 10 min; twenty wrong tries from all addresses together burn the code.
  - The page tells the owner to approve only a flow they started themselves: approving a link someone else sent hands that person's claude.ai or ChatGPT account the access.
  - Errors before the redirect URI is trusted are shown as a page and never redirected. Every redirect carries `state` and `iss`.
  - The page sends `frame-ancestors 'none'`, `X-Frame-Options: DENY` and a CSP limiting `form-action` to itself and the client's redirect origin.
  - It has no CSRF token, because a forged POST would still need the approval code.
- **Codes and tokens:**
  - Authorization codes live in memory for 60 s, are single use, and are bound to the client, redirect URI, PKCE challenge and resource.
  - Access tokens are opaque 256-bit, last 1 h, and are bound to `<base>/mcp` (a token minted for `http://127.0.0.1:8794` doesn't work on another name).
  - Refresh tokens last 30 days and rotate on every use. A rotated token is kept as `used` until it would have expired: presenting it again more than 10 s after rotation revokes every token of that authorization (reuse detection). Within 10 s it is only refused, so a client retrying a lost reply doesn't lose its grant.
  - `/token` requires `client_id` for both grants.
  - `remote.json` holds SHA-256 hashes only and is written atomically (unpredictable temp name, `O_EXCL`) with mode 600, under a lock file (`remote.json.lock`) shared by the server and the CLI, so `revoke` can't be undone by a server write in flight. The server tightens the file to 600 and its folder to 700 at start if they were looser.
  - The issuer is read from `publicUrl` once at start and pinned; editing or deleting the file at runtime doesn't move it.
- **Rate limit and log:**
  - Failures are counted per client address: bad or expired token, wrong approval code, bad code/PKCE/refresh, an unknown client on `/authorize`, a disallowed redirect at registration.
  - 20 failures in 10 min → that address gets `429` with `Retry-After` for further *failures* on `/mcp` and `/token`, and for everything on `/register` and `/authorize`. A valid access token, code or refresh token always works: claude.ai and ChatGPT call from shared egress addresses, and anyone could otherwise get the owner's connector locked out by making their own connector fail from the same address.
  - Behind Funnel the address comes from `X-Forwarded-For`, trusted only when tailscaled's `Tailscale-Funnel-Request` header is present **and** the connection comes from loopback (where tailscaled connects from). tailscaled overwrites a client-supplied `X-Forwarded-For` (checked on the live Funnel). A tailnet peer talking to the tailnet listener directly can't spoof the header; local processes still can.
  - Every failure, registration, approval, token grant and tool call is one stderr line (`journalctl --user -u portboard-remote…`), with reasons and client names but never tokens or codes.

Why a CLI code and not a button on the dashboard: Funnel traffic arrives on 127.0.0.1 just like local traffic. So a "tailnet-only" approval page would have to trust a header to tell them apart. The CLI avoids that decision. A dashboard button can come later, gated on the request arriving on the tailnet listener without `Tailscale-Funnel-Request`.

## Transport

- **POST `/mcp`:**
  - Takes one JSON-RPC message or a batch of up to 20. Notifications and responses alone get `202`.
  - The reply is `application/json`, or a single `event: message` SSE frame when the client accepts only `text/event-stream`.
  - Stateless: no `Mcp-Session-Id`.
- **GET and DELETE `/mcp`:** `405`. There is no server-initiated stream.
- **`MCP-Protocol-Version`:** an unknown value gets `400`.
- **Host:** must be a name this machine answers to (`localhost`, `127.0.0.1`, the hostname, the tailnet name and IPs, and the host of `publicUrl`). Anything else gets `421`.
- **Origin:**
  - Absent: allowed (claude.ai and ChatGPT call server to server).
  - Present: it must be one of those hosts or listed in `allowedOrigins`, else `403`. `null` is refused.
  - No CORS headers are sent. Browser-based MCP clients from other origins need `allowedOrigins` and would still lack CORS, by design.
- **Limits:**
  - Bodies: `/mcp` 64 KB, OAuth endpoints 8 KB (`413`).
  - `headersTimeout` 10 s, `requestTimeout` 30 s, keep-alive 5 s.
  - 20 s per JSON-RPC message (`-32603 timed out`).
  - Snapshot, devices and usage are cached for 2 s.

## Tools: allowlist

| Remote tool | Source | Notes |
|---|---|---|
| `list_ports` | `src/features/ports.ts` | redacted projection of `summarize()` |
| `list_devices` | `src/features/devices.ts` | redacted projection of `devices()` |
| `free_port` | `src/features/free-ports.ts` | shared validation; returns port numbers only |
| `who_uses_what` | `src/features/usage.ts` (remote only) | the 기기 tab / 사용 중 data, optional `port` filter |

A feature module offers a tool remotely with `remote: { description, call }` next to the local definition; the remote `call` gets a `RemoteCore` and must redact. `buildRegistry()` refuses a remote tool that isn't `readOnlyHint: true`, and `test/registry.test.ts` pins the set above.

Not available remotely: `expose_port`, `unexpose_port`, `restart_service`, `stop_service`, `tail_logs` (logs can contain tokens), and label/pin/hide or device-name writes (they were never MCP tools). Three independent layers:
1. `tools/list` returns only `REMOTE_TOOLS` (the registry's remote tools). All are annotated `readOnlyHint: true` and their descriptions are rewritten so they don't mention the hidden tools.
2. `tools/call` refuses any name not in `REMOTE_TOOL_NAMES` **before touching the core**, with the same `-32602 unknown tool: <name>` as a tool that doesn't exist.
3. The `Core` handed to shared code (`readOnlyCore`) has `expose / unexpose / restart / stop / logs` that throw. `src/remote.ts` imports only `snapshot`, `freePorts`, `devices`, `topology` and `usage` from the core, plus two readers for the status resource: the alert checker's `status()` (never started) and `loadKnown()`.

`initialize` returns its own read-only `instructions`; the stdio server's instructions point at write tools.

## Resources and prompts: allowlist

`initialize` advertises `resources: {}` and `prompts: {}` (no subscriptions, no list-changed). Clients that ignore them are unaffected.

| Method | Remote answer |
|---|---|
| `resources/list` | `portboard://status` only |
| `resources/templates/list` | empty: `portboard://port/{port}` and `portboard://device/{id}` are local only (they carry addresses, history and per-device detail) |
| `resources/read` | `portboard://status`, redacted (below). Any other URI, port and device URIs included, gets `-32002 resource not found: <uri>` before the core is touched, the same as a URI that doesn't exist. |
| `prompts/list` | `server_status_summary` (서버 상태 요약) and `port_cleanup` (포트 정리 제안), same names and titles as the stdio server, with texts that name only the four remote tools and say the connection is read-only. `port_cleanup` has no `days` argument here (the remote has no usage history). |
| `prompts/get` | those two only; `new_dev_server`, `why_not_open` and unknown names get the same `-32602 unknown prompt: <name>` |

The remote dispatcher answers `initialize`, `tools/*`, `resources/*` and `prompts/*` itself and delegates **only `ping` and notifications** to the shared one. Any other method gets `-32601` here. This matters since #16: the shared dispatcher now serves `resources/read` for ports and devices, unredacted, and must never see it from this process. `test/remote-tools.test.ts` checks that port and device URIs and the local-only prompts fail exactly like unknown ones and never reach the core.

**The status resource** is built by `redactStatus()` in `src/remote/redact.ts` from the redacted projections of `list_ports`, `list_devices` and `who_uses_what` (never from core objects), passed through the shared `statusReport()` and scrubbed again. So device names, `lan-device-<id>` aliases and service names are exactly what the tools show. It adds two things the tools don't have, read by `src/remote.ts` from local files (cached 2 s):
- watched (🔔) ports and devices that are **down**: kind, port, name, since (from `alerts-state.json` and `prefs.json`; the alert checker is never started and the channel settings it can read are never copied)
- how many 새 기기 are pending, **a count only** (from `known-devices.json`; their names can be a MAC vendor or an address)

A source that fails leaves its section `null`, listed in `unavailable`, with no error text. `resources/read` and `prompts/get` get one log line each (`read uri=…`, `prompt prompt=…`), like `tools/call`.

## Redaction policy

Everything that leaves the process is built by **projection**: named fields are copied into new objects, never deleted from core objects. A field another branch adds to the core later stays local until someone lists it in `src/remote/redact.ts`. A regex scrub over every string (keys included) is the second net.

| Data | Remote output |
|---|---|
| Device, service, unit, container, Proxmox guest names; ports; states; load, memory, disk, pool slots/runs; timestamps; connection counts and bytes | kept |
| Tailnet URLs (`http(s)://devbox.….ts.net:<port>`; they only open from tailnet devices) | kept |
| Owner control | `systemd: <unit>` / `docker: <container>` kept; `process: pid N` → `process` |
| cmdlines, cwd / project paths, `/home/…`, `~/…` | never copied; any path in text → `[path]` |
| `ssh -N -L …` commands, `user@host` | never copied; in text → `[ssh command]` |
| pids, `curl (3790306)` | dropped; process names without pids kept |
| LAN, Tailscale, public IPs; subnet routes; direct-path endpoints | dropped, `routes` → `routesSubnets: true/false`; in text → `[lan-ip]`, `[tailnet-ip]`, `[loopback]`, `[ip]` |
| Device ids that are addresses (`lan:192.168.1.108`) | `lan-device-<6 hex>`: a keyed hash of the address (random key per process), so the same device has the same alias in every response and tool until the remote server restarts |
| Names that are just the address (`nameSource: ip`) | `LAN device` / `unnamed device` |
| MACs, vendor, `nameKey` | dropped; in text → `[mac]` |
| compute-pool URL and host addresses, `detail` text | dropped |
| Proxmox API URL, host IP, guest MACs/IPs/LAN IP, `looseMode` | dropped |
| Proxmox credentials (`tokenId`, `secret`, `fingerprint`) and alert channel settings | never in core results, never copied; `user@realm!token` / `PVEAPIToken=` in text → `[credential]` |
| Error messages (`pool.error`, `proxmox.error`, thrown errors) | replaced by fixed text (`Proxmox API unreachable or refused the token`, `<tool> failed on the server`) |

Two flags in `remote.json` loosen this for a private setup: `"policy": {"showAddresses": true}` (IPs, MACs, routes, endpoints) and `"showProcesses": true` (pids and client process names). Credentials, URLs of the pool/Proxmox APIs and alert settings stay out with any flag.

Tests: `test/remote-redact.test.ts` feeds live-shaped synthetic fixtures through every projection (the status resource included) and asserts there are no IPv4/IPv6/MAC/home-path/ssh/pid/cmdline/credential/URL matches, under both policy states. `test/remote-tools.test.ts` covers the tool, resource and prompt allowlists, drift and layer 3. `test/remote-http.test.ts` covers the transport, OAuth flow, Host/Origin, rate limit and on-disk secrets.

## Managing tokens from the dashboard (#31)

The dashboard (tailnet only, never the public 8794 server) has a **원격 커넥터** section on the 설정 tab (`settings.html#remote`; it was on the 기기 tab before), also linked from the setup checklist's claude.ai 커넥터 item and the consent page. Above the clients it shows the URL to paste and makes the approval code. It lists every client (registered DCR clients, and hosted CIMD clients such as claude.ai that are only known by the tokens they hold) with its redirect host, registration or first approval, and last use; under each, one row per authorization (one approval and the tokens its refreshes mint) with approval date, last use, expiry and scope. **토큰 취소** revokes one authorization, **클라이언트 전체 취소** a client's tokens and registration, each after a confirm dialog. REST: `GET /api/remote/clients`, `POST /api/remote/clients/<id>/revoke`, `POST /api/remote/tokens/<id>/revoke` ([api.md](../api.md)), writes behind the router's write guard.

- **No secrets on the wire:** ids are `c-`/`g-` plus 16 hex of a SHA-256 over the client_id or the authorization's family, so neither a token, its hash, a family nor a client_id reaches the browser. Tests scan every response for them.
- **Immediate effect:** the remote server reads `remote.json` on every request and doesn't cache tokens, so a revoke written by the dashboard (or the CLI) answers that client's next `/mcp` call with `401 invalid_token` and its next refresh with `invalid_grant`. No reload, no restart.
- **Last used:** a valid `/mcp` call writes `lastUsedAt` on its access token (and the registered client) when it was never set or is a minute old, so at most one write per token per minute; a refresh counts as a use through the rotated token's `usedAt`. A revoke that lands in between is not undone: the write only touches a record that still exists.
- **Profiles:** the dashboard manages its own profile's `remote.json`. A preview's list is the preview's file, never production's.

Rotating "everything" (there is no signing secret; tokens are opaque and stored hashed): [runbooks/remote-connector.md](../runbooks/remote-connector.md).


## remote.json

```json
{
  "publicUrl": "https://devbox.example.ts.net",
  "policy": { "showAddresses": false, "showProcesses": false },
  "allowedOrigins": [],
  "extraRedirectPrefixes": [],
  "allowLoopbackRedirects": true,
  "approval": null,
  "clients": {},
  "tokens": {}
}
```

Only the first five keys are settings; the server and CLI manage the rest. Without `publicUrl` the issuer is derived from the request's Host header (`http://127.0.0.1:8794` locally, `https://<host>` for Funnel requests). Set it before going public so the issuer never depends on a header. The server reads `publicUrl` into its Host allowlist at start, so restart after changing it.

The optional sixth setting, `"health": {"soonDays": 7, "idleDays": 7, "hideDays": 7}`, sets the thresholds for the 설정 tab's 커넥터 상태 (만료 임박, 응답 없음, and how long "n일 동안 숨기기" hides the banner). Only the dashboard reads it, on every request, so it needs no restart.

## Going public (done: Funnel 443 → 8794)

Funnel is the only change that makes this reachable from the internet.

**1. Port: 443 for the connector, 8443 for the dashboard.** Funnel is switched on per HTTPS port, never per path, so the dashboard and the connector can't share one. The connector first ran on Funnel 8443, but claude.ai never reached it there: its servers didn't connect at all to that port (2026-10-18, no request arrived while a request trace was on). Hosted MCP clients connect to the standard HTTPS port, so the connector now has **443** (Funnel, public) and the dashboard moved to **8443** (`tailscale serve`, tailnet only). Never turn Funnel on for 8443 while it serves the dashboard.

**2. Commands** (on devbox):

```bash
# a) issuer = the public URL; only claude.ai / chatgpt.com redirects may register
node -e 'const f=process.env.HOME+"/.config/portboard/remote.json",fs=require("fs");const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{clients:{},tokens:{}};s.publicUrl="https://devbox.example.ts.net";s.allowLoopbackRedirects=false;fs.writeFileSync(f,JSON.stringify(s,null,2),{mode:0o600})'
# b) run it as a service (from the merged main checkout, not a worktree)
cp deploy/portboard-remote.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now portboard-remote
systemctl --user stop portboard-remote-dev 2>/dev/null   # the dev instance from this branch, if still running
# c) publish (the first time, Tailscale prints a link to allow Funnel for this node in the tailnet policy)
tailscale serve --https=443 off              # only if 443 still serves the dashboard
tailscale serve --bg --https=8443 http://127.0.0.1:8790   # the dashboard, tailnet only
tailscale funnel --bg --https=443 http://127.0.0.1:8794
tailscale funnel status
# d) check from the server, then from a phone off Wi-Fi
node scripts/remote-smoke.ts https://devbox.example.ts.net
```

With `allowLoopbackRedirects: false`, a stranger can still register clients, but every redirect they can name belongs to claude.ai or chatgpt.com, so a code can only reach those services' callbacks. Claude Code connecting to the *public* URL needs a loopback redirect, so turn it back on temporarily for that. The smoke script also uses a loopback redirect: run it before step a, or with the flag on.

If ChatGPT fails during discovery, first try removing the `/.well-known/openid-configuration` alias in `src/remote/http.ts`. It serves the RFC 8414 document, which lacks OIDC-only fields such as `jwks_uri`.

**3. Undo:**

```bash
tailscale funnel --https=443 off           # stops public access; leaves the 8443 dashboard serve alone
node src/remote.ts revoke                  # invalidates every issued token
```

Do **not** use `tailscale funnel reset` or `tailscale serve reset`: they also remove the dashboard's 8443 entry.

**Trade-offs:**
- **Reachability:** Funnel needs no router changes and no Cloudflare account, and TLS ends at tailscaled with a real certificate.
- **Name already public:** the host name `devbox.example.ts.net` is already in Certificate Transparency logs from the existing HTTPS serve. Funnel also makes it resolve publicly.
- **No source-IP filtering:** Funnel has no ACL, so OAuth is the only gate.
  - Possible later hardening: refuse `/mcp` and `/token` unless the Funnel client address is in Anthropic's `160.79.104.0/21` or OpenAI's published list. `/authorize` must stay open to the owner's browser.
  - Not built: OpenAI's list changes and must be refreshed.
- **Bandwidth:** Funnel has bandwidth limits, irrelevant for JSON.
- **Cloudflare Tunnel instead:** that would add a dependency and an account.
- **ChatGPT alternative to check first:** OpenAI's "Secure MCP Tunnel". This server already runs one for webapp (port 18080). It might connect ChatGPT without any public endpoint, though it's not verified for this use. claude.ai documents no equivalent and needs a public HTTPS URL.

**4. Add the connector:**
- **claude.ai:** Customize → Connectors → Add custom connector (Team/Enterprise: Organization settings → Connectors → Add → Custom → Web).
  - Name `Portboard`, URL `https://devbox.example.ts.net/mcp`, OAuth left on automatic. Claude uses CIMD here because the metadata allows it, else DCR.
  - When the consent page opens, make a code on the dashboard's 설정 tab (승인 코드 만들기; or `node src/remote.ts approve` on devbox), type it, then press 승인.
  - In the chat's tool menu, allow the four tools. If the connector menu offers Portboard's prompts (서버 상태 요약, 포트 정리 제안) or the `portboard://status` resource, they can be attached from there; this hasn't been tried in claude.ai yet.
- **ChatGPT:** chatgpt.com → Plugins/Apps → + → Add custom MCP server (or Settings → Apps & Connectors → Advanced → Developer mode → Create).
  - URL `https://devbox.example.ts.net/mcp`, authentication OAuth, no client ID (CIMD/DCR).
  - Accept the risk notice, then the same approval-code step.
  - Plan availability is unconfirmed (see above).
- `node src/remote.ts status` then shows each client. `revoke <client_id>` removes one.

## If auth failed open: what the internet would see

**Without a token today** (by design): the two `.well-known` documents, the consent page and the `401`/`405`/`421` responses. That reveals the host name and that a Portboard remote MCP exists. The internet can also register clients (capped at 50, redirects only to claude.ai/chatgpt.com, plus loopback unless turned off) and send `/authorize` requests that trigger cached fetches to claude.ai/chatgpt.com only.

One nuisance: anyone who can open the consent page for a valid client (e.g. Claude's public CIMD id) can burn a pending approval code with twenty wrong tries from at least four addresses (five per address). That costs the owner a new `approve`, not access. The code exists only for the 10 minutes after the owner makes one.

The full review, with findings and their tests, is in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

**If token checking were bypassed:**
- Readable: the four read-only tools' redacted output, the status resource built from it (plus which watched ports are down and how many new devices are pending), and two prompt texts.
  - The host name `devbox` and its tailnet DNS name.
  - Every listening port with its service name and systemd unit (e.g. `webapp OpenAI Secure MCP Tunnel`, `Supabase MCP SSH Tunnel`, `Agent Harness Web UI`), container names and HTTP status.
  - Device names (`dev-mac`, `iphone`, `desktop-pc`, `gpu-box`, `pve1`, `nas`…), online/last-seen times, compute-pool load and run counts, Proxmox guest names and sizes.
  - Which device is using which service right now, with byte counts. That is an activity pattern.
- Not readable: no IPs, MACs, paths, commands, pids, logs, credentials or alert settings.
- Not possible: no action. The tools that act don't exist in this process's dispatch, and the core it holds throws on them. The tailnet URLs in the output don't open from the internet.
