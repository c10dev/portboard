# MCP servers

`src/mcp.ts` is a stdio MCP server over the same core API. Its tools:

| Tool | Arguments | Result |
|---|---|---|
| `list_ports` | `query?` (filters on port, name, container, HTTP title, project or unit), `include_system?` (default `false`) | Compact per-port summary: `port`, `name`, `scope`, `http` status, `directUrl` / `servedUrl`, `canExpose` / `exposeBlocker` |
| `expose_port` | `port` | The core `ActionResult` (`ok`, `message`, and `enableUrl` while Serve is not enabled on the tailnet) |
| `unexpose_port` | `port` | The same `ActionResult`. Turns off only the entry `expose_port` makes (`https:<port>` → `127.0.0.1:<port>`, not Funnel); another entry for the port is refused with its address |
| `restart_service` | `port` | Restarts the owning systemd user unit or docker container |
| `stop_service` | `port` | Stops the owning unit/container, or SIGTERMs a plain process; refuses portboard itself |
| `tail_logs` | `port`, `lines?` (default 100, max 1000) | `{ok, source, lines[], message?}` |
| `list_devices` | none | `{pool: {available, source, …}, devices: [{name, os, online, lastSeen, path, tailscaleIps, lanIps, pool: {state, inRotation, cpuPct, load1, memAvailMb, diskFreePct, busy, …}, ports: {at, ports: [{port, scope, addresses, processes, tailnet, url}]} \| null}]}` |
| `machine_status` | `machine?` (name or id), `include?` (`load`, `claude`, `worktrees`, `ports`; default all), `fresh?` (re-read the agents, at most once a minute) | Every machine work can run on: this one, each `portboard agent`, the cloud when `machines.cloud.enabled` ([multi-host.md](multi-host.md#machines-machine_status-and-where_to_run)). Per machine `kind`, `reach`, `online`, `checkedAt`/`stale`, `load`, `claude` (sessions: 8-character `id`, `project`, `worktree` repo@branch, `idleMin`, `cpuPct`, `mb`, `idle`; `active`/`idle` counts), `worktrees` (repo@branch, `remote`, `dirty`, `inUse`, `claude`, `reservedPort`, `path` when shared), `ports` counts, `capabilities`, `maxSessions`, `launch`. Read-only. Local stdio server only |
| `find_worktree` | `repo?`, `branch?`, `query?` (part of repo@branch), `machine?`; one of the first three | `{matches: [{machine, owner, repo, branch, path, main, dirty, inUse, activeSession, reservedPort, lastCommit}], conflict}`: exact repo (folder or GitHub `owner/name`) and branch first, then the query; `conflict` when one branch is on two machines and one side has changes or an active session. Local stdio server only |
| `where_to_run` | `task?`, `repo?`, `branch?`, `needs?` (`dev-server`, `docker`, `gpu`, `macos`, `windows`, `long-running`, `parallel`, `isolated`), `prefer?`, `exclude?` | `{recommendation: {machine, score, why, caveats, how: {via, cwd, steps}}, alternatives, excluded: [{machine, reason}], dataAge}` ([how it scores](multi-host.md#how-where_to_run-decides)); without `repo`, a repo the task names. Starts nothing: a person opens the session (Desktop SSH, cloud, Remote Control, `--teleport`). Local stdio server only |
| `free_port` | `preferred?` (default 3000), `count?` (default 1) | `{ports: [...]}`: not listening, not served, outside 32768–60999 |
| `who_uses` (alias `list_usage`) | `port?` | `{historySince, ports: [{port, service, group, now: [{device, id, kind, connections}], lastUsed, recent7d}], devices: [{id, name, kind, nameKey, usingNow, lastUsed, recent7d}]}` |
| `name_device` | `key` (a `nameKey` like `mac:…`/`ip:…`, or a device id like `lan:192.168.1.7`), `name` (empty clears) | Writes `clients.json`, the same store as `POST /api/clients/name`. Tailscale devices are refused (their name comes from Tailscale). |
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
| `release_port` | `port` | Removes the reservation. Local stdio server only |
| `list_cleanup_candidates` | none | Dev servers with their owner (the starting Claude session, still running or not, and the worktree/branch) and the ones that are left over: working directory deleted, session ended, branch merged. Local stdio server only |
| `cleanup_servers` | `ports` (1–50) | Stops those candidates, each re-checked first; never installed units, docker, other users' processes or pinned ports. Local stdio server only |
| `memory_usage` | `top?` (1–50, default 10) | Where this server's RAM goes: available memory, swap, PSI, then by group; per Claude session (title or project, CLI version, idle time, MB of its tree) and per MCP server (instances, total), plus suggestions. Read-only. (also remote, redacted: groups, totals, pressure and sizes; session titles, projects and process names only with `showProcesses`) |

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
