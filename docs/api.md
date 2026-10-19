# REST API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ok, profile, port}`: `profile` is `production` or `preview` |
| GET | `/api/whoami` | `{login, source, owner, canWrite, reason?, device?, mode?, tailscale?}`: whether this caller may write (`source` `loopback`, `serve`, `direct` or `token`; `reason` in the page's language; `device` `{addr, name?, id?}` for serve, direct and token callers, from `tailscale whois`; `mode: "token"` in token mode; `tailscale: false` when Tailscale isn't running on the server) ([security.md](security.md)) |
| GET | `/api/audit?port=&limit=50` | 기록, newest first: `entries[]` with `at`, `who`, `source`, `route`, `target`, `result` (`ok`/`denied`/`error`), `status`, `detail`; `port` keeps that port's entries, `limit` 1–500. **The owner only** (#7): anyone else gets `403 {error: "owner only", reason}` ([security.md](security.md#audit-log-c10devportboard30)) |
| GET | `/api/ports` | Snapshot of every port (`?fresh` skips the 2 s cache, at most once per 5 s; see **Load bounds**) |
| GET | `/api/ports/:port/logs?lines=100` | Recent logs of whatever owns the port (max 1000 lines); the owner comes from the shared 2 s snapshot |
| GET | `/api/ports/:port/detail` | Everything for `service.html`: `entry` (the snapshot entry, null while nothing listens), `usingNow`, `lastUsed` (devices × last seen), `watch`, `uptime` (%, recent checks, 24 h and 30-day slots, outages), `events` (alerts sent); 404 when nothing is known about the port |
| GET | `/api/free-ports?count=1&preferred=3000` | Free ports for a new server |
| GET | `/api/topology` | Raw connections: who is connected to which port now (`?fresh` as for `/api/ports`); `/api/usage` is the per-device view built on it |
| GET | `/api/owners` | Owners of every listening plain process (the Claude Code session that started it, its worktree and branch) and the cleanup candidates: servers whose working directory was deleted, whose starting session ended, or whose branch is merged |
| POST | `/api/cleanup` | JSON `{ports: [...]}` (1–50): stops those candidates, each re-checked first (SIGTERM, or `systemctl --user stop` for a transient unit). Installed units, docker containers, other users' processes and pinned ports are never candidates; needs `X-Portboard: 1` |
| GET | `/api/reservations` | Port reservations (owner `repo`, `repo@branch` or a worktree path, port, note) with what listens on each port now |
| POST | `/api/reservations` | JSON `{owner, port?, note?}`: reserve. Without `port`: the owner's existing reservation, else a free one. `free_port` never offers someone else's reserved port; needs `X-Portboard: 1` |
| POST | `/api/reservations/:port/release` | Release a reservation; needs `X-Portboard: 1` |
| GET | `/api/dev-servers` | Running `pb-dev-*` units (worktree, port, since) and which known worktrees have a startable `package.json` script |
| POST | `/api/dev-servers/start` | JSON `{path, script?, port?}`: starts the worktree's `dev`, `start`, `preview` or `serve` script as a transient systemd user unit on loopback, on its reserved port (owner `<repo>@<branch>`) or a free one that then gets reserved. Only worktrees of the scanned repos; needs `X-Portboard: 1` |
| POST | `/api/dev-servers/stop` | JSON `{path}`: `systemctl --user stop` for that worktree's unit; the port stays reserved; needs `X-Portboard: 1` |
| GET | `/api/worktrees` | The last worktree scan of every repo under the repos root: branch, PR state, changes, last commit, size, processes inside, `removable` and why (`scanning: true` while one runs). `?refresh` starts a full scan, at most one forced per minute (`refresh`: `started`, `running` or `throttled`, with a `note` unless started) |
| POST | `/api/worktrees/remove` | JSON `{repo, paths}`: `git worktree remove` (never `--force`; branches stay) for each path that is still removable when re-checked; needs `X-Portboard: 1` |
| POST | `/api/worktrees/prune` | JSON `{repo}`: `git worktree prune` (records of directories already deleted); needs `X-Portboard: 1` |
| GET | `/api/memory` | The last memory sample: memory, swap and PSI, the partition by group (Claude sessions, MCP servers, services, docker, other), sessions, the hour's history, the pressure state and thresholds, and suggestions (never actions) ([memory](memory/README.md)) |
| GET | `/api/devhealth` | 기기 상태 알림 (#2): `at` (last check), `alertsOn`, `thresholds` (`devhealth.json`, [config.md](config.md#device-health-devhealthjson)), `conditions[]` (`key`, `kind` `failures`\|`guest`\|`load`, `name`, `active` (alerted), `since`, `facts`, `text`): alerted conditions and breaches still within their sustain; read-only ([operations.md](operations.md#device-health-alerts)) |
| GET | `/api/devices` | Tailnet devices joined with compute-pool host status; `tree` is the network hierarchy ([dashboard](dashboard.md#network-tree-구조)). `pvePorts` and `winPorts` (the SSH port readers) carry `reason`: why there is no fresh read, in words (`pending` and its first read waiting or running, turned off, or the error and when it retries); null when ok. A device read through its `portboard agent` has `portsSource: "agent"` and `agent` (`ok`, `error`, `checkedAt`, `lastOk`, `info` with version and load); `agents[]` lists every configured agent with the device it went to ([multi-host.md](multi-host.md)) |
| GET | `/api/usage` | One card per device with what it uses now, `idle` services, `history` (`byPort` last use, `byDevice` last 7 days), and the same `tree` as `/api/devices` |
| POST | `/api/clients/name` | JSON `{key, name}` names a LAN device (`clients.json`); needs `X-Portboard: 1` |
| POST | `/api/ports/:port/expose` · `unexpose` · `restart` · `stop` | Actions; need header `X-Portboard: 1` |
| POST | `/api/ports/:port/prefs` | JSON `{label?, pinned?, hidden?, alert?, onNew?}` (`label: ""` or `null` clears it; `onNew` `notify`\|`openBrowserOnce`\|`silent`\|`ignore`, `null` clears it); needs `X-Portboard: 1`. The port's own entry, which wins over every port rule |
| GET | `/api/port-rules` | 포트 규칙 ([config.md](config.md#port-rules)): `rules` (`key`, `kind` `port`\|`host`\|`range`\|`command`\|`otherPorts`, `rank`, `rule` `{label?, pinned?, hidden?, onNew?}`) in the order they are consulted, `exact` (ports with their own `label` or `onNew`), `problems` (ignored keys and rules, with why), `onNew` (the values) |
| POST | `/api/port-rules` | JSON `{key, rule}`: `rule` `{label?, pinned?, hidden?, onNew?}` sets those fields (`null` clears one; a rule left empty is removed), `rule: null` removes the rule. `key` `otherPorts` is the default; a single port writes that port's own entry. `{ok, key, where: ports\|portRules\|otherPorts, rule, view}`, 400 with `error` for a bad key or field; needs `X-Portboard: 1` |
| GET | `/api/new-ports?since=<id>` | New dev-server notices ([below](#new-ports)): `{latest, events}`; without `since` only `latest` (where to start) |
| GET | `/api/alerts` | Down alerts: channel kinds (`ntfy`/`webhook`, never the topic or URL), what is watched, its state and (ports) `uptime` (`checks`, `pct24h`, `pct7d`), last 5 sent |
| POST | `/api/alerts/test` | Send a test notification; needs `X-Portboard: 1` |
| POST | `/api/devices/:id/alert` | JSON `{on: boolean}`: offline alert for a tailnet device; needs `X-Portboard: 1` |
| GET | `/api/digest` | 요약 알림: `settings` (`{mode: off\|daily\|weekly, time: "HH:MM"}` in the configured `utcOffset`, default KST, weekly = Monday), `scheduled` (this process sends: production only), `channel.configured`, `nextAt`, `lastSent` |
| POST | `/api/digest` | JSON `{mode?, time?}`; answers like `GET /api/digest`; needs `X-Portboard: 1` |
| GET | `/api/digest/preview` | `?mode=daily\|weekly` (default: the setting's): `{title, body, empty, lines, period}` over the period ending now |
| POST | `/api/digest/send` | 지금 보내기: the preview, sent now (the schedule is untouched); 409 with `message` when nothing got through or there is no channel; needs `X-Portboard: 1` |
| GET | `/api/known-devices` | 새 기기: pending new devices (`key`, `name`, `kind`, `vendor`, `ip`, `scope`, `since`, `service`, `nameKey`), settings, how many are known |
| POST | `/api/known-devices/ack` | JSON `{key}` (or `"all"`) clears the 새 기기 badge; needs `X-Portboard: 1` |
| POST | `/api/known-devices/settings` | JSON `{connections?, neighbors?}` (booleans) into `prefs.json` `newDevices`; needs `X-Portboard: 1` |
| GET | `/api/suggestions` | Smart defaults: `{at, suggestions, dismissed}`; `kind: "alert"` (`port`, `reasons`, `unit`, `container`, `also`), `kind: "idle"` (`port`, `owner: {type: unit\|container\|process, name}`, `also`, `days`, `lastUsed`, `lastDevice`, `idleDays`: a service nobody has connected to for 14 days per the usage history, never stopped by Portboard; only once the history spans 14 days, a port it never saw only when its service is that old; pinned, hidden, system and Portboard's own ports left out) or `kind: "name"` (`key`, `device`, `ip`, `current`, `name`, `source`, `confidence`). Never applied by themselves |
| POST | `/api/suggestions/:id/dismiss` | 무시 (`alert-<port>`, `idle-<port>` or `name-<key>`): the id goes into `prefs.json` `suggestions.dismissed` and isn't suggested again; needs `X-Portboard: 1` |
| GET | `/api/adoption` | 채택 지표: `?days=1–7` (default 7); `{at, scanning, tookMs, days, current, previous, files}`, `current`/`previous` = `{from, to, totals, byDay, byProject, topPorts, topPrefixes, mcpTools}` (KST days). From the cached daily scan; `?refresh` starts a scan, at most one forced per 10 min (the answer adds `refresh`: `started`, `running` or `throttled`, and a `note` unless started). Counts only |
| POST | `/api/claude/session-end` | JSON `{session_id, cwd?, reason?}` from the plugin's SessionEnd hook: that session's servers become cleanup candidates (`session-ended-hook`) at once, and are stopped when `autoStop` allows it (in the background; the answer is `{recorded, autoStop}`). Loopback only (403 through tailscale serve); needs `X-Portboard: 1` ([claude-plugin/session-end.md](claude-plugin/session-end.md)) |
| GET | `/api/claude/sessions` | `ended` (the last 20 hook-ended sessions: `id`, `reason`, `at`, `cwd`), `settings.autoStop`, `lastAutoStop` (this process's last run and its results) |
| POST | `/api/claude/settings` | JSON `{autoStop: off\|scratchpad\|all}` into `prefs.json` `claudeCleanup`; needs `X-Portboard: 1` |
| GET | `/api/proxmox/trends?timeframe=hour\|day` | CPU/memory per node and guest (`nodes.<node>`, `guests["<node>/<vmid>"]`): `start`, `step`, `cpu[]`, `mem[]` (fractions, null = gap), `maxcpu`, `maxmem`; or `error` per entry |
| GET | `/api/claude/port-advice?port=N&cmd=start\|kill&cwd=…` | For the Claude Code port nudge: who holds or reserved the port, the cwd's `repo@branch`, a port to use instead, and the `[portboard]` context text, in which every name from the machine is sanitized, capped and quoted ([claude-plugin/](claude-plugin/README.md)); read-only. From the shared snapshot and short caches (see **Load bounds**) |
| GET | `/api/onboarding` | 설정 체크리스트: `items` (`key`, `title`, `status` ok/missing/warn, `detail`, `action` command or link), `ok`, `total`, `summary`; kinds and counts only, never secrets |
| GET | `/api/remote/clients` | 원격 커넥터 (#31): the remote MCP's clients (`id` c-…, `name`, `kind` registered\|hosted, `redirectHosts`, `createdAt`, `lastUsedAt`, `grants`) and authorizations (`id` g-…, `clientId`, `clientName`, `scopes`, `resourceHost`, `createdAt`, `lastUsedAt`, `accessExpiresAt`, `expiresAt`), plus `pendingApproval`, `approvalExpiresAt` (ms, null when none is pending), `publicUrl` (boolean), `connectorUrl` (the URL to paste: `publicUrl` + `/mcp`, null when not public) and `profile`. This profile's `remote.json`; derived ids only, never a token, hash or client_id ([runbooks/remote-connector.md](runbooks/remote-connector.md)) |
| POST | `/api/remote/clients/<id>/revoke` | Every token of that client and its registration (a hosted claude.ai/ChatGPT client has none): `{revoked: {tokens, registration}}`, 404 for an unknown id; needs `X-Portboard: 1`. The remote server refuses the tokens on its next request |
| POST | `/api/remote/tokens/<id>/revoke` | One authorization (its access and refresh tokens, rotated ones too): `{revoked: {tokens}}`, 404 for an unknown id; a pending approval code stays; needs `X-Portboard: 1` |
| POST | `/api/remote/approval-code` | 승인 코드 만들기 (설정 tab): the same one-time code as `node src/remote.ts approve`, 10 min, single use, replacing a pending one: `{code, expiresAt, ttlMs, replaced}`. Owner only like every write (`X-Portboard: 1`, the owner login through serve, the write-device allowlist); the audit line and the server log never hold the code. No MCP tool makes one, local or remote (settings/) |
| GET | `/api/settings` | 설정 tab: `version`, `profile`, `port`, `running` (this process's commit), `deployed` (`{commit, at}` from `~/.local/state/portboard/deployed.json`), `addresses` (`dashboard` https via serve, `connector` the public /mcp URL, `connectorPort`, `direct` http :8790), `docs`, `secrets` (`key`, `title`, `status`, `detail`, `expiresAt`, `runbook`: statuses and dates only, never a value) |
| GET | `/api/settings/write-devices` | 쓰기 허용 기기: `path`, `list` (access.json's writeDevices, null when unset), `env` (PORTBOARD_WRITE_DEVICES, read-only), `error`, `devices` (the owner's untagged tailnet devices but this server: `name`, `os`, `listed`, `current`), `others` (listed entries matching none), `current` (the serve caller's device), `source` |
| POST | `/api/settings/write-devices` | JSON `{writeDevices: [names or node IDs]}` (1–100): replaces access.json's writeDevices (0600, atomic, other keys kept) and answers like the GET with a `message`. 409 when the list leaves out the device the request comes from (no locking yourself out; loopback is always the owner) or access.json isn't a JSON object; 400 for an empty or malformed list; needs `X-Portboard: 1` |

## New ports

`GET /api/new-ports` is what the dashboard's toast (`public/features/newports.js`) and, later, the Mac app read to learn that a dev server came up ([config.md](config.md#new-ports-onnew)). The server looks every 15 s. Only ports whose `onNew` is `notify` or `openBrowserOnce` make an event; the server keeps the last 50, at most an hour old, in memory.

- Without `since`: `{latest, events: []}`. Start from `latest`, so a client that opens later never replays old events.
- With `since=<id>`: `{latest, events}`, the events with `id` greater than `since`, oldest first. Keep `max(since, latest)` for the next call.
- Ids grow by one per event and start at the server's start time in ms, so after a restart every new id is greater than any old one, and a client's cursor still works.
- A `since` that isn't a number is answered with 400.

```json
{
  "latest": 1760851200007,
  "events": [
    {
      "id": 1760851200007,
      "at": "2026-10-19T05:20:15.000Z",
      "port": 5173,
      "name": "Vite App",
      "action": "notify",
      "command": "node /home/dev/projects/myapp/node_modules/.bin/vite --port 5173",
      "project": "myapp",
      "rule": "default",
      "open": null,
      "canExpose": true
    }
  ]
}
```

| Field | |
|---|---|
| `id` | The cursor (see above) |
| `at` | When the server first saw the port listening |
| `port`, `name` | The port and its display name (label or detected name) at that moment |
| `action` | `notify`: show a notification with 열기 / tailnet 공개. `openBrowserOnce`: open (or offer to open) `open` once |
| `command` | The owning process's command line (cut at 300 characters), `docker: <name>` for a container, or null |
| `project` | The project folder under `~/projects`, or null |
| `rule` | Where `onNew` came from: `port`, `rule:<key>`, `otherPorts` or `default` |
| `open` | A URL a tailnet device can open (the `tailscale serve` URL, else `http://<host>:<port>` when it is bound to the tailnet or all interfaces), or null for a loopback-only port |
| `canExpose` | `POST /api/ports/:port/expose` can publish it (then `open` is the served URL on the next snapshot) |

**Load bounds.** Reads are open to every tailnet device, so the ones that start heavy work are bounded on the server. None of them answers an error for asking too often: they answer with the running or latest result.

| Read | Bound |
|---|---|
| `GET /api/ports`, `/api/topology`, `/api/usage` | one computation at a time, shared by every caller; reused for 2 s; `?fresh` skips that cache at most once per 5 s, and otherwise is served like a plain request. A write (expose, stop, prefs…) still makes the next read compute anew |
| `GET /api/worktrees?refresh` | one scan at a time; a forced full scan at most once per 60 s. The answer adds `refresh` (`started`, `running` or `throttled`) and, unless started, a `note`; it is the running or last scan. `list_worktrees {refresh: true}` adds the same `note` |
| `GET /api/adoption?refresh` | one transcript scan at a time; a forced one at most once per 10 min (same `refresh` / `note`; `adoption_stats {refresh: true}` too) |
| `GET /api/ports/:port/logs` | the owner from the shared 2 s snapshot, not a new one per request |
| `GET /api/claude/port-advice` | the shared 2 s snapshot (free ports come from it: no `ss` or `tailscale serve status` per request), reservations cached 2 s, the cwd's `repo@branch` cached 10 s per cwd (at most 200 cwds, one git call per cwd at a time) |

**Writes.** Every `POST` needs `X-Portboard: 1` and an owner caller: a process on this machine talking to 127.0.0.1 directly, or the owner's Tailscale login through `tailscale serve` (https). A tailnet device on `http://<host>:8790`, a tagged device, another user and Funnel get `403 {error: "owner only", reason}` before the body is read. Every write, allowed or denied, goes into the audit log (`GET /api/audit`). See [security.md](security.md).

## Agent API (`portboard agent`)

A separate process on another machine, on :8797, read-only: `GET /agent/v1/info`, `/agent/v1/ports`, `/agent/v1/usage`. Readers are loopback, a bearer token or a Tailscale identity on `agent.allow`; every other method is 405. The routes, the auth and what is redacted: [multi-host.md](multi-host.md).
