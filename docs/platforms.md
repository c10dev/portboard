# Platforms: Linux, macOS and Docker

Portboard was built for one Linux server with systemd, and that is still where every feature works. Since
c10dev/portboard#11 it also runs on a **macOS** laptop and in a **Docker** container, with the features that can't work
there turned off with a clear reason instead of failing.

| | Linux (systemd) | macOS | Docker image |
|---|---|---|---|
| Listening ports and owners | `ss -ltnpH` + `/proc` | `lsof` + `ps` | `ss` + the host's `/proc` (`--pid host`) |
| Process command line and folder | `/proc/<pid>/cmdline`, `cwd` | `ps -o command=`, `lsof -d cwd` | `/proc` (same uid as the host user) |
| Stop a plain process (SIGTERM) | yes | yes | no (read-only) |
| Restart / stop a systemd unit, unit logs | `systemctl --user`, `journalctl --user` | not available | not available |
| Restart / stop / logs of a docker container | `docker` | `docker` (Docker Desktop) | no (read-only; no `docker` CLI in the image) |
| Logs of a plain process writing to a file | `/proc/<pid>/fd/1`, `2` | `lsof -d 1,2` | no |
| Dev servers (`start_dev_server`) | `systemd-run --user` | `501`: not available | not available |
| Memory view (`/api/memory`, `memory_usage`) | `/proc` | `501`: not available | `/proc` of the host |
| Network map and usage history (who is connected) | `ss -tnpiH state established` | empty for now | `ss` |
| Expose with `tailscale serve` | yes | yes, with the `tailscale` CLI | no |
| `portboard install-service` | systemd user units | launchd agents | — |
| Writes in general | yes | yes | refused unless `PORTBOARD_READ_ONLY=0` |

## How the backend is chosen

`src/core/platform/` picks the backends once, from `process.platform`, and the environment can override each choice
(for tests, or a setup the default gets wrong). The table of variables is in
[config.md](config.md#platform-environment).

- **Port reader** (`PORTBOARD_PORT_READER=ss|lsof`): `ss` on Linux, `lsof` everywhere else. The `lsof` reader runs
  `lsof -nP +c 0 -iTCP -sTCP:LISTEN -F pcnL` and merges its field output into the same listener rows `ss` gives (one per
  address and port, with every process that holds it). Without `/proc`, one `ps` and one `lsof` per snapshot name the
  command line and folder of every owner.
- **Service manager** (`PORTBOARD_SERVICES=systemd|none`): `systemd` on Linux outside a container, `none` elsewhere.
  With `none`, nothing calls `systemctl`, `journalctl` or `systemd-run`: restart and stop of a unit answer with
  "systemd user units are not available on this platform", dev servers answer `501`, and the dev server list is
  empty. Docker containers and plain processes don't go through it and work the same everywhere.
- **`/proc`**: Linux only. Without it the memory sampler doesn't run (its job is off) and `/api/memory` answers `501`.
  Other `/proc` readers (session owners, the worktree process scan) find nothing and leave their fields empty.
- **Read-only** (`PORTBOARD_READ_ONLY=1|0`): on in a container (`PORTBOARD_CONTAINER=1`), off elsewhere. Every write
  route answers `403 {"error": "read-only", "reason": …}` before its handler runs (recorded in the audit log as
  denied), and the core refuses restart, stop and dev servers too, so MCP tools and the session-end auto-stop can't get
  around it. `canRestart` and `canStop` are `false` on every port.

A plain Linux install logs nothing new. Elsewhere the server logs one line at start saying what it uses and what it
can't do, e.g. `[portboard] platform darwin: ports via lsof; no service manager (…); no /proc (memory view unavailable)`.

## macOS

```bash
npm i -g @c10dev/portboard
portboard start                       # try it: http://127.0.0.1:8790
portboard install-service --dry-run   # see the launchd agent it would write
portboard install-service --enable    # write ~/Library/LaunchAgents/io.github.c10dev.portboard.plist and load it
```

`install-service` writes a launchd agent per server (`io.github.c10dev.portboard`, `…-remote` with `--remote`,
`…-agent` alone with `--agent`) that runs this node and this install at login and again when it exits
(`KeepAlive`), with `Umask` 077 like the systemd units. Output goes to `~/Library/Logs/portboard/<label>.log`, since a
Mac has no journal. Without `--enable` it prints the `launchctl bootstrap gui/<uid> <plist>` to run;
`uninstall-service` boots them out and removes only the plists it wrote. Run it again after moving node or Portboard.

What to expect on a Mac:

- **Only your own processes.** Without root, macOS's `lsof` lists only sockets of processes you own, so system
  listeners (AirPlay's 5000 / 7000 under another user, `mDNSResponder`) may be missing altogether, where Linux shows
  them as system ports without an owner.
- **Stop works, restart doesn't.** Stopping a port's process sends SIGTERM as on Linux; a process has no manager to
  restart it, and Portboard does not drive launchd for the services it finds.
- **No dev servers, no memory view, no connection history yet.** Those need systemd, `/proc` and `ss`. The worktrees tab
  still lists worktrees; starting their dev servers says why it can't.
- The **agent** (`portboard agent`) works and is the most useful mode on a Mac: a board on your Linux server can show
  the laptop's ports ([multi-host.md](multi-host.md)).

## Docker

The image runs the dashboard read-only over the **host's** ports. Build it from a checkout:

```bash
docker build -t portboard .
docker run -d --name portboard --restart unless-stopped \
  --network host --pid host --user "$(id -u):$(id -g)" \
  -v portboard-data:/data portboard
# then http://127.0.0.1:8790 on the host
```

- `--network host`: `ss` reads the host's sockets, and the dashboard binds the host's `127.0.0.1:8790`. Without it you
  see only the container's own ports.
- `--pid host` and `--user` with your uid: `ss -p` and `/proc` can only name processes of the same uid, so this shows
  your user's services with their command lines and folders; other users' ports show as system ports, as on Linux
  without root.
- `/data` is `HOME` in the image: `~/.config/portboard` (prefs, `portboard.json`) and `~/.local/state/portboard`
  (history, uptime, audit log) live there. Mount your own `portboard.json` with
  `-v ~/.config/portboard/portboard.json:/data/.config/portboard/portboard.json:ro`.
- Other users on the LAN: `-e PORTBOARD_HOSTS=0.0.0.0 -e PORTBOARD_ALLOWED_HOSTS=devbox.lan`, which is read-only from
  the LAN anyway ([setup.md](setup.md#without-tailscale)).
- The image has no `tailscale`, `docker` or `systemctl` CLI: Tailscale names, container names and the tailnet devices
  are left out, and the actions that need them stay off.
- `PORTBOARD_READ_ONLY=0` turns writes back on (labels, pins, stopping a process of the same uid). Restart and dev
  servers still need systemd, which a container doesn't have.

The image is `node:22-bookworm-slim` plus `iproute2` for `ss`, runs as the image's `node` user unless `--user` says
otherwise, and has no `npm install` step: Portboard has no runtime dependencies and Node 22.18+ runs `src/` directly.
There is no published image yet; build it yourself.
