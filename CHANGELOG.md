# Changelog

## 1.0.0 — 2026-10-18 (M10 보안·완성 + v1.0 보안 리뷰 수정)

### Added
- `GET /api/whoami` → `{login, source, owner, canWrite, reason?}`. A read-only browser sees `🔒 읽기 전용 — <reason>` under the header on every page, write controls greyed out, and writes answered with the same reason instead of failing (#29).
- 기록 (#30): every write — restart, stop, expose/unexpose, prefs, cleanup, worktree remove/prune, reservations, dev-server start/stop, alerts, names, 새 기기, digest, suggestions, Claude session-end and settings — allowed, denied or failed, and every write tool of the stdio MCP server (source `mcp`), is one JSON line in `<state dir>/audit.jsonl` (0600, rotated to `.1` past 1 MB): time, who (login, `local` or the direct address), source (`serve`/`loopback`/`direct`/`mcp`), route, target identifiers, result, status, short message. Bodies are never logged as they are: allowlisted identifiers only, other fields by name. `GET /api/audit?port=&limit=`, a 기록 card on the service page, and a folded 최근 기록 at the bottom of the 서비스 tab. `PORTBOARD_AUDIT` moves the file (docs/audit/).
- 원격 커넥터 on the 기기 tab: every client of the public read-only MCP (claude.ai, ChatGPT, Claude Code) with redirect host, registration, last use, and one row per authorization with expiry and scope; revoke one authorization or a whole client after a confirm dialog. REST on the dashboard only: `GET /api/remote/clients`, `POST /api/remote/clients/<id>/revoke`, `POST /api/remote/tokens/<id>/revoke` (write guard). The running remote server refuses a revoked token on its next request (#31).
- The remote server records when each access token was last used, at most one write per token per minute (#31).

### Changed
- `http://devbox.example.ts.net:8790` (plain HTTP, direct) is now read-only; use `https://devbox.example.ts.net`. `scripts/mac-setup.sh` prints the https address (#29).
- The SessionEnd route's loopback check is shared with the owner rule and also treats `X-Forwarded-Host/-Proto`, `Tailscale-User-Name` and `Tailscale-Headers-Info` as proxied (#29).
- worktree 스캔 비용 절감 (#44): the 15-minute worktrees scan is incremental. On devbox (148 worktrees, 16 repos) a scan with nothing changed starts 16 `git` + 8 `gh` and no `du` instead of 505 `git` + 148 `du` + 8 `gh` (~4 % of the subprocesses, ~1/5 of the CPU), with the same results. Commit dates and ancestry answers are cached by sha (the misses batched into one `git log --no-walk` / `git rev-list <tip>` per repo); `git status` runs only when a worktree's signature changed (HEAD, index, an lstat of every tracked file and of every directory holding one, ignore and config files; anything changed in the last 2 s doesn't count as unchanged) or its last live status is older than 6 h; `du` runs when HEAD changed, the size is a day old, or an hour old and the files changed, so sizes and `removableKb` can be up to a day old. Repos without linked worktrees cost no subprocess. `git status` runs with `--no-optional-locks`, so scanning no longer rewrites the repos' index files.
- `GET /api/worktrees?refresh` and `list_worktrees {refresh: true}` run a full scan that trusts no cache (asked for during an incremental scan, it runs right after it). Removal still re-checks everything live before `git worktree remove`. The scan result carries `scan: {mode, spawns}` (#44).
- The dashboard's 기록 list shows the device a write came from, and a coalesced denial as `거부 ×N`.
- `GET /api/worktrees?refresh` and `/api/adoption?refresh` answer with `refresh` (`started`, `running` or `throttled`) and, unless a scan started, a `note`; `list_worktrees {refresh: true}` and `adoption_stats {refresh: true}` carry the same `note`. The dashboard's 다시 스캔 shows a toast when the full scan was throttled (v1.0 security review L1).

### Security
- Writes are the owner's only (#29). Every `POST` still needs `X-Portboard: 1`, and now also an owner caller: a process on this machine talking to 127.0.0.1 directly (the plugin hooks, scripts), or the owner's Tailscale login through `tailscale serve` (`Tailscale-User-Login`, which serve strips from clients and sets itself). The owner is this node's Tailscale user (`tailscale status --json`), or `PORTBOARD_OWNER_LOGIN`. Another user, a tagged device, Funnel and any direct connection to `http://<host>:8790` get `403 {error: "owner only", reason}` before the body is read; reads are unchanged. Decisions are a pure function with a table of tests (`src/core/access.ts`), wired in one place (`appRouter`).
- No token, token hash, family or client_id leaves `remote.json` through the dashboard: the list uses derived `c-…`/`g-…` ids, and tests scan every response (#31).
- Write devices (security review v1.0, M1): serve and direct callers are identified as a tailnet node with `tailscale whois` (X-Forwarded-For on the serve path, the socket for direct; cached per address, never a shell). Every audit line and `GET /api/whoami` carry the device (`{addr, name, id}`). An optional allowlist, `writeDevices` in `~/.config/portboard/access.json` (0600, `PORTBOARD_ACCESS` moves it) plus `PORTBOARD_WRITE_DEVICES`, limits serve writes to the listed node names or stable IDs; other owner-login devices get 403 with a Korean reason naming the device, and a broken or loose file fails closed. Unset, nothing changes, but the 설정 체크리스트 warns "쓰기 가능한 기기 제한 안 됨" and lists the owner-login devices that can write.
- Audit log can't be flushed by denials (M2): denied requests go to their own capped `audit-denied.jsonl`, and identical ones (who, source, route, reason, device) are coalesced to about one line a minute with a `count`. 7,000 denied POSTs now leave the earlier writes in `audit.jsonl`.
- Every dashboard answer sends `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` (L3).
- `X-Real-IP`, `Via`, `True-Client-IP`, `CF-Connecting-IP` and similar headers count as proxy markers, so a local reverse proxy that sets only one of them no longer makes its clients the owner (L5).
- State and config files are written 0600 through random, `O_EXCL` temp names; `deploy/portboard.service` gets `UMask=0077` and `NoNewPrivileges=yes` (L6). The installed unit must be copied by hand (`scripts/deploy.sh` doesn't install unit files).
- 500 answers carry a generic Korean message and a request id instead of the error text; the error is logged under that id, and the audit line no longer holds it.
- The dashboard server gets `headersTimeout`/`requestTimeout`/`keepAliveTimeout` and a 256-connection cap per listener, like the remote server.
- Heavy reads any tailnet device can trigger are bounded (v1.0 security review L1): the port snapshot, topology and usage are computed one at a time and shared, and `?fresh` skips their 2 s cache at most once per 5 s; a forced full worktree scan is accepted at most once per 60 s and a forced transcript scan once per 10 min (sooner, the running or latest result with a note, never an error); `GET /api/ports/:port/logs` resolves the owner from the shared 2 s snapshot; `GET /api/claude/port-advice` takes free ports from that snapshot (no `ss` / `tailscale serve status` per request), caches reservations for 2 s and the cwd's `repo@branch` for 10 s per cwd (bounded, one git call per cwd at a time).
- The port-nudge text no longer carries untrusted text as-is (L4): HTTP titles, session titles, reservation notes and owners, process, unit and container names and branch names are cleaned of ANSI escapes, control and format characters (zero-width, bidi overrides) and newlines, capped at 60 characters and quoted, and a line after the `[portboard]` marker tells the model quoted text is data, not instructions. A path a suggested tool call needs is quoted unchanged, or left out when it holds such characters.
- `git status` in scanned worktrees and in listening processes' checkouts, `git worktree remove`, and the port-advice cwd lookup run with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, so a checkout's config can't make `portboard.service` run a program (I4).
- The dev-server script allowlist checks own keys (`Object.hasOwn`), so `constructor`, `toString` or `__proto__` never pass it (I2).
- `readOnlyCore` is typed `Required<Core>` and names every Core method, optional ones too (`setAlert`, `alerts`, `newDevices`, `collection`, `serviceDetail` added as not remote); a test checks that every method but the three remote reads refuses (I1).
- CI: the workflow's token is `contents: read`, and `actions/checkout` and `actions/setup-node` are pinned by commit SHA (I10).

### Docs
- docs/security.md: who can reach and who can write, what tailscale serve sends and how it was checked, the threat model (#29).
- Rotation runbooks in `docs/runbooks/`: the Proxmox API token, the read-only SSH key for pve1/CTs and Windows, the ntfy topic, and the remote connector's tokens (there is no signing secret). Each says when, the steps, which checklist or self-watch item turns green, and rollback; the setup checklist, the self-watch's expiry rows and its alerts link to them (#31).
- docs/worktrees/README.md: scan cost, what is cached and when it's refreshed, before/after numbers (#44).
- docs/security.md: write devices, audit coalescing, response headers, server limits, file modes. docs/security-review/v1.0.md: status of M1, M2, L3, L5, L6 and I8.
- docs/api.md: **Load bounds** table; docs/claude-plugin/README.md: quoted names and the framing line; docs/worktrees/ and docs/adoption/: refresh throttling; docs/security-review/v1.0.md: status of the load/hook/misc fixes.

## 0.10.0 — 2026-10-18 (M9 Claude 세션 통합)

### Added
- 채택 지표 (#40): how Claude Code sessions on this machine handle ports, measured from their transcripts (`~/.claude/projects`, subagents folded into their session, read-only). Per KST day and project: sessions, Portboard MCP calls, raw port inspection (`ss -ltn`, `lsof -i`, `netstat -l`, `fuser N/tcp`), kill-by-port, servers started on a hard-coded port (`PORT=N`, `--port N`, `-p N` for vite/next/astro/serve), the most used ports, and Portboard hook nudges (`[portboard]`) with how many were followed by an MCP call. Only counts, project dir names, ports and short command prefixes come out. A background job rescans about once a day into `adoption.json` in the state dir; requests never scan. `GET /api/adoption`, MCP `adoption_stats` (local only), a "Claude 세션 포트 사용" section on the 개발 tab (this week vs last week), one info line in the 요약 알림, and `node scripts/adoption.ts [--days N] [--json]` (docs/adoption/).
- Claude Code plugin: the repo is a plugin marketplace (`.claude-plugin/marketplace.json`) with the `portboard` plugin in `claude-plugin/`: the stdio MCP server (run from the checkout, `PORTBOARD_HOME` to override), a `dev-servers-and-ports` skill (`list_ports` before `ss`, `free_port` → `reserve_port` → `start_dev_server`, `cleanup_servers` instead of kill) and the hooks. Install with `/plugin install portboard@portboard` after `claude mcp remove portboard -s user`; tools are then named `mcp__plugin_portboard_portboard__*` (#41).
- Port nudge: a PreToolUse hook on Bash that adds `[portboard]` context (never blocks or asks) when a command starts a dev server on a hard-coded port (`vite --port`, `npm run dev -- --port`, `PORT=N npm start`, …) or kills by port (`kill $(lsof -t -i:N)`, `fuser -k N/tcp`, …): who holds or reserved the port, a port for this worktree, and `start_dev_server` / `cleanup_servers` instead. One local request, 300 ms timeout, silent on any failure. Off with the plugin's `port_nudge` option or `PORTBOARD_NUDGE=0` (#42).
- `GET /api/claude/port-advice?port=N&cmd=start|kill&cwd=…` (read-only, new `claude` feature module) and the command parser `src/core/portcmd.ts` (#42).
- 세션 종료 정리 (#43): the Claude Code plugin's SessionEnd hook (`claude-plugin/hooks/session-end.ts`, one POST with a 500 ms timeout, never fails the session) tells Portboard a session ended (`POST /api/claude/session-end`, loopback only, X-Portboard). The servers that session started become cleanup candidates at once with the reason `session-ended-hook` (띄운 Claude 세션이 끝남 (SessionEnd 훅)) instead of waiting for the Claude process to disappear or 2 h of idle time, and the cleanup banner names the session. The ended list lives in `<stateDir>/claude-sessions.json` (newest 200, 7 days) and is read by the stdio MCP server and the digest too; a session that resumes under the same id stops counting as ended.
- Opt-in auto-stop on SessionEnd: `prefs.json` `claudeCleanup.autoStop` = `off` (default), `scratchpad` (only servers running from that session's Claude scratchpad, or as `pb-sd-`/`pb-dev-` transient units) or `all` (every server of that session), set from the cleanup banner's ⋯ menu or `POST /api/claude/settings`. It goes through the existing cleanup path (re-check, SIGTERM / `systemctl --user stop`): never installed systemd services, docker, pinned ports, other users' processes or Portboard; reservations stay. `/clear` (reason `clear`) never auto-stops.

### Changed
- `start_dev_server` called through the MCP passes the calling session's `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` to the `pb-dev-` unit (`systemd-run` doesn't inherit them), so the unit shows its owner session and is covered by SessionEnd cleanup. Such units are also subject to the existing "session ended, 2 h idle" candidate rule; units started from the dashboard carry no session (#43).

### Docs
- [docs/claude-plugin/](docs/claude-plugin/README.md): install and migration from `claude mcp add`, what the hooks say, how to turn them off (#41).
- docs/claude-plugin/session-end.md: the hook, the endpoint, the auto-stop modes and what is never stopped (#43).

## 0.9.0 — 2026-10-18 (M8 채택·사용성 + M6 프론트엔드 모듈)

### Added
- 설정 체크리스트 (#32): a "☑ 설정 n/m" chip on the 서비스 tab opens what is set up and what is left. It covers the alert channel, the Proxmox token and its expiry, the read-only SSH keys for pve1/CTs and Windows, the Mac agent and menu bar, the claude.ai connector, Claude Code's MCP entry, and first pins, names and alerts. Each item has a next step (a command to copy or a doc link). The chip is hidden once everything is ok. Also `GET /api/onboarding` and the local MCP tool `setup_status`, which is not offered remotely. No secret values are shown (docs/onboarding/).
- Smart defaults (#33): Portboard suggests a down alert for pinned ports, installed systemd units and long-lived docker containers that have none (🔔 알림 켜기? on the 서비스 row, one per unit/container), and a name for LAN devices it can identify (추천 이름 on the 기기 card, pre-filled in 이름 붙이기): the tailnet peer whose direct endpoint is that LAN address, the router's DNS name, or a device kind from the MAC vendor. Nothing is applied by itself; 무시 is kept in `prefs.json`. `GET /api/suggestions`, `POST /api/suggestions/:id/dismiss`, MCP `list_suggestions` (local only), and `list_new_devices` entries carry `suggestedName`. Portboard itself and `systemd-run` units are never suggested.
- 일간/주간 요약 알림 (#34): one short Korean message a day or a week (Monday) at a chosen time in KST, through the down alerts' channel: watched ports' uptime and outages, what is down now, new devices, leftover servers, removable worktrees, self-watch problems and the most used services; "이상 없음" when there is nothing to report. Off by default. Setting in `prefs.json` (`digest`), `GET`/`POST /api/digest`, `GET /api/digest/preview`, `POST /api/digest/send`, MCP `digest_preview` and `set_digest` (local only), and a 요약 알림 section with 미리보기 and 지금 보내기 in the 🔔 dialog. Scheduled by the one job scheduler, production only; `digest-state.json` keeps a restart from sending twice. docs/digest/.
- Command palette on every page (#35): ⌘K / Ctrl+K, `/` or the header 🔍 button. It does fuzzy search over ports (number, name, project, unit, container), devices (name, IPs, Tailscale name), worktrees and commands. Hangul initials work (ㅍㅌ → 포트), and the last items you ran come first. It runs the pages' own actions: 열기, 상세, 로그, ★, 🔔, 재시작 and 중지 with the same confirm, plus tab navigation and 새로고침. A verb word goes straight to that action (`8790 로그`, `restart webapp`). Arrow keys, Enter and Esc work, and it fits a phone. The data comes from the existing GET APIs, fetched when the palette opens. Modules: `public/lib/fuzzy.js`, `public/lib/palette.js`, `public/features/palette.js` (docs/palette/).
- Empty states that say why a list is empty and what to do next (#35). 서비스: ports hidden by a filter (`필터 때문에 숨겨진 포트 N개 · 전체 보기`), or no search match (검색 지우기 / 팔레트에서 찾기). 기기: where devices come from (Tailscale, compute-pool, connections). 개발: `PORTBOARD_REPOS_ROOT` when no repo is found, and 전체 보기 when 지울 수 있는 것만 hides everything.
- `service.html?logs#<port>` opens the logs dialog, and `dev.html#<path>` scrolls to that worktree (#35).

### Changed
- The dashboard's front end is native ES modules with shared parts (#23): `public/lib/` (fetch with X-Portboard, `el`/`h`/escaping, relative times, sizes, toast and copy, badges and user chips, the ⋯ menu, dialogs and the 기기 detail sheet, sparklines) and `public/features/<name>.js` for each feature's UI, next to `src/features/<name>.ts`. Still no build step and no packages. Pages look and behave as before: screenshots at 1200/390 px in light and dark, the DOM and every POST and confirm match `main` (docs/frontend-modules/). The feature scripts the server injects are now `features/selfwatch.js` and `features/owners.js`.
- The Mac menu bar plugin sends `User-Agent: portboard-menubar/1`, so the checklist can see it is installed. Reinstall it on the Mac to pick this up (#32).

### Docs
- docs/architecture.md: "Adding UI for a feature" (#23).
- docs/suggestions/: the rules, sources and what production gets (#33).

## 0.8.0 — 2026-10-18 (M6 구조 개선(#21·#22·#24) + M7 개발 워크플로·정리)

### Added
- `/api/health?detail` → `runtime`: RSS, uptime, subprocesses started (total, per minute, per command) and the scheduler's job states (runs, errors, last duration, next run).
- **Who owns a dev server** (#25): each plain-process server (and each `systemd-run` transient unit) on the 서비스 tab gets a badge with the Claude Code session that started it (title, still running or ended) and the git worktree@branch it runs from (merged or not). Sources: `CLAUDE_CODE_SESSION_ID`/`CLAUDE_PID` in the process environment, a Claude scratchpad working directory, `~/.claude/projects/*/<session>.jsonl` for the title, and git for branch/merge/dirty state (cached 5 min). `GET /api/owners`.
- **Leftover servers and one-click cleanup** (#26): a banner on the 서비스 tab lists servers whose working directory was deleted, whose starting session ended (at once for scratchpad servers, after 2 h idle otherwise), or whose linked worktree's branch is merged with no changes and no live session. "모두 정리" asks, then stops them (SIGTERM, or `systemctl --user stop` for transient units); each port is re-checked first. Installed systemd services, docker, other users' processes, pinned ports and Portboard itself are never candidates. `POST /api/cleanup {ports}` (X-Portboard), MCP `list_cleanup_candidates` and `cleanup_servers` (local only).
- **Port reservations** (#27): a stable port per project or worktree in `~/.config/portboard/reservations.json`. `free_port` / `GET /api/free-ports` never offer a port reserved for someone else, and with `for=<owner>` return that owner's free reserved ports first. The 개발 tab lists reservations with what listens on each port now (and warns when it isn't the owner's process), and adds/releases them; nothing is ever stopped. `GET|POST /api/reservations`, `POST /api/reservations/:port/release` (X-Portboard), MCP `list_reservations`, `reserve_port`, `release_port` (local only); `free_port` takes an optional `for`.
- **Start/stop a worktree's dev server** (#28): the 개발 tab shows "▶ dev" on every worktree (and main checkout) whose package.json has `dev`, `start`, `preview` or `serve`, and "실행 중 :port ■ 중지" when one runs. Starting runs `npm run <script>` as a transient systemd user unit (`pb-dev-<dir>-<hash>`, `--collect`) in the worktree on loopback, with the framework's port flags (vite/astro `--port … --host 127.0.0.1`, next `-p … -H 127.0.0.1`, otherwise `PORT`/`HOST`), on the worktree's reserved port (owner `<repo>@<branch>`) or a free port that then gets reserved (#27). Only worktrees of the scanned repos and only scripts that exist; a second start is refused. Logs are the existing logs action on the port (journalctl). `GET /api/dev-servers`, `POST /api/dev-servers/start|stop` (X-Portboard), MCP `list_dev_servers`, `start_dev_server`, `stop_dev_server` (local only).
- **개발 tab: worktree hygiene across repositories** (#36): every git worktree of the repos under `~/projects` (and their worktrees elsewhere, e.g. `~/.codex/worktrees`) with branch, PR state (via `gh`), changes, last commit, size and processes running inside, scanned in the background every 15 min (~6–11 s for 8 repos / 130 worktrees). A worktree can go when it is linked, unlocked, has no tracked or untracked changes, nothing runs inside, and its branch is merged by ancestry or by a merged PR whose head contains the worktree's HEAD (squash merges). Batch removal per repo asks first and runs `git worktree remove` without `--force`; branches are kept. `git worktree prune` for records of directories that are already gone. `GET /api/worktrees`, `POST /api/worktrees/remove|prune` (X-Portboard), MCP `list_worktrees`, `remove_worktrees` (local only).
- Deploy smoke checks include `/dev.html` and `/api/worktrees`.

### Changed
- Feature module registry (#21): each feature (ports, control, devices, usage, free ports, alerts, 새 기기, service detail, Proxmox trends, pve1/Windows ports, self-watch, MCP resources and prompts) now lives in one file under `src/features/` that declares its REST routes, MCP tools, remote tools, jobs, health collectors and page scripts. `server.ts`, `mcp/tools.ts`, `mcp/rpc.ts`, `remote/tools.ts` and `mcp.ts` only iterate the registry, so parallel branches stop colliding in them. No behaviour change: REST answers, MCP `tools/list`, `resources/list`, `prompts/list` (local and remote) and the served pages are identical.
- The remote connector's tool, resource and prompt lists come from the feature modules; the registry refuses to offer a tool that isn't read-only, and a test pins the exact remote set. Every write route goes through one `X-Portboard` guard in the router.
- `scripts/deploy.sh`: changes under `src/mcp/`, `src/remote/core.ts` and `src/remote/redact.ts` now restart the dashboard too, since it loads the feature modules that import them.
- **Single scheduler** for the features' interval jobs (#24): one 1 s tick, per-job interval with start jitter (≤20 % of the interval, max 5 s), a job never overlaps itself, a failing job is logged once per distinct error and doesn't affect the others. The alert checker and the self-watch keep their own timers.
- **Fresh snapshots no longer wait for HTTP probe timeouts**: probe results are stale-while-revalidate per listener (host, port, pid). An HTTP listener is re-probed every 60 s, a non-HTTP one every 10 min, in the background; only a newly seen listener waits. `/api/ports?fresh` after the probe cache expired went from ~1.06 s to ~45 ms; warm it is ~45 ms.
- **The first pve1/Windows SSH read waits at most 400 ms** (`PORTBOARD_SSH_FIRST_WAIT_MS`), then answers `pending` while the background read finishes: cold `/api/devices` ~1.8 s → ~0.4 s, warm ~10 ms.
- `tailscale status`, `tailscale serve status` and `ip neigh` are shared for a few seconds between collectors (`runShared`); the serve cache is dropped after a publish/unpublish.

### Fixed
- The pve1/Windows SSH collector tests read with the full wait, so the 400 ms first-read cap (#24) can't make them flaky on a busy machine.

### Docs
- `docs/architecture.md`: the module map and "How to add a feature".
- CHANGELOG fragments: branches add `changelog.d/<issue>.md` instead of editing `CHANGELOG.md`; `node scripts/changelog.ts <version>` folds them at release (#22).
- README split by topic: the README is an overview, quick start and index; details moved to `docs/dashboard.md`, `api.md`, `mcp.md`, `setup.md`, `architecture.md`, `security.md` (#22).
- A test checks that every relative link in the README, roadmap, changelog and docs resolves.

## 0.6.0 — 2026-10-18 (M5 배포·신뢰성)

### Checks (#19, M5)
- `npm run typecheck` (`tsc --noEmit` over `src/`); TypeScript and @types/node are devDependencies only, the runtime still has zero dependencies. CI runs `npm ci`, the typecheck, then the tests.
- UI smoke without a browser: every page's local scripts and styles exist, and every front-end script parses.
- The typecheck found the remote server's read-only Core missing `usage`/`history`/`setClientName` (now explicit `not available remotely`, same behaviour as before) and fixed `withNewDevices`' return type.

- **One-command deploy** (#17, M5): `scripts/deploy.sh` runs `npm test`, restarts only the units whose code changed, smoke-checks pages, APIs, the public remote (401 without a token) and every response for secrets, then pushes; on a failed check it checks out the previous deploy, restarts and re-checks. `--dry-run`, `--no-push`, `--restart`. See docs/operations.md § Deploy.
### Previews keep their own state (#20, M5)
- A Portboard on any port other than 8790 runs the **preview profile**: config and state in `~/.local/state/portboard/previews/<port>/`, seeded once with a copy of production's `prefs.json` and `clients.json`. Its writes (pins, labels, names, history, known devices, uptime) never touch production's files; `remote.json` is never shared; secrets (`proxmox.json`, the pve1/Windows SSH targets and key, compute-pool's `alerts.json`) are read from production only.
- Alerts are off in a preview (no checker, no 새 기기 messages, no channel for the test button) unless `PORTBOARD_PREVIEW_ALERTS=1`.
- The header shows **미리보기 · <port>**, `/api/health` returns `{ok, profile, port}`, and startup logs one line with the profile and directories. `PORTBOARD_PROFILE=production|preview` forces either.
- All paths now come from `src/core/paths.ts`; the existing per-file env overrides still work and win over the profile.

## 0.4.0 — 2026-10-17 (M3 멀티 호스트 + M4 #16)

### 기기 / 서비스 tabs
- **pve1, nas and jellyfin ports** (#13, M3): the listening TCP ports of the Proxmox host and its running containers, read over SSH with a dedicated forced-command key (`~/.ssh/portboard_ro` → `/usr/local/bin/portboard-ports` on pve1, which only runs `ss -ltn`). They render like the other hosts' ports: "열린 포트 N" with process names, `tailnet` / `LAN` / `그 기기 안에서만`, and `열기 ↗` where it makes sense (`https://pve1…:8006` for the Proxmox UI). nas's ports go on its tailnet card; jellyfin, which has no Tailscale, gets a card from the Proxmox tree (named after the guest) with links to its LAN address. The 서비스 tab's host picker lists pve1, nas and jellyfin. Until the key is installed, the 기기 tab shows a setup hint with a link to the install snippet.
- Read every 60 s in the background with backoff (5 min while the key isn't installed); the last good list stays up to 15 min while pve1 is unreachable.
- Ports owned by `tailscaled`, and 3128 (spiceproxy) and 22000 (Syncthing sync), no longer get an `열기` link.

- **The desktop's Windows-side ports** (#14, M3): Windows' own listening ports (outside WSL) read over Windows OpenSSH with the same read-only key (forced command: `ports.ps1`, tab-separated). Merged with the WSL ports from compute-pool on the desktop-pc card and in the 서비스 tab, each tagged `Windows` or `WSL`. Sockets that only forward a WSL port to Windows (wslrelay/wslhost, or an unnamed owner on the same port) are folded into the WSL row. The Windows account defaults to Dev (`~/.config/portboard/winports.json` overrides it); while the read fails, the 기기 tab shows a setup hint linking to #14. Verified live on 2026-10-17 (35 sockets). Windows system processes (svchost, lsass, wininit, services, spoolsv) and RPC 135 get no `열기` link.

### API / MCP
- `/api/devices`: `devices[].portsSource` (`compute-pool` | `pve-ssh`), `proxmox.hosts[].ports`, `proxmox.hosts[].guests[].ports`, and `pvePorts` (`ok`, `lastOk`, `error` code, `unmatched` CTs). Ports gain `lan`. `/api/usage` carries `pvePorts` and the cards' `portsSource`; `nameSource` can be `proxmox`.
- MCP `list_devices` carries the same data (no new tool). The remote connector keeps port, scope and reach, drops LAN URLs and addresses unless `showAddresses`, and reports only the status code of the SSH read.
- Optional `~/.config/portboard/pveports.json` (`PORTBOARD_PVEPORTS`); `PORTBOARD_PVEPORTS_CMD` for previews.
- Windows: `devices[].ports.sides` `{windows, wsl}` (ms read), `ports[].side` (`windows` | `wsl`), `portsSource` can be `windows-ssh`, and `winPorts` status on `/api/devices` and `/api/usage` (same in MCP `list_devices`; the remote connector keeps `side`/`sides` and reduces `winPorts` to state and error code). `~/.config/portboard/winports.json` (`PORTBOARD_WINPORTS`), `PORTBOARD_WINPORTS_CMD` for previews.

### MCP (#16)
- **Resources** on the local stdio server: `portboard://status` (서버 상태 요약: devices online, compute-pool health, services in use and by whom, watched ports down, 새 기기), `portboard://port/{port}` (the `service_detail` report) and `portboard://device/{id}` (a device with what it uses). `resources/list` lists the status, every visible listening port and every device; `resources/templates/list` has the two templates.
- **Prompts** (Korean, ASCII names): `server_status_summary` 서버 상태 요약, `port_cleanup` 포트 정리 제안, `new_dev_server` 새 개발 서버 띄우기 (`free_port`, then how to open it from other devices), `why_not_open` 왜 안 열려? (listening, bind scope, serve, HTTP, logs). In Claude Code they are `/mcp__portboard__<name>`.
- **Remote connector**: `portboard://status` (redacted, built from the tools' projections; 새 기기 as a count) and the two summary prompts only. Port and device resources and the other prompts fail like ones that don't exist. The remote dispatcher now delegates only `ping` and notifications to the shared one. `resources/read` and `prompts/get` are logged like tool calls.
- `initialize` advertises `resources: {}` and `prompts: {}` on both servers; the tools are unchanged.
- `scripts/remote-smoke.ts` also reads every listed resource, gets every prompt, and checks that the local-only ones are refused.

## 0.3.0 — 2026-10-17 (M2 관측 깊이)

### Dashboard
- **Uptime bars for 🔔 ports** (#9): each watched row shows its last 30 checks (Uptime Kuma style) and uptime over 24 h and 7 d. Unwatched rows are unchanged.
- **Service page** (#12): `service.html#<port>`, opened from a row's name. It shows what the service is, who is connected now, devices × last seen, uptime (24 h / 7 d / 30 d, bars, outages), the alerts sent, and the row's actions with the same guards. Works at 390 px and for a watched port that is down.

### Data
- `~/.local/state/portboard/uptime.json` (`PORTBOARD_UPTIME`): every alerts check of a watched port, as run-length segments, kept 30 days. Recorded with or without an alert channel.

### 기기 tab
- **새 기기 (new device) alert** (#10): Portboard keeps a record of known devices in `known-devices.json`, keyed by Tailscale name, MAC or IP. On the first run it seeds that record from what is visible (tailnet peers, LAN cards, the neighbour table, the last-used history), so nothing alerts on day one. After that, a device that connects to a service here for the first time gets a 새 기기 badge, shows up in a 새 기기 list at the top of the tab, and is announced once through the down-alert channel. At most one message goes out per 10 minutes; anything that comes up inside that window goes into the next message. Each entry has 이름 붙이기 (LAN devices) and 확인; naming a device also clears its badge. New MACs in the neighbour table (ARP) can alert too, but that is off by default. Settings live in `prefs.json` → `newDevices`.
- **Proxmox CPU/memory trends** (#11): CPU and memory sparklines for the last hour on the pve1 card and on guest cards, and a CPU sparkline on each guest row in the VM/CT list. Tapping one opens a 24 h chart (10-minute averages, tap or hover for a value) in the detail panel. Guests without a card of their own (jellyfin) get a detail of their own. The data is Proxmox's own RRD data read with the existing PVEAuditor token, cached 60 s.

### API / MCP
- `GET /api/ports/:port/detail`; `GET /api/alerts` adds `uptime` to watched ports.
- Local stdio MCP tool `service_detail(port)`. The remote connector is unchanged.
- `GET /api/known-devices`, `POST /api/known-devices/ack` `{key|'all'}`, `POST /api/known-devices/settings` `{connections?, neighbors?}`; `/api/usage` cards carry `newDevice` and the response has `newDevices`.
- `GET /api/proxmox/trends?timeframe=hour|day`.
- Local MCP tool `list_new_devices` (reads the file; not on the remote connector).
- ntfy alerts can carry a tap target (`click`); a new-device alert opens the device in the 기기 tab.

## 0.2.0 — 2026-10-17

The 서비스 | 기기 dashboard, compute-pool and Proxmox integration, alerts, a Mac menu bar and a read-only remote MCP.

### Dashboard
- **기기 tab** (device cards): this server, tailnet peers and LAN clients, showing what each is using right now, compute-pool host status (state, CPU, memory, disk), and the other hosts' open ports. It replaced the earlier connection-map mockup; the research behind that change is in `docs/map-research/`.
- **서비스 tab**: `사용 중` chips and a `지금 사용 중` filter. Rows that belong together are grouped (same unit, container or compose project). Each row shows when it was last used, and well-known system ports get their names (SSH, DNS, CUPS…).
- Labels, pins and hiding, a ⋯ menu (rename, hide, logs, restart, stop), a logs dialog, and installable PWA metadata.
- Served over HTTPS at `https://devbox.example.ts.net/` (`tailscale serve` 443 → 8790).

### Data
- **LAN names**: `ip neigh` gives the MAC address, the IEEE OUI list gives the vendor, and the user can name a device (`clients.json`). Same-machine detection compares SSH host keys.
- **Subnet routing**: connections that arrive through pve1's subnet route are labelled "pve1 경유", not credited to pve1.
- **Proxmox** (read-only token, pinned TLS fingerprint): the host and VM/CT tree. Guests are matched to devices by MAC, name or IP.
- **compute-pool**: host status from `GET /api/hosts`, and the other hosts' listening ports (desktop over ssh; the Mac once its worker is updated).
- **Last-used history** in `~/.local/state/portboard/usage-history.json`, with 30-day retention.

### Alerts
- Down/up alerts for ports you choose (🔔) and for tailnet devices, sent through compute-pool's ntfy/webhook channel. They are debounced and rate-limited, and suppressed after a stop or restart you made in Portboard.

### MCP
- Local stdio server tools: `list_ports`, `expose_port`, `unexpose_port`, `restart_service`, `stop_service`, `tail_logs`, `list_devices`, `free_port`, `who_uses`/`list_usage`, `name_device`, `set_alert`.
- **Remote, read-only** (`src/remote.ts`): Streamable HTTP with OAuth 2.1 + PKCE and a one-time approval code. It allows only read tools and redacts its output (no IPs, MACs, paths or commands). It is public through Tailscale Funnel on :8443.

### Mac
- SwiftBar menu bar plugin (`menubar/`, `scripts/mac-menubar-setup.sh`).
- `scripts/mac-setup.sh` registers the stdio MCP with Claude Code and Claude Desktop over SSH.

### Project
- CI (GitHub Actions) runs `npm test` on every push and PR.
- The version string comes from `package.json` alone (`src/version.ts`).
- `ROADMAP.md` (milestones M1–M4).

## 0.1.0 — 2026-10-17

- First version: a dashboard of every listening TCP port (owner, project, systemd unit, docker container, HTTP title), with direct tailnet links, one-click `tailscale serve` publishing, and copyable SSH commands.
- REST API, and a stdio MCP server for Claude Code (`list_ports`, `expose_port`, `unexpose_port`).
- Runs as a systemd user service on loopback plus the Tailscale IP.
