# MCP servers

`src/mcp.ts` is a stdio MCP server over the same core API. Its tools:

| Tool | Arguments | Result |
|---|---|---|
| `list_ports` | `query?` (filters on port, name, container, HTTP title, project or unit), `include_system?` (default `false`) | Compact per-port summary: `port`, `name`, `scope`, `http` status, `directUrl` / `servedUrl`, `canExpose` / `exposeBlocker` |
| `expose_port` | `port` | The core `ActionResult` (`ok`, `message`, and `enableUrl` while Serve is not enabled on the tailnet) |
| `unexpose_port` | `port` | The same `ActionResult`. Turns off only the entry `expose_port` makes (`https:<port>` → `127.0.0.1:<port>`, not Funnel); another entry for the port is refused with its address |
| `restart_service` | `port` | Restarts the owning systemd user unit or docker container |
| `stop_service` | `port` | Stops the owning unit/container, or SIGTERMs a plain process; refuses Portboard itself: its units (`portboard-remote.service`, `portboard-agent.service`) and its processes without one (`bin/portboard …`, also through npx, or `src/server.ts` and the other entry points of a folder whose `package.json` is Portboard's), previews included |
| `tail_logs` | `port`, `lines?` (default 100, max 1000) | `{ok, source, lines[], message?}` |
| `list_devices` | none | `{pool: {available, source, …}, devices: [{name, os, online, lastSeen, path, tailscaleIps, lanIps, pool: {state, inRotation, cpuPct, load1, memAvailMb, diskFreePct, busy, …}, ports: {at, ports: [{port, scope, addresses, processes, tailnet, url}]} \| null}]}` |
| `machine_status` | `machine?` (name or id), `include?` (`load`, `claude`, `worktrees`, `ports`; default all), `fresh?` (re-read the agents, at most once a minute) | Every machine work can run on: this one, each `portboard agent`, the cloud when `machines.cloud.enabled` ([multi-host.md](multi-host.md#machines-machine_status-and-where_to_run)). Per machine `kind`, `reach`, `online`, `checkedAt`/`stale`, `load`, `claude` (sessions: 8-character `id`, `project`, `worktree` repo@branch, `idleMin`, `cpuPct`, `mb`, `idle`; `active`/`idle` counts), `worktrees` (repo@branch, `remote`, `dirty`, `inUse`, `claude`, `reservedPort`, `ahead`/`behind` its upstream as of the last fetch, `path` when shared), `ports` counts, `capabilities`, `maxSessions`, `launch`. The cloud's `claude` is an estimate from recent `claude/*` branches (`source: "github"`, no ids, `remote` the GitHub owner/name). Read-only. Also on the [remote server](remote-mcp/README.md#tools-allowlist), redacted: from the list the dashboard last read, no `fresh`, no session ids, paths or git remotes |
| `find_worktree` | `repo?`, `branch?`, `query?` (part of repo@branch), `machine?`; one of the first three | `{matches: [{machine, owner, repo, branch, path, main, dirty, inUse, activeSession, reservedPort, lastCommit}], conflict}`: exact repo (folder or GitHub `owner/name`) and branch first, then the query; `conflict` when one branch is on two machines and one side has changes or an active session. Local stdio server only |
| `where_to_run` | `task?`, `repo?`, `branch?`, `needs?` (`dev-server`, `docker`, `gpu`, `macos`, `windows`, `long-running`, `parallel`, `isolated`), `prefer?`, `exclude?` | `{recommendation: {machine, score, why, caveats, how: {via, cwd, steps}}, alternatives, excluded: [{machine, reason}], dataAge}` ([how it scores](multi-host.md#how-where_to_run-decides)); without `repo`, a repo the task names. Starts nothing: a person opens the session (Desktop SSH, cloud, Remote Control, `--teleport`). Local stdio server only |
| `free_port` | `preferred?` (default 3000), `count?` (default 1), `for?` (an owner, as for `reserve_port`) | `{ports: [...]}`: not listening, not served, not reserved for another owner, outside 32768–60999; with `for`, that owner's reserved ports first |
| `who_uses` (alias `list_usage`) | `port?` | `{historySince, ports: [{port, service, group, now: [{device, id, kind, connections}], lastUsed, recent7d}], devices: [{id, name, kind, nameKey, usingNow, lastUsed, recent7d}]}` |
| `name_device` | `key` (a `nameKey` like `mac:…`/`ip:…`, or a device id like `lan:192.168.1.7`), `name` (empty clears) | Writes `clients.json`, the same store as `POST /api/clients/name`. A non-empty name also clears the device's 새 기기 mark through the running server (`acknowledged`: how many marks were cleared, null when the server could not be reached or refused the write, for example token mode with `requireTokenOnLoopback` or read-only mode; the name is saved either way). Tailscale devices are refused (their name comes from Tailscale). |
| `set_alert` | `port`, `on` | Turns the down/up push alert for a port on or off (`alert` in `prefs.json`); `{ok, port, alert}` |
| `digest_preview` | `period?` (`daily`/`weekly`, default the setting's) | The 요약 알림 text over the period ending now (`title`, `body`, `empty`), the setting, `nextAt`, `lastSent`; sends nothing |
| `set_digest` | `mode` (`off`/`daily`/`weekly`), `time?` (`HH:MM` in the configured `utcOffset`, default KST) | Writes `digest` in `prefs.json`; `{ok, settings, nextAt}`. Local only |
| `service_detail` | `port` | One port in full: `service` (list_ports fields plus unit, container, compose project, group, HTTP title), `usingNow`, `lastUsed` (devices × last seen, minutes 7 d / 30 d), `alert`/`alertState`, `uptime` (`pct24h`/`pct7d`/`pct30d`, `recentChecks`, `outages`), `alertsSent`. Local stdio server only, not the remote connector. |
| `list_new_devices` | none | 새 기기 not acknowledged yet, with `nameKey` for `name_device`, plus the settings (reads `known-devices.json`; the server keeps it) |
| `setup_status` | none | 설정 체크리스트: `{items: [{key, title, status: ok\|missing\|warn, detail, action: {kind: command, text} \| {kind: link, href, label} \| null}], ok, total, summary}` for the alert channel, Proxmox token, SSH keys, Mac agent and menu bar, claude.ai connector, Claude Code MCP and first use. Never secrets. Local stdio server only, not the remote connector. |
| `list_suggestions` | none | Smart defaults, never applied by themselves: `alert` (pinned / installed systemd unit / long-lived container without a down alert: turn on with `set_alert`), `idle` (a unit, container or process nobody has connected to for 14 days per the usage history, with `owner`, `lastUsed`, `lastDevice` and `idleDays`: a cleanup hint for the user, nothing stops it; not before the history spans 14 days) and `name` (a better name for a LAN device: accept with `name_device {key, name}`); dismissed ones left out. `list_new_devices` entries carry the same name as `suggestedName`. Local stdio server only |
| `list_port_rules` | none | 포트 규칙 ([config.md](config.md#port-rules)): `rules` in the order they are consulted (`key`, `kind`, `rank`, `rule`), `exact` (ports with their own label or onNew; those always win), `problems` (what in `prefs.json` was ignored). Local stdio server only |
| `set_port_rule` | `key` (`3000-3010`, `localhost:5173`, a command-line regex such as `vite\|next dev`, `otherPorts`, or one port), `label?`, `pinned?`, `hidden?`, `onNew?` (`notify`/`openBrowserOnce`/`silent`/`ignore`; `null` clears a field), `remove?` | Writes `prefs.json`: a single port into that port's own entry (like a rename), anything else into `portRules`. `{ok, key, where, rule}`. Local stdio server only |
| `adoption_stats` | `days?` (1–7, default 7), `refresh?` | 채택 지표: how Claude Code sessions on this machine handled ports over `days` KST days ending today and the same span before: Portboard MCP calls, raw inspection (`ss -ltn`, `lsof -i`, …), kill-by-port, servers started on a hard-coded port, Portboard nudges, per day and per project, top ports and command prefixes. Counts only, from the daily cached scan (`refresh` rescans). Local stdio server only |
| `list_worktrees` | `repo?` (name), `refresh?`, `removable_only?` | Every git worktree of the scanned repos: branch, PR state, uncommitted changes, last commit, size, processes inside, and whether it can go safely (merged by ancestry or by a merged PR, no changes, no process, not locked). From the last background scan; `refresh` waits for a new one. (also remote, redacted: no paths, commit messages or processes; no `refresh`, from the saved scan; see [remote-mcp](remote-mcp/README.md#tools-allowlist)) |
| `remove_worktrees` | `repo` (main repository path), `paths` (1–200) | `git worktree remove` (never `--force`; branches stay) for each path still removable when re-checked. Deletes the directories: the model is told to ask the user first. Local stdio server only |
| `list_dev_servers` | none | Running `pb-dev-*` units (worktree, port, since) and which worktrees have a startable `package.json` script. (also remote, redacted: `<repo>@<branch>`, port, state and script names; no paths, units or commands) |
| `start_dev_server` | `path` (worktree), `script?` (`dev`/`start`/`preview`/`serve`), `port?` (1024–65535) | Starts the script as a transient systemd unit on loopback, on the worktree's reserved port or a free one that then gets reserved; carries the calling Claude session so SessionEnd cleanup covers it. Logs: `tail_logs`. Local stdio server only |
| `stop_dev_server` | `path` | `systemctl --user stop` for that worktree's unit; the port stays reserved. Local stdio server only |
| `write_launch_config` | `path` (worktree), `script?` (`dev`/`start`/`preview`/`serve`), `mode?` (`run`/`attach`) | Writes a `portboard` entry into the worktree's `.claude/launch.json`, the file Claude Code Desktop's preview reads: the worktree's reserved port (reserving one if needed) with `autoPort: false`, either running the script (`run`) or attaching to the server Portboard already runs (`attach`, the default when there is one). Other entries are kept; a file with comments, one tracked by git, or a symlinked `.claude` is left alone and the entry is returned to paste. Adds `/.claude/launch.json` to the repo's `info/exclude`. Local stdio server only |
| `list_reservations` | none | Reserved ports with owner, note and what listens now. Local stdio server only |
| `reserve_port` | `owner` (repo, `repo@branch` or worktree path), `port?`, `note?` | A stable port for that owner: without `port`, its existing reservation or a free one. `free_port {for: owner}` returns it first and never offers it to anyone else. Local stdio server only |
| `release_port` | `port`, `owner` | Removes the reservation when `owner` is the one it was reserved for; another owner's stays (error). Local stdio server only |
| `list_cleanup_candidates` | none | Dev servers with their owner (the starting Claude session, still running or not, and the worktree/branch) and the ones that are left over: working directory deleted, session ended, branch merged. Local stdio server only |
| `cleanup_servers` | `ports` (1–50) | Stops those candidates, each re-checked first; never installed units, docker, other users' processes, pinned ports or Portboard itself (see `stop_service`). Local stdio server only |
| `memory_usage` | `top?` (1–50, default 10) | Where this server's RAM goes: available memory, swap, PSI, then by group; per Claude session (title or project, CLI version, idle time, MB of its tree) and per MCP server (instances, total), plus suggestions. Read-only. (also remote, redacted: groups, totals, pressure and sizes; session titles, projects and process names only with `showProcesses`) |
| `list_accounts` | none | The Claude Code and Codex logins on this machine, and the Claude, Codex and GitHub Copilot accounts the owner added in the dashboard (`source: "added"`, with `alias`): plan, tier, email (Codex), access token expiry and remaining limits (5-hour and weekly windows; none for Copilot), from the two CLI login files, Portboard's own `accounts.json` and each vendor's unofficial usage endpoint (cached 5 minutes). The answer also has `proxy`: the account pool proxy's `enabled`, `state` (`unknown` in this stdio process while the settings are on, because the dashboard opens the proxy), `port`, `url`, `current` (`claude` and `codex`), `resting`, `events` (with `provider`), `counts` and `unproxied`, never a key ([accounts.md](accounts.md#proxy)). Each added account also has `active` and, once the owner chose "use this account" in the dashboard, the `command` that starts its CLI in its own folder. Never returns a token, never refreshes one, cannot add, use or remove an account. Answers "accounts disabled" unless `accounts.enabled` is set in `portboard.json` ([accounts.md](accounts.md)). Read-only. Local stdio server only |

**Resources** (`src/mcp/resources.ts`), JSON, read on demand:

| URI | Content |
|---|---|
| `portboard://status` | 서버 상태 요약: devices online / total and which are offline, compute-pool health (`healthy` is false when a host is `degraded`, `wsl-down`, `host-down` or `auth`), services in use with who uses each, watched (🔔) ports and devices that are down, 새 기기 not acknowledged yet. A source that can't be read leaves its section `null` and is named in `unavailable`. |
| `portboard://port/{port}` | the `service_detail` report for one port |
| `portboard://device/{id}` | one device from `list_devices` (by id or name) plus its `who_uses` entry (what it uses now, last 7 days); LAN cards by their `lan:<ip>` id, percent-encoded |

`resources/list` returns the status, every visible listening port and every device as concrete entries (clients like Claude Code only offer listed resources in their `@` menu); `resources/templates/list` has the two templates. An unknown URI is `-32002`, a malformed port or id `-32602`.

**Prompts** (`src/mcp/prompts.ts`): Korean instructions that name the tools to call. `prompts/get` does no I/O.

| Prompt | Title | Arguments |
|---|---|---|
| `server_status_summary` | 서버 상태 요약 | none |
| `port_cleanup` | 포트 정리 제안 | `days?` (1–30, default 7): unused for this long → candidate. Proposes only; nothing is stopped until you pick. |
| `new_dev_server` | 새 개발 서버 띄우기 | `project?`, `preferred?` (1024–65535): `free_port` → start it → `list_ports` → `expose_port` / `directUrl` for other devices |
| `why_not_open` | 왜 안 열려? | `port`, `from?`: listening? → bind scope → served → HTTP → `tail_logs` → the device side |

Arguments are strings (as MCP sends them); a blank optional argument counts as absent, an unknown one or a bad number is `-32602`. The capabilities are plain `resources: {}` and `prompts: {}` (no subscriptions, no list-changed notifications), so clients that ignore them see the same tools as before.

| Client | Prompts | Resources |
|---|---|---|
| Claude Code | slash commands: `/mcp__portboard__server_status_summary`, `/mcp__portboard__why_not_open 3000` | `@portboard:portboard://status` in a message; the model can also list and read them |
| Claude Desktop | the + menu → portboard | attach from the same menu |

These are where the clients put them; the protocol side is tested (`test/mcp-resources.test.ts`), the client menus have not been tried yet.

`list_ports` also returns `label`, `pinned`, `control` (`systemd: …`, `docker: …` or `process: pid …`), `canRestart` and `canStop`, `alert` (down alerts on), `group` (`{name, ports, role}` when other ports share the owner) and `lastUsed` (`{at, by}` from the history file), and leaves out system, ephemeral and hidden ports unless `include_system` is true. The MCP process reads the history the server writes; it doesn't sample on its own.

Logs can contain secrets that services print (for example login tokens in URLs). They only go to tailnet devices and to the MCP client that asked.

A failed action comes back as a tool error (`isError: true`) with the full `ActionResult`, so the model sees `enableUrl` and can pass it on. The server is hand-rolled newline-delimited JSON-RPC (about 150 lines) rather than `@modelcontextprotocol/sdk`, which would pull express, hono and zod into a project that otherwise has no dependencies.

**Claude Code on this server:**

```bash
claude mcp add portboard -- node /home/dev/projects/portboard/src/mcp.ts
```

Add `--scope user` to make it available in every project, not only the current one. Check it with `claude mcp list`.

Or install the Claude Code plugin instead, which brings this server plus a skill and hooks: [claude-plugin/](claude-plugin/README.md) (remove the `claude mcp add` entry first, or you get two servers).

**From a Mac (Claude Code and Claude Desktop):** the server reads this machine's sockets, so it has to run here; the Mac launches it over SSH across the tailnet. `bin/portboard-mcp` is the SSH entry point: it finds `node` itself, because a non-interactive SSH session doesn't load nvm.

Run once on the Mac (needs password-less key login to the server). The argument is the server's SSH target with its MagicDNS name (or set `PORTBOARD_REMOTE`); here, production:

```bash
scp dev@devbox.example.ts.net:projects/portboard/scripts/mac-setup.sh /tmp/ && bash /tmp/mac-setup.sh dev@devbox.example.ts.net
```

[`scripts/mac-setup.sh`](../scripts/mac-setup.sh) checks SSH key login and that the MCP server answers, then registers `portboard` with Claude Code (`claude mcp add --scope user`, if the CLI is installed) and adds it to `~/Library/Application Support/Claude/claude_desktop_config.json` (backup kept as `.bak-portboard`). Re-running it is safe. Restart the Claude app afterwards. The entry it writes:

```json
{
  "mcpServers": {
    "portboard": {
      "command": "ssh",
      "args": [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
        "dev@devbox.example.ts.net",
        "projects/portboard/bin/portboard-mcp"
      ]
    }
  }
}
```

To try it by hand:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_ports","arguments":{}}}' | node src/mcp.ts
```

Resources and prompts the same way:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"portboard://status"}}' '{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"why_not_open","arguments":{"port":"3000"}}}' | node src/mcp.ts
```

## The plugin's two modes

The Claude Code plugin starts `claude-plugin/bin/mcp.mjs` for each session. It runs in one of two modes, chosen when the session starts:

| Mode | What runs in the session's process | Size |
|---|---|---|
| thin | `src/mcp/thin.mjs`. It sends each JSON-RPC line to the dashboard (`POST /api/mcp`) and prints the answer. It loads no feature module. | about 59 MB idle. Both files are plain JavaScript (`.mjs`), so Node does not load its TypeScript type stripper (about 19 MB). |
| local | `src/mcp.ts`, as before: the whole server in the session's process. | about 115 MB |

How `bin/mcp.mjs` chooses:

1. `PORTBOARD_MCP_MODE=local` picks local without asking. This is the switch to go back.
2. Otherwise it sends `GET <PORTBOARD_URL>/api/mcp/ping` with a 300 ms limit. `PORTBOARD_URL` defaults to `http://127.0.0.1:8790`, as for the plugin's hooks.
3. `200` with `ok: true` picks thin. Everything else picks local: no dashboard, no answer in 300 ms, `403` (token mode, a read-only install, or a caller that may not write), `404` (an older dashboard).

The ping says `200` only when `POST /api/mcp` would accept the same caller, so a thin client never starts against a dashboard that will then refuse it.

`PORTBOARD_URL` may be `https:` too; `node:https` is loaded only then, so it costs nothing otherwise.

The ping answer holds the dashboard's `version`. When it differs from this checkout's version, the plugin writes one line to stderr and still runs thin. The tool list is then the dashboard's, not the checkout's, until the dashboard is deployed again.

`claude mcp add portboard -- node src/mcp.ts` always runs local. Only the plugin has two modes.

Thin mode, during a session:

- A request that cannot connect (connection refused, or no connection within 2 s) is sent once more after 1 s. If that fails too, the session switches to local for good and answers that request in its own process. This keeps tools working while the dashboard restarts for a deploy.
- A session that has switched stays local until it ends. It does not return to thin mode when the dashboard is back. A restart that takes longer than the 1 s retry window therefore leaves every session that called a tool during it at the local size.
- A request that was already sent is never sent again, and the mode does not change: a write tool may have run (`restart_service` can restart the dashboard itself). A dropped connection, a `5xx`, a `403`, `404` or `405` in mid-session, or no answer in 10 minutes becomes the JSON-RPC error `-32603` `Portboard dashboard request failed: <status or error>` for that request id. A notification that fails is dropped.
- A line that is not JSON gets `-32700` and is not sent. Empty lines are skipped.
- When stdin closes, the client finishes the requests in flight and exits with code 0.

The thin client sends `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` from its own environment as the headers `X-Portboard-Session` and `X-Portboard-Claude-Pid`, so `start_dev_server` tags the unit with the calling session. Without them (Claude Desktop) the unit has no session, as for the stdio server.

### In thin mode

The tools run inside the dashboard process, not in the session's. So the dev server's `PATH` comes from the dashboard's Node, `list_suggestions` treats the dashboard's own unit as its own, and the stop tools refuse the dashboard's own pid. These are the answers the dashboard's REST routes give for the same actions.

### `POST /api/mcp` and `GET /api/mcp/ping`

`POST /api/mcp` takes one JSON-RPC message (not a batch, 1 MB at most) and answers `200` with the JSON-RPC reply, or `204` for a notification. The dashboard builds the stdio server's `Core` once, on first use, and calls the same `handleMessage` as `src/mcp.ts`. Its caches are separate from the dashboard's own. The route has the checks of every write route: `X-Portboard: 1`, a read-only install, and the machine owner (`403`). Its handler also requires a local process (`403 {error: "loopback only"}`), also when the owner check passed. The security notes are in [security.md](security.md#mcp-through-the-dashboard).

The same route and the `command` argument of `GET /api/claude/port-advice` are what a thin client needs: the hook and the MCP client carry no copy of the feature code.

A write tool called this way is one audit line with `source: "mcp"`, as for the stdio server. The route itself leaves no line for a successful call.

### What this does not cover

`GET /api/claude/port-advice?command=` takes a Bash command of at most 4096 characters. A longer one answers `200 {text: null}`. The hook (`claude-plugin/hooks/port-nudge.ts`) still parses up to 20000 characters itself, so it still reads commands of 4097 to 20000 characters. A client that sends the command to the dashboard instead gives no nudge for those. That is a known loss. A long command made of non-ASCII characters can be refused by Node with `431` before the handler runs (the cap counts characters, not the encoded query), so a caller must treat any non-200 as "no advice".
