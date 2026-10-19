# 세션 종료 정리 (SessionEnd 훅)

c10dev/portboard#43. When a Claude Code session ends, the servers it started become cleanup candidates right away, and — only if you turn it on — are stopped.

Before this, Portboard found leftover servers by heuristics alone (`src/core/owners.ts`): a session counted as ended once its Claude process (`CLAUDE_PID`) was gone, and a server outside the session's scratchpad waited for 2 h of transcript silence. The hook tells Portboard the moment the session ends.


## How it fits together

```
Claude Code ──SessionEnd──▶ claude-plugin/hooks/session-end.ts
                               POST http://127.0.0.1:8790/api/claude/session-end   (500 ms, errors ignored)
                                   │
Portboard                          ▼
  claude-sessions.json  ◀── record {id, cwd, reason, at}   (newest 200, 7 days)
  owners.ts cleanupReasons ── session id in the list? → "session-ended-hook"
  autoStop (opt-in) ── cleanupPorts: re-check, SIGTERM / systemctl --user stop
```

- **Hook handler**: `claude-plugin/hooks/session-end.ts` exports `onSessionEnd({session_id, cwd, reason})` and runs as a command hook (`node session-end.ts`, SessionEnd JSON on stdin). It sends one POST with `X-Portboard: 1` and a 500 ms timeout, swallows every error and always exits 0, so it never holds up or fails a session. It imports nothing from Portboard's `src/`. `PORTBOARD_URL` points it somewhere else (a preview, tests). The plugin's `hooks.json` registers it (#41/#42).
- **Endpoint**: `POST /api/claude/session-end` answers at once with `{recorded: true, autoStop}`; any stopping happens after the reply. It accepts loopback connections only, and refuses requests that carry any proxy header (`X-Forwarded-*`, `Forwarded`, `Tailscale-User-*`, `Tailscale-Headers-Info`, `Tailscale-Funnel-Request`: tailscale serve/funnel proxy tailnet traffic from 127.0.0.1; the same check as the owner rule in [security.md](../security.md)). `session_id` must look like a session id; `reason` is a short word; other hook fields (`transcript_path`, …) are ignored.
- **Ended list**: `<stateDir>/claude-sessions.json` (`~/.local/state/portboard/` in production, the preview's own dir in a preview; `PORTBOARD_CLAUDE_SESSIONS` overrides it). It is a file because the stdio MCP server (`list_cleanup_candidates`) and the digest compute owners in their own processes.
- **Candidate reason**: a server whose owner session (from `CLAUDE_CODE_SESSION_ID` in its environment, or its scratchpad cwd) is in the list gets `session-ended-hook`, shown as 띄운 Claude 세션이 끝남 (SessionEnd 훅). It doesn't wait for the Claude process to exit: the hook fires while that process is still shutting down. The usual rules still apply: only plain processes and `systemd-run` transient units are ever candidates, and pinned ports never are.
- **Resumed sessions**: the desktop app can end a CLI process and later resume the same session id in a new one. If the session's transcript was written more than 60 s after the SessionEnd, the record stops counting.

The cleanup banner on the 서비스 tab names the session (Claude 세션 ‘…’이 끝났어요), and the digest's 정리 후보 line counts these servers like any other candidate.

## Auto-stop (opt-in)

`prefs.json` → `"claudeCleanup": {"autoStop": …}`, set from the cleanup banner's ⋯ menu or `POST /api/claude/settings {autoStop}`:

| `autoStop` | On SessionEnd, stops |
|---|---|
| `off` (default) | nothing: the servers just become candidates, and 모두 정리 / `cleanup_servers` stays a manual step |
| `scratchpad` | that session's servers that run from its Claude scratchpad (`/tmp/claude-<uid>/<project>/<session>/…`) or as `pb-sd-*` / `pb-dev-*` transient units |
| `all` | every server of that session that is a cleanup candidate |

Auto-stop always goes through the existing cleanup path (`cleanupPorts`): each port is re-checked as a candidate, then gets SIGTERM, or `systemctl --user stop` for a transient unit (quiet for the down-alert checker). It never stops:

- installed systemd services, docker containers, other users' processes (they are never candidates)
- pinned ports (never candidates)
- servers of any other session
- Portboard itself, or a Portboard preview (`src/server.ts` / `remote.ts` / `mcp.ts` from a portboard directory), or this Portboard's own port
- anything when the reason is `clear`: `/clear` ends the conversation but the Claude process keeps running

Port reservations are left alone. The last run (mode, ports, results) is in `GET /api/claude/sessions` as `lastAutoStop`.

## Which servers link to a session

| Server | Session from |
|---|---|
| Started from a Claude shell (Bash tool) | `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` in its environment |
| `systemd-run` unit with a scratchpad working directory (`pb-sd-*` previews) | the scratchpad path (systemd-run doesn't pass the caller's environment) |
| `pb-dev-*` unit started with MCP `start_dev_server` | Portboard passes the calling session's `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` to the unit |
| `pb-dev-*` unit started from the dashboard, or a `systemd-run` unit started elsewhere | none: SessionEnd doesn't touch it |

## Verified

A preview Portboard on :8830 (its own state dir), two dummy `python3 -m http.server` servers with a made-up `CLAUDE_CODE_SESSION_ID` and a live fake "claude" process as `CLAUDE_PID`: :8831 from a scratchpad directory, :8832 from an ordinary directory. Before the hook neither was a candidate (session alive). After `node claude-plugin/hooks/session-end.ts` with `PORTBOARD_URL=http://127.0.0.1:8830`, both were candidates with `session-ended-hook`. With `scratchpad` chosen in the ⋯ menu and the hook run again, :8831 was stopped and :8832 stayed a candidate; `reason: clear` under `all` stopped nothing; the hook under `all` stopped :8832. Other sessions' `pb-sd-*` units on the same machine weren't touched. Requests without `X-Portboard`, with `Tailscale-User-Login`, or to the tailnet address got 403.
