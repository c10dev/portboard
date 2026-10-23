---
name: dev-servers-and-ports
description: Use Portboard (MCP) for dev servers and ports on this server instead of hard-coding a port, running ss/lsof/netstat, or killing by port. Use when starting, restarting or stopping a dev server or preview (npm run dev, vite, next, astro, serve), picking a port, finding what is on a port ("포트 뭐 써?", "3000 누가 써?", "what's running", "port already in use", EADDRINUSE), or cleaning up leftover servers ("서버 정리", "kill the old server", "포트 비워줘").
---

# Dev servers and ports — Portboard first

This server runs many Claude sessions and worktrees side by side. Ports collide when each session
guesses one. Portboard keeps the shared picture: who listens on which port (session, worktree, branch), which ports are
reserved for which `repo@branch`, and which servers are leftovers. Its MCP tools are listed under the Portboard server
(`mcp__plugin_portboard_portboard__*` from this plugin, or `mcp__portboard__*` when it was added with `claude mcp add`).

## 포트 고르기 → 예약 → 띄우기 (pick → reserve → start)

1. **`list_ports` before `ss`/`lsof`/`netstat`.** It already joins process, project folder, systemd unit, container,
   HTTP title and tailnet URL. Use shell tools for CPU/memory/disk, not for "what is on port N".
2. **`free_port {for: "<repo>@<branch>"}`** instead of guessing a port (3000, 5173, 8080 are usually taken). The owner's
   reserved port comes back first; other owners' reserved ports are never offered.
3. **`reserve_port {owner: "<repo>@<branch>"}`** when the server should keep its port across restarts (the owner's
   existing reservation is returned if it has one).
4. **`start_dev_server {path: "<worktree path>"}`** for a worktree of a repo Portboard scans (`list_worktrees`): it runs
   the package.json `dev`/`start`/`preview`/`serve` script as a transient systemd unit on loopback, on the reserved port
   (reserving a free one if needed). Logs: `tail_logs {port}`.
   Stop: `stop_dev_server {path}` (ask first; the reservation stays).
   Only when that doesn't fit (not a scanned repo, a custom command) start it yourself, on the port `free_port` gave.

The owner name is `<main repo folder>@<branch>`, e.g. `shop-web@feat-map` — the same name `start_dev_server` uses.

**`PORT` is already set.** When the worktree has a reserved port, this plugin exports `PORT=<that port>` for every
Bash command of the session (and again when you move into another worktree). Servers that read `PORT` land on it
without a flag; for one that doesn't, pass that port explicitly. A `[portboard]` line at session start says which port.

## Claude Code's preview (`.claude/launch.json`)

In Claude Code Desktop, the preview starts dev servers from `.claude/launch.json` and otherwise picks any free port.
**`write_launch_config {path}`** writes a `portboard` entry there with the worktree's reserved port and `autoPort: false`
(reserving one if needed). If Portboard already runs that worktree's server, the entry only attaches the preview to it
(`mode: "attach"`). Use it instead of editing the port in `launch.json` by hand. It leaves a file that has comments or
is tracked by git alone and returns the entry to paste; it adds the file to the repo's `info/exclude` so the port is
never committed.

## Opening a server from another device (SSH sessions, phone)

Over an SSH session there is no preview pane, and `localhost` on the user's computer is not this server. Don't tell
the user to run `ssh -N -L …`. Instead, `list_ports {query}` gives each port's `directUrl` / `servedUrl`; if it has no
`servedUrl` and `canExpose` is true, **`expose_port {port}`** publishes it to the user's tailnet over HTTPS (ask first,
it is visible to their tailnet devices). Give the user that URL.

## 끄기 (stopping) — never kill by port

- **`list_cleanup_candidates`** shows servers whose worktree was deleted, whose starting session ended, or whose branch
  is merged, with the session and worktree that own each. Show the user the list.
- **`cleanup_servers {ports: [...]}`** stops those (each port re-checked, SIGTERM). Ask the user first.
- A server Portboard started: **`stop_dev_server {path}`** (ask first). An installed service: `stop_service` (ask first).
- Not `kill $(lsof -t -i:N)`, `fuser -k N/tcp` or `kill $(ss -ltnp …)`: the port may belong to another session's live
  server, and killing a systemd unit's process leaves the unit in a bad state.

## The `[portboard]` notes

When a Bash command hard-codes a dev-server port or kills by port, this plugin's hook adds a note starting with
`[portboard]`: who holds or reserved that port, a port to use for this worktree, and the MCP call to use instead. It
never blocks the command. Read it, and prefer what it suggests.
