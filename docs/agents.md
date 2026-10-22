# Running several coding agents on one machine

One Linux box, several Claude Code sessions, each in its own git worktree, each starting a dev server. This guide is
how Portboard keeps them out of each other's way: the problem, the workflow the agents follow, what the Claude Code
plugin adds, how to check that agents actually use it, and how other MCP-capable agent CLIs fit in (c10dev/portboard#14).

## The problem

An agent that needs a dev server picks a port the way a person would: 3000, 5173, 8080, or whatever the README says.
With one agent that works. With several on the same machine:

- **Port collisions.** Two sessions start on the same port. The second one fails with `EADDRINUSE`, or the tool
  quietly moves to the next port and the agent keeps testing the other session's server.
- **Agents killing each other's servers.** The usual fix for "port already in use" is `kill $(lsof -t -i:3000)` or
  `fuser -k 3000/tcp`. The process on that port may be another session's live server, or a systemd unit whose process
  then comes back or leaves the unit failed.
- **Orphaned dev servers.** A session ends, is cleared, or its worktree is deleted after the branch merges, and the
  servers it started keep running and holding ports nobody remembers.
- **Raw inspection.** Agents run `ss -ltnp` and `lsof -i` to find out what is on a port, and get a pid with no idea
  which session, worktree or branch it belongs to.

Portboard keeps the shared picture on the machine: who listens on which port (process, systemd unit, container,
Claude session, worktree and branch), which ports are reserved for which owner, and which servers are leftovers. The
agents ask it through MCP instead of guessing.

## The workflow

An owner is `<main repo folder>@<branch>`, for example `shop-web@feat-map`, the same name `start_dev_server` uses.
The tools are those of the local stdio MCP server ([mcp.md](mcp.md)); the plugin's skill
([`dev-servers-and-ports`](../claude-plugin/skills/dev-servers-and-ports/SKILL.md)) tells Claude Code when to use them.

1. **Look before starting.** `list_ports` (optionally with a `query`) instead of `ss`/`lsof`/`netstat`: each port comes
   with its process, project folder, unit or container, HTTP title and URL.
2. **Pick a port.** `free_port {for: "shop-web@feat-map"}`. The owner's reserved port comes back first. Ports that are
   listening, used by `tailscale serve`, in the ephemeral range (32768–60999) or reserved by another owner are never
   offered.
3. **Keep it.** `reserve_port {owner: "shop-web@feat-map"}` returns the owner's existing reservation or reserves a free
   port (or the `port` you pass, with an optional `note`). From then on `free_port` hands it to that owner only.
   `list_reservations` shows all of them; `release_port {port, owner}` gives one of yours back.
4. **Start the server.** `start_dev_server {path: "<worktree path>"}` runs the worktree's package.json `dev`, `start`,
   `preview` or `serve` script (`script` picks one) as a transient systemd user unit (`pb-dev-*`) on loopback, on the
   reserved port, reserving a free one first if there is none. It works for worktrees of the repos Portboard scans
   (`list_worktrees`); `list_dev_servers` shows what is running and what can be started. For anything else (a custom
   command, a repo outside the scanned roots) the agent starts the server itself on the port `free_port` gave.
5. **Read its output.** `tail_logs {port, lines?}` reads the unit's journal (or the container's logs, or a plain
   process's output when it goes to a file), so the agent doesn't need to keep the server in its own shell.
6. **Stop it.** `stop_dev_server {path}` stops the unit; the reservation stays, so the next start gets the same port.
7. **Clean up leftovers.** `list_cleanup_candidates` lists servers whose working directory was deleted, whose starting
   session ended, or whose branch is already merged, each with the session and worktree that own it.
   `cleanup_servers {ports: [...]}` stops those after re-checking each one (SIGTERM, or `systemctl --user stop` for a
   transient unit). The skill tells the agent to show the list and ask the user first.

What the agent should not do: kill by port. A plain `kill <pid>` of its own process is fine; `kill $(lsof -t -i:N)`
doesn't know whose server it hits.

The MCP server also has the prompt `new_dev_server` (`free_port` → start → `list_ports` → a URL for other devices) and
`port_cleanup` (proposes candidates, stops nothing until you pick).

## What the nudge says

Agents still type `PORT=3000 npm run dev` out of habit. The plugin's PreToolUse hook on Bash
([`hooks/port-nudge.ts`](../claude-plugin/hooks/port-nudge.ts)) parses the command before it runs. When it starts a
dev server on a hard-coded port (`vite --port N`, `next dev -p N`, `PORT=N npm run dev`, `python -m http.server N`, …)
or kills by port (`kill $(lsof -t -i:N)`, `fuser -k N/tcp`, `npx kill-port N`, …), it asks the dashboard
(`GET /api/claude/port-advice`, 300 ms timeout) and adds the answer to the model's context. The note starts with
`[portboard]` and, depending on the case, says:

- that the command starts a server on a hard-coded port, or kills whatever holds a port;
- who holds the port now: the process and pid, whether this session or another Claude session started it (and whether
  that session is still running), its worktree, or that it is an installed unit or container;
- whether the port is reserved, for this worktree or for someone else, with the reservation's note;
- for a start: the port to use for this worktree, and `start_dev_server {path: …}` when the worktree can be started that
  way, otherwise `free_port {for: …} → reserve_port`;
- for a kill: that nothing is listening, that it is another running session's server (ask the user first), that it is a
  cleanup candidate (`cleanup_servers {ports: [N]}` instead), that `stop_dev_server {path: …}` stops it, or that
  Portboard can't stop it and the user should be asked.

Quoted names (titles, notes, branch and unit names) are cleaned and marked as data, not instructions. The hook sets no
permission decision: the command always runs, and the normal permission prompt is unchanged. When the dashboard is down
or slow, the hook prints nothing. The full list of matched commands, look-alikes it ignores, and sample output:
[claude-plugin/README.md](claude-plugin/README.md#the-port-nudge). The text follows the server's language
(`PORTBOARD_LOCALE`).

## When a session ends

The plugin's SessionEnd hook tells the dashboard the session ended (`POST /api/claude/session-end`, loopback only, 500 ms,
errors ignored). The servers that session started become cleanup candidates right away, instead of waiting for the
Claude process to exit or the transcript to go quiet. A server is linked to a session by `CLAUDE_CODE_SESSION_ID` in its
environment, by a working directory in the session's scratchpad, or because `start_dev_server` passed the calling
session's id to the unit.

Whether anything is stopped is your choice (`autoStop`, in the cleanup banner's ⋯ menu on the Services tab):

| `autoStop` | On SessionEnd, stops |
|---|---|
| `off` (default) | nothing: the servers only become candidates |
| `scratchpad` | that session's servers running from its scratchpad, or as `pb-sd-*` / `pb-dev-*` transient units |
| `all` | every server of that session that is a cleanup candidate |

Never stopped, in any mode: installed systemd services, docker containers, other users' processes, pinned ports,
servers of any other session, Portboard itself or a Portboard preview, and anything when the session ended with
`/clear` (the Claude process keeps running). Reservations are left alone. Details:
[claude-plugin/session-end.md](claude-plugin/session-end.md).

## Install the Claude Code plugin

The plugin brings the MCP server, the skill, the nudge and the SessionEnd hook. In Claude Code:

```
/plugin marketplace add c10dev/portboard
/plugin install portboard@portboard
```

It runs the MCP server from your checkout (`~/projects/portboard`, or `PORTBOARD_HOME`); the hooks need the dashboard
running on `127.0.0.1:8790` (`PORTBOARD_URL` points them elsewhere). If you had added the server with `claude mcp add`,
remove that entry first, or you get two servers. Tool names under the plugin are
`mcp__plugin_portboard_portboard__<tool>`. Details, and how to turn off only the nudge:
[claude-plugin/README.md](claude-plugin/README.md).

## Measure whether agents use it

Installing the plugin doesn't mean sessions follow it. The adoption metric reads the Claude Code transcripts on this
machine (`~/.claude/projects/`) and counts, per KST day and per project, for the last N days and the N days before:

| Column | Counts |
|---|---|
| `sess` | sessions |
| `mcp` | Portboard MCP calls (any tool whose server name contains `portboard`, plugin or not) |
| `insp` | shell commands that inspect ports themselves: `ss -ltn…`, `lsof -i`, `netstat -l…`, `fuser N/tcp` |
| `kill` | shell commands that kill by port: `fuser -k`, `kill $(lsof …)`, `lsof -t -i … \| xargs kill`, `kill-port` |
| `fixed` | shell commands that start a server on a hard-coded port |
| `nudge` | `[portboard]` notes shown to the session |
| `foll` | nudges whose next port action was a Portboard MCP call rather than a raw command |
| `shell` | all shell calls, for scale |

```bash
node scripts/adoption.ts --days 7          # a table: per day, per project, top ports and command prefixes
node scripts/adoption.ts --days 7 --json   # the same as JSON
```

`--days` is 1–90; `--root` reads transcripts from another directory. It prints counts, project folder names, ports and
short command prefixes only, never what a transcript said. The same numbers are the MCP tool `adoption_stats {days?}`
(1–7 days, from a daily cached scan; `refresh` rescans). The direction you want: `mcp` and `foll` up, `insp`, `kill` and
`fixed` down.

## Other agent CLIs

The local MCP server ([`src/mcp.ts`](../src/mcp.ts)) is a plain stdio server: newline-delimited JSON-RPC on stdin and
stdout, protocol versions 2024-11-05 through 2025-11-25, with tools, resources and prompts, and no runtime dependencies
beyond Node ≥ 22.18. Any agent CLI or editor that can launch a stdio MCP server can use it. The usual config shape:

```json
{
  "mcpServers": {
    "portboard": {
      "command": "node",
      "args": ["/home/you/projects/portboard/src/mcp.ts"]
    }
  }
}
```

Put it wherever your client keeps its MCP servers; the key names vary by client, the command and argument don't.
The server reads this machine's sockets, so it has to run on the machine the agents work on. From another machine,
launch it over SSH with [`bin/portboard-mcp`](../bin/portboard-mcp), which finds `node` without a login shell: command
`ssh`, args `["-o", "BatchMode=yes", "you@host", "projects/portboard/bin/portboard-mcp"]` (the full entry is in
[mcp.md](mcp.md)).

What carries over to any client: `list_ports`, `free_port {for}`, the reservations, `start_dev_server` /
`stop_dev_server`, `tail_logs`, and `list_cleanup_candidates` / `cleanup_servers` for servers whose worktree is gone or
whose branch is merged. What is specific to Claude Code:

- **The nudge and the SessionEnd hook** are Claude Code plugin hooks. Other clients get no `[portboard]` notes, and
  their servers are not marked when a session ends.
- **Session ownership** comes from `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID`. Servers started from another client have
  no owning session, so "starting session ended" never applies to them; the worktree and branch reasons still do.
- **The skill** is a Claude Code skill. For another client, put its rules in that client's instructions file: use
  `free_port {for: "<repo>@<branch>"}` and `reserve_port` instead of guessing a port, `start_dev_server` /
  `stop_dev_server` for worktree servers, `list_ports` instead of `ss`/`lsof`, and never kill by port.
- **The adoption metric** reads Claude Code transcripts only.

For read-only questions from claude.ai or ChatGPT (what is running, which ports are free), there is the separate remote
connector: [remote-mcp](remote-mcp/README.md). It cannot reserve, start or stop anything.
