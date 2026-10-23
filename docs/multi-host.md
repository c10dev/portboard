# Multi-host: `portboard agent`

One Portboard install describes one server. Other machines used to show up only through compute-pool's `/api/hosts` or the Proxmox and Windows SSH readers, and the host picker could only list their ports. With **agent mode** (c10dev/portboard#10) each other machine runs a small, read-only `portboard agent`, and one board (the dashboard you already run) reads every agent it is told about.

```
 desk (Linux/WSL)      mac                 nas
 portboard agent       portboard agent     portboard agent       read-only JSON on :8797, tailnet only
        \                  |                  /
         \_________________|_________________/
                           |
                 devbox: portboard start          the board: 기기 tab, host picker, /api/devices
```

An agent needs no compute-pool, no SSH key and no dashboard of its own. Where both an agent and compute-pool report a machine's ports, the agent's list is used; compute-pool's load and rotation state still show on the card.

## On each machine: run the agent

```bash
npm i -g @c10dev/portboard
portboard agent                          # foreground, :8797 on 127.0.0.1 and this node's Tailscale IPv4
portboard install-service --agent        # or: a systemd user unit, portboard-agent.service, alone
```

Then say who may read it, in that machine's `~/.config/portboard/portboard.json`:

```json
{
  "agent": {
    "allow": ["devbox"],
    "port": 8797
  }
}
```

### Who may read

Checked in this order; the first that applies decides:

1. **Loopback.** A process on the agent's own machine (`curl http://127.0.0.1:8797/agent/v1/info`). A request that carries a proxy header (`tailscale serve` proxies from 127.0.0.1 too) does not count as loopback.
2. **Bearer token.** `Authorization: Bearer <token>` equal to `agent.token` or `PORTBOARD_AGENT_TOKEN`, compared in constant time. A token that is sent and wrong is refused with 401; it is never tried as anything else.
3. **Tailscale identity.** The caller's tailnet address is looked up with `tailscale whois` (cached per address; addresses outside 100.64.0.0/10 and fd7a:115c:a1e0::/48 are never looked up). It may read when `agent.allow` (or `PORTBOARD_AGENT_ALLOW`, a comma list, merged) names:
   - its node: the short or full MagicDNS name (`devbox`, `devbox.example.ts.net`) or its stable node ID (`nAbC123CNTRL`);
   - its login (`owner@example.com`), for an untagged node;
   - one of its ACL tags (`tag:portboard`).

With neither an allowlist nor a token only loopback reads, and the agent says so at start. Everything else gets `403 {"error":"not allowed"}`.

The Host header must be a name of the machine (its host name, MagicDNS name, Tailscale IPs, loopback): a DNS-rebinding page gets 421. The agent never binds a wildcard address; `PORTBOARD_AGENT_HOSTS` replaces the bind list (`127.0.0.1` alone for a test).

### What it serves

| Method | Path | |
|---|---|---|
| GET | `/agent/v1/info` | `{schema: 1, version, host, dnsName, at, load: {cores, load1, memTotalMb, memAvailMb, diskFreePct, uptimeSec}}` |
| GET | `/agent/v1/ports` | `{schema: 1, at, host, listening, services}`: `listening` is one row per bind address, `{port, address, process?}`, the shape compute-pool's `/api/hosts` uses; `services` is the remote connector's `list_ports` projection (names, kinds, HTTP titles, tailnet URLs), system ports included |
| GET | `/agent/v1/usage` | Who uses what on that machine, the remote connector's `who_uses_what` projection, plus `schema` |
| GET | `/agent/v1/status` | What [machine_status](#machines-machine_status-and-where_to_run) shows of that machine: `{schema: 1, at, host, load, claude, worktrees, ports: {listening, devServers}, capabilities}`. Its `schema` is its own (info, ports and usage stay at 1), so an older board keeps reading a newer agent and a newer board gets a `404` from an older agent and shows load only |

Any other method is `405` (the agent is read-only); any other path `404`. Answers are `no-store`.

What never leaves the machine: pids, command lines, working directories, unit descriptions, ssh commands, MAC addresses, and LAN or docker addresses (they become `[lan-ip]` / `[ip]`). Bind addresses keep their class: `0.0.0.0`, `::`, loopback and the machine's own Tailscale IPs, which the board needs to tell "every interface" from "only on that device". `agent.showAddresses: true` keeps LAN addresses too, for a board that should link to them. A process is named by its container, its systemd unit or the first word of its command line without the path (`node`, never `node /home/…/server.js --token=…`).

`/agent/v1/status` carries Claude Code sessions as an 8-character id, the project folder, the `repo@branch` worktree, idle minutes, CPU and MB (never titles or transcript text), and checkouts as `repo@branch`, GitHub `owner/name`, dirty file count, in use, Claude Code worktree and reserved port. Worktree paths are `null` unless `agent.showPaths: true`. Its checkouts come from the dashboard's saved worktree scan on that machine while it is under an hour old, else from a scan the agent runs itself every 15 minutes (never while a request waits).

The agent reads the snapshot and usage from that machine's own dashboard over loopback when one runs there (as the remote MCP server does, #5); otherwise it computes them itself, cached for 2 s (usage 5 s).

## On the board: list the agents

In the board's `portboard.json`:

```json
{
  "agents": [
    { "name": "desk", "url": "http://desk.example.ts.net:8797" },
    { "name": "mac", "url": "http://100.64.10.3:8797" },
    { "name": "nas", "url": "http://nas.example.ts.net:8797", "token": "…" }
  ]
}
```

- `name`: a host name (letters, digits, `.`, `_`, `-`), unique. It is matched to a tailnet device: first by the MagicDNS name the agent reports, then by the Tailscale IP in `url`, then by `name` or the host name the agent reports against the device's name. An agent that matches no device gets a card of its own (`agent:<name>`).
- `url`: `http` or `https`, no credentials in it; a trailing `/` is dropped.
- `token`: optional; sent only as `Authorization: Bearer` to that agent. Keep the file `0600` (it is under `~/.config/portboard/` by default). Without a token the board authenticates by its own Tailscale identity: put the board's node name in each agent's `agent.allow`.

The board reads `/agent/v1/info`, `/agent/v1/ports` and `/agent/v1/status` from every agent at most every 10 s, when `/api/devices` or `/api/usage` is asked (새로고침 reads again at once). Each agent is independent:

- A failure is a fixed code, never the agent's own text: `unreachable`, `timeout`, `auth` (401/403), `http` (another status), `bad-answer` (not JSON, another `schema`, a missing field, over 4 MB).
- A failing agent backs off: 15 s, 30 s, 1 min … up to 5 min between tries.
- Its last good ports stay on its card, with the time they were read; the host picker marks the host 에이전트 응답 없음 / "agent not answering".
- `/agent/v1/status` is optional: a `404` (an agent older than machine_status) leaves the status empty, and any other failure keeps the last good one, without failing the agent.

`/api/devices` carries each device's `agent` (`name`, `url`, `ok`, `pending`, `error`, `checkedAt`, `lastOk`, `failures`, `nextAt`, `info`) and `portsSource: "agent"`, plus `agents[]` with the device each agent went to. The remote connector's `list_devices` gets the state and version only, never the URL or the load numbers.

## Machines: machine_status and where_to_run

The board's stdio MCP server (and `GET /api/machines`, `/api/where-to-run`, `/api/find-worktree`) puts every machine work can run on in one list: this machine, each agent above, and the cloud when you turn it on. Three read-only tools use it, on the local stdio server only ([mcp.md](mcp.md)):

- `machine_status`: per machine its kind, online, data age (stale after 60 s), load, Claude Code sessions (active and idle), checkouts, port counts, capabilities, `maxSessions` and how to open a session there (`launch`).
- `find_worktree`: which machines have a repo or branch checked out, and a `conflict` note when one branch is on two machines and one side has changes or an active session.
- `where_to_run`: the machine to run a task on, why, the caveats, how to open the session there (the Desktop app's SSH session, a cloud session, Remote Control, `--teleport`), alternatives and the machines left out.

**Portboard never starts anything on another machine.** The answer says where; a person opens the session.

On the dashboard: the 기기 (Devices) tab has a **Machines** strip above the map, one card per machine with CPU and memory bars, sessions against `maxSessions`, checkouts with work in them and how old the data is; a card opens a panel with its sessions and checkouts. The 개발 (Dev) tab lists the other machines' checkouts under the same repo, read-only and marked with their machine, has a machine filter in its filter menu, and badges a checkout whose `repo@branch` is also on another machine (amber when there are changes or a session there). Each checkout shows `↑ahead ↓behind` against its upstream (amber when behind), and a repo with `claude/*` branches pushed from elsewhere lists them under its header. The cloud card shows its estimated sessions. **Where to run…** (on the strip and in the ⌘K palette) asks `where_to_run` with a sentence. The strip stays hidden while no other machine is listed.

The Claude Code plugin brings these into sessions: the `where-to-run` skill, the `/portboard:where`, `/portboard:machines` and `/portboard:wt` commands, and, with its `multi_machine_hint` option, a session-start line when the session's `repo@branch` has uncommitted files or an active session on another machine. With agents listed, the dashboard reads the list once a minute for that line, so the hook never waits for an agent ([claude-plugin/](claude-plugin/README.md#the-same-branch-on-another-machine)).

### Where the data comes from

| Machine | Sessions | Checkouts | Load |
|---|---|---|---|
| this one (Linux) | the memory view's sessions (its last sample when fresh, else one `/proc` read): the session id from a descendant's `CLAUDE_CODE_SESSION_ID`, never a whole environ | the worktree scan (main checkouts and worktrees; repos without worktrees only with the branch from `.git/HEAD`) | `/proc/meminfo`, load average, disk |
| this one (macOS) | `ps` + `classify()`, cwds from `lsof`, the id and idle time from the newest transcript in `~/.claude/projects/<cwd with every non-alphanumeric as ->` | same | `os.totalmem` / `os.freemem` (free memory counts less than Linux's available) |
| an agent | its `/agent/v1/status` | same, from its scan | same |
| cloud | an estimate (`source: "github"`): see below | none | none |

There is no public API for cloud sessions, so the cloud's sessions are estimated from this machine's worktree scan. Each `claude/*` branch on `origin` that got a commit in the last 48 hours counts as one session, unless a checkout here has it or its PR (when `gh` knows one) is merged or closed. A branch pushed within the hour counts as active, older ones as idle. These estimates have no id; their worktree is `repo@claude/…` and their `remote` the GitHub `owner/name`. They are as fresh as the last `git fetch` (Portboard never fetches), and a session that hasn't pushed yet isn't seen. A repo without linked worktrees is read too, with one `git for-each-ref` only when `origin` has `claude/*` refs, but `gh` is not asked about its PRs: there a merged branch counts until it is 48 hours old.

Each checkout also carries `ahead` and `behind`: its commits that its upstream lacks, and the other way. Both are read from the local refs as of the last fetch, and are `null` when the branch has no upstream (or it was deleted). They come from the same one `git for-each-ref` per repo that lists the `claude/*` branches.

A session's worktree is the deepest checkout its cwd is in, named `repo@branch` (the name reservations, dev servers and the plugin's session port use). Helper CLIs (`--no-session-persistence`) are left out. A session is idle when the memory view says so (transcript quiet for `idleMin` and CPU under 3 %), or, without a CPU reading, when its transcript has been quiet for `idleMin` (60 minutes by default).

### Configuration

On the board, in `portboard.json` (every key optional):

```json
{
  "agents": [
    { "name": "mac", "url": "http://mac.example.ts.net:8797", "kind": "mac", "tags": ["xcode"], "maxSessions": 2 },
    { "name": "desktop", "url": "http://desktop.example.ts.net:8797", "kind": "wsl", "tags": ["gpu"] }
  ],
  "machines": {
    "self": { "kind": "linux", "tags": ["always-on"], "maxSessions": 4 },
    "cloud": { "enabled": true, "tags": ["sandbox", "parallel", "isolated"] }
  },
  "recommend": { "weights": { "mac": -0.1 } }
}
```

- `kind`: `linux`, `mac`, `windows`, `wsl` or `cloud`. Without it: the agent's capabilities (`macos`, `linux`), then the tailnet device's OS, then `linux`.
- `tags`: capabilities the machine can't see itself (`gpu`, `xcode`, `always-on`, …), lower-case words, at most 16. A machine reports `linux` or `macos`, `systemd` and `dev-servers` (start_dev_server needs systemd), `memory-view` and `docker` (a docker socket) itself.
- `maxSessions`: Claude Code sessions it should run at once, 1–64. Default by kind: mac 2, windows and wsl 3, others 4.
- `machines.cloud.enabled`: list the cloud as a candidate (off by default). It has no readable state beyond the `claude/*` estimate above; it is the isolated, parallel option that takes nothing from your machines.
- `recommend.weights`: numbers between -1 and 1 over the defaults below.

On each agent, `agent.showPaths: true` also sends worktree paths (the recommendation's `cwd`); without it the board knows checkouts by `repo@branch`.

### How where_to_run decides

1. **Left out:** offline, no status for 5 minutes (the cloud has none and stays), named in `exclude`, or missing a need: `macos` needs a mac, `windows` a windows or wsl machine, `docker` and `gpu` that capability or tag, `dev-server` the `dev-servers` capability (the cloud stays, with a caveat: a dev server there can't be reached over the tailnet).
2. **Score** (0–1):

| Term | Weight | |
|---|---|---|
| `locality` | 0.35 | the `repo@branch` is checked out there 1, the repo only 0.5, else 0; the cloud 0.3 (it clones). A repo matches by folder name or GitHub `owner/name`. Without `repo`, a repo the task text names is used |
| `conflict` | −0.4 | an active session or a process already works in that checkout; a quarter of it when the branch has uncommitted changes on another machine, and a quarter when an active cloud estimate is on that branch (a cloud session pushed to it within the hour) |
| `headroom` | 0.25 | the mean of `1 − load1/cores` and available/total memory; the cloud 0.6 |
| `sessionSlots` | 0.15 | `1 − active/maxSessions`; unknown 0.5, the cloud 1 |
| `fit` | 0.15 | `long-running` on an `always-on` machine, `parallel` / `isolated` in the cloud; half of it off for a dev server in the cloud |
| `mac` | −0.1 | added on the Mac: it is the control seat |
| `prefer` | 0.2 | added on the machine asked for |

3. **Ties:** fresher data first, then list order (this machine, the agents in `portboard.json` order, the cloud).

Each term leaves a reason (`why`) or a `caveat` in the server's language. A checkout that is behind its upstream gets a caveat to pull first; it does not change the score.

## Not in v1

- **Writes on another host** (restart, stop, expose, logs). The agent has no write route. When it gets one it will stay owner-only: the board's owner check (loopback or the owner's login through serve, the write-device allowlist), then the agent's own check of the board's identity, both in the audit log.
- **Push or streaming.** The board polls.
- **The board's other views of an agent host** (the service page, history, uptime and alerts for its ports): the 기기 tab and the host picker show its ports and load.
- **Removing compute-pool.** compute-pool still feeds hosts without an agent, and its load and rotation state.
