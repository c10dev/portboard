# 메모리

Where this server's RAM goes, grouped the way parallel Claude Code work uses it, and an alert when memory runs short. It lives on the 기기 tab under 이 서버, in `GET /api/memory`, and in the local MCP tool `memory_usage`. Code: `src/core/memory.ts` (collector, grouping, pressure state machine; split into modules under `src/core/memory/`, re-exported there) and `src/features/memory.ts` (job, API, tool, alerts).

Portboard only reads. It never stops or signals a process: the suggestions say where to act (archive a session in the Claude app, or 정리 on the 서비스 tab).

## What it shows

- **Memory bar**: used (not reclaimable) / cache (reclaimable) / free, which add up to total. Below it: swap, PSI `some` (10 s · 1 min · 5 min), shared memory (tmpfs, shm) when it is over 1 GB, and sparklines of the last hour (available %, PSI 1 min).
- **Groups**: a strict partition. Every process is counted once, in this order: docker containers → MCP servers → services and dev servers (the processes behind listening ports, with their children) → Claude sessions (the CLIs and their other children: tool shells, test runs) → 기타. Their sum is the RSS of all processes.
- **Claude 세션**: one row per Claude Code CLI (`~/.claude/remote/ccd-cli/<version>` or a `claude` binary) with its whole process tree, so a session's MB also counts its MCP servers and the dev servers it started. The row shows the title (`customTitle` in its transcript) or project, the CLI version (구버전 when older than the newest running), how long the transcript has been quiet (쉰 시간), and the uptime. 쉬는 중 means the transcript has been quiet for `idleMin` and the tree used under 3 % of a core since the previous sample (a waiting CLI still polls at 0.5–1.6 %). Idle is unknown until the second sample.
- **MCP 서버**: summed across sessions, with the instance count. A server is recognised by its command: `rea` (including the `npm exec rea-agents` → `sh` wrappers), `@playwright/mcp`, Portboard's own `mcp.ts`, and other `*mcp*` packages inside a CLI's tree. 세션마다 실행 marks a server that runs in most sessions, which is what a user-scope MCP server costs. 세션 밖 counts instances whose CLI has exited.
- **서비스·dev 서버**, **docker** (cgroup `memory.current` minus inactive file pages, the same number `docker stats` shows) and **기타** by process name.

Sizes are RSS. Shared pages are counted in every process that maps them, so the totals are a little above what `free` calls used.

## Suggestions

No automatic actions. Each one says what it would free:

- **쉬는 세션 N개가 X GB**: archive finished sessions in the Claude app; the CLI and its MCP servers go with it.
- **구버전 CLI**: sessions on an older CLI than the newest running one.
- **MCP servers in every session but rarely used**: compares instances with tool calls per server in the last 7 days, from the daily transcript scan (`src/core/adoption.ts`). It says 확인 전 until a scan that counts per-server calls has run (at most a day after an upgrade).
- **long-idle dev servers**: up for `devIdleHours`, unit-less or `systemd-run`, nobody using them. It links to the existing 정리 flow on the 서비스 tab.

## Pressure alerts

Through the down alerts' channel (compute-pool's ntfy/webhook), logged in `alerts.jsonl`:

- **Warning** when, for `sustainMin` minutes in a row, available memory is under `availablePct`, PSI `some avg60` is over `psiSome60`, or swap is over `swapPct` used. Samples more than 3 minutes apart start the count again.
- **Reminder** every `reminderHours` while it lasts.
- **Recovery** once all three are clear with a margin (available ≥ threshold + 2 points, PSI ≤ 60 % of its threshold, swap ≤ threshold − 5 points) for `sustainMin`.

The text lists the biggest groups and the idle sessions. State survives restarts (`memory-state.json` in the state dir). A send that reaches no channel is tried again the next minute. Previews track the state but never send (`paths.alertsOn`). The sidebar footer's 수집 chip turns to 메모리 부족 while the alert is on, and the daily digest gets one 🧠 line.

Swap does not drain by itself: pages come back only when they are touched or their process exits. With swap full, the warning can therefore last for days after available memory is fine again, with a reminder every `reminderHours`. To alert on available memory and PSI only, set `"swapPct": 100`.

### Thresholds

`memory.json` in the config dir (`~/.config/portboard/memory.json`; `PORTBOARD_MEMORY` moves it). Portboard reads it on every sample and never writes it. Any key left out or out of range keeps its default:

```json
{
  "availablePct": 10,
  "psiSome60": 5,
  "swapPct": 90,
  "sustainMin": 5,
  "reminderHours": 6,
  "idleMin": 60,
  "devIdleHours": 24
}
```

## Cost

One job on the shared scheduler every 60 s. Each run reads `/proc/<pid>/stat` and `cmdline` for every process, about 150 ms for 600 processes, and spawns nothing per process. A CLI's session id comes from the `environ` of one of its children, read once per CLI, and only `CLAUDE_CODE_SESSION_ID` is kept: the CLI's own environment holds its OAuth token and is never read. Titles come from a background queue, one transcript at a time and at most every 10 minutes per session: each transcript is read once through one reused 1 MB buffer, then only the bytes appended since (about 120 ms and 1 MB of RSS for 60 transcripts, 245 MB). `docker ps` names the containers once every 5 minutes.

## Remote

`memory_usage` is local only, because titles, projects and process names stay on this machine. `portboard://status` on both servers carries one `memory` line with numbers and reason codes only: `pressure`, `reasons`, `availablePct`, `swapPct`, `psiSome60`, `at`.
