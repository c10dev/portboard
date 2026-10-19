# Runbook: remote connector tokens (and "the signing secret")

The public read-only MCP (`src/remote.ts`, unit `portboard-remote`, port 8794, published by Funnel on 443) keeps its OAuth state in `~/.config/portboard/remote.json` (600): registered clients, one pending approval code, and every issued access/refresh token. Details: [docs/remote-mcp/README.md](../remote-mcp/README.md#auth-what-was-built-and-why).

**There is no signing secret.** Tokens are opaque 256-bit random values, not JWTs; the file stores only their SHA-256, and the server checks a presented token by hashing it and looking it up. So there is no key to rotate: "rotating everything" means **revoking every token** (and, if you like, every client registration) and connecting again. A copy of `remote.json` alone can't be turned into a working token, but whoever could read it could read the rest of your home directory too, so treat it as a leak anyway.

## When

- Revoke **one authorization** when a device or browser session that connected is gone, or a connector you added for a test is no longer needed.
- Revoke **a client** when you remove the connector in claude.ai / ChatGPT, or a client you don't recognise shows up (someone registered and you approved by mistake).
- Revoke **everything** when `remote.json` or a token may have leaked, when you approved a consent page you didn't start, after Funnel was misconfigured, or before handing the server to someone else.
- The self-watch warns `remote MCP client … expires soon` when a client's refresh token is within 7 days of its 30-day end: using the connector once refreshes it; otherwise let it lapse or revoke it.

## Steps

### One authorization or one client (dashboard)

1. 설정 tab → **원격 커넥터** (`settings.html#remote`; or 시작하기 → claude.ai 커넥터 → 승인 코드·토큰 관리). Each client shows its name, redirect host, when it was registered and last used; under it one row per authorization (승인) with approval date, last use, expiry and scope. No token values are shown anywhere.
2. **토큰 취소** on a row revokes that authorization (its access and refresh tokens); **클라이언트 전체 취소** revokes all of a client's tokens and deletes its registration. Both ask for confirmation.
3. The change is in `remote.json` at once, and the remote server reads that file on every request, so the client's next `/mcp` call gets `401 invalid_token` and its next refresh `invalid_grant`. No restart.

REST, tailnet-only (the dashboard, never the public server): `GET /api/remote/clients`, `POST /api/remote/clients/<id>/revoke`, `POST /api/remote/tokens/<id>/revoke` (with `X-Portboard: 1`). The ids are derived (`c-…`, `g-…`), not client_ids or token hashes.

### Everything (CLI on devbox)

```bash
cd /home/dev/projects/portboard
node src/remote.ts status          # clients and live-token counts, no secrets
node src/remote.ts revoke          # every token, and a pending approval code
```

`revoke` keeps client registrations (claude.ai and ChatGPT re-register or use CIMD anyway). To also drop every registration:

```bash
for id in $(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/portboard/remote.json")).clients).join(" "))'); do node src/remote.ts revoke "$id"; done
```

If you think the server itself was abused (not just a token), also stop public access first: `tailscale funnel --https=443 off` (never `funnel reset` / `serve reset`: they remove the dashboard's 443 entry). That step is the owner's to take and to undo.

### Reconnect

In claude.ai: Customize → Connectors → Portboard → Disconnect, then Connect (or remove it and add it again as in [docs/remote-mcp](../remote-mcp/README.md#going-public-not-done)). When the consent page opens, make a code on the dashboard (설정 tab → 원격 커넥터 → **승인 코드 만들기**, tailnet only; or `node src/remote.ts approve` on devbox) and type it (one use, 10 minutes).

## Verify in Portboard

- 설정 tab → **원격 커넥터**: the revoked row or client is gone; after reconnecting, a new 승인 row appears with 마지막 사용 방금 after the first tool call.
- Setup checklist → **claude.ai 커넥터**: while nothing is connected it says 아직 연결하지 않았어요 / 유효한 토큰이 없어요; after reconnecting it is 완료 (연결된 클라이언트 n개).
- Self-watch → 토큰 만료: the revoked client's **remote MCP client …** row disappears at the next hourly expiry check.
- From the shell: `node src/remote.ts status` shows the counts; `journalctl --user -u portboard-remote --since -10min | grep invalid-token` shows the revoked client being refused.

## Rollback

A revoke can't be undone: the tokens are gone and only their hashes ever existed. Reconnect the client (above) to get new ones. Deleting a registration is equally final; the client registers again on its next connect.
