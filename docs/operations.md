# Operations

## Services (systemd user units on devbox)

| Unit | What | Listens |
|---|---|---|
| `portboard` | dashboard + REST API, background loops (usage history, alerts, host-key probes) | 127.0.0.1:8790, tailnet IP:8790; `tailscale serve` 8443 → 8790 (tailnet only) |
| `portboard-remote` | read-only remote MCP (OAuth) | 127.0.0.1:8794, tailnet IP:8794; **Funnel 443 → 8794 (public)** |
| `compute-pool-monitor` | `cpool monitor` (host health, alerts, `/api/hosts`) | 127.0.0.1:7720, tailnet :7721 (agents, device-token login) |

```bash
systemctl --user status portboard portboard-remote
journalctl --user -u portboard -f
tailscale serve status; tailscale funnel status
```

Turning off public access: `tailscale funnel --https=443 off`. Revoking every remote token: `node src/remote.ts revoke`. Never run `tailscale serve reset` or `tailscale funnel reset`, because they also remove the dashboard's 8443 entry.

## Deploy

From the main checkout (`~/projects/portboard`, branch `main`, clean tree), after merging:

```bash
scripts/deploy.sh             # npm test → restart → smoke checks → git push origin main
scripts/deploy.sh --dry-run   # npm test + smoke checks against what is running now; no restart, push or state
scripts/deploy.sh --no-push   # everything but the push
scripts/deploy.sh --restart all   # auto (default) | all | none | portboard | remote
```

1. **Refuses** a branch other than `main`, uncommitted changes, a checkout that isn't the units' `WorkingDirectory`, or a second deploy while one runs (`~/.local/state/portboard/deploy.lock`). `--dry-run` only warns, so it also works from a worktree.
2. **What restarts** comes from `git diff <previous deploy>..HEAD`: `src/server.ts` and `public/` → `portboard`; `src/remote.ts` and `src/remote/` → `portboard-remote`; `src/core/`, `src/features/`, `src/mcp/`, `src/remote/core.ts`, `src/remote/redact.ts`, `src/version.ts`, `package.json` and any other `src/` path → both (the dashboard loads the feature modules, and they import those); docs, tests, scripts, menubar, `bin/` → neither (the checks still run, then it pushes). A changed `deploy/*.service` is only flagged: copying it and `daemon-reload` stay manual. The output names each unit and the files behind it.
3. **Smoke checks** (read-only): `/api/health` and the 8794 listener (waits up to 30 s for a restarted unit); `/`, `/devices.html`, `/service.html`, `/api/ports`, `/api/devices`, `/api/usage` → 200; through Funnel at the public URL, resolved via 1.1.1.1 so MagicDNS doesn't bypass it, `/.well-known/oauth-protected-resource` → 200 and `POST /mcp` without a token → 401 (3 tries); every response scanned for the Proxmox token secret, the ntfy topic/webhook URL and the remote token hashes (compared in memory, only kinds and counts are printed); last, both units `active` and not restarted by systemd during the checks (`NRestarts`).
4. **All pass** → `~/.local/state/portboard/deployed.json` records the commit, then `git push origin main` (skipped with `--no-push`).
5. **Any check fails after a restart** → `git checkout --detach <previous deploy>` (history untouched), restart the same units, re-run the checks, print both results, exit 1, no push. The checkout stays detached until you fix it: `git checkout main`, fix, `scripts/deploy.sh` again. If nothing was restarted, or there is no previous deploy to go back to, it stops without rolling back.

The previous deploy is `deployed.json`'s commit; before the first run it is `origin/main` (every manual deploy ended with a push). If that is already HEAD (pushed by hand before the first run), nobody knows what is running, so `auto` restarts both; `--restart all` on the first run does the same on purpose. Exit codes: 0 deployed (or dry-run passed), 1 tests/checks/push failed, 2 refused.
## Profiles: production and previews

Paths are resolved in `src/core/paths.ts`. The process is **production** when `PORTBOARD_PORT` is unset or 8790 (and, for `portboard-remote`, `PORTBOARD_REMOTE_PORT` unset or 8794), or with `PORTBOARD_PROFILE=production`. Anything else, such as a branch preview on 879x/880x, is a **preview**:

- config and state: `~/.local/state/portboard/previews/<port>/` (mode 700). On first start it gets a copy (never a symlink) of production's `prefs.json` and `clients.json`; after that the preview's changes stay there.
- its own `remote.json`, history, uptime, alert state, known devices.
- read from production, never written: `proxmox.json`, `pveports.json`, `winports.json`, `~/.ssh/portboard_ro`, compute-pool's `hosts.json`.
- alerts off: no checker, no 새 기기 messages, and the channel resolves to a file that doesn't exist (알림 채널 없음), so the test button can't send. `PORTBOARD_PREVIEW_ALERTS=1` opts in to production's `alerts.json`.
- `/api/health` returns `{ok, profile, port}`; the header shows 미리보기 · <port>.

The first log line names the profile, for example
`[portboard] profile preview (port 8807): config+state ~/.local/state/portboard/previews/8807, secrets read-only from production, alerts off`.
Per-file env overrides (`PORTBOARD_PREFS`, `PORTBOARD_STATE_DIR`, …) still win over the profile.

Cleaning up previews: stop the preview, then

```bash
ls ~/.local/state/portboard/previews/
rm -rf ~/.local/state/portboard/previews/<port>
```

Nothing in production reads that directory, so removing it is always safe once the preview is stopped.

### Performance notes (2026-10-18, #24)

| | before | after |
|---|---|---|
| `/api/ports?fresh`, cache warm | ~45 ms | ~45 ms |
| `/api/ports?fresh`, after the probe cache expired | ~1.06 s (a non-HTTP port's 1 s probe timeout) | ~45 ms (stale-while-revalidate) |
| `/api/devices`, first call after a restart | ~1.8 s (first SSH reads) | ~0.4 s (first SSH wait capped), then ~10 ms |
| RSS | ~140–160 MB | ~160 MB |

`curl -s 'localhost:8790/api/health?detail' | jq .runtime` shows RSS, uptime, subprocess counts per command and the scheduler's jobs. Subprocesses are cheap here (`ss` ~35 ms, `tailscale` ~8 ms, `docker ps` ~30 ms); the expensive part was waiting on probes and SSH, not spawning.

## Files

Production paths. A preview has its own copy of every file Portboard writes (see above).

| Path | What | Written by |
|---|---|---|
| `~/.config/portboard/prefs.json` | labels, pins, hidden, alert flags, deviceLinks, dismissed suggestions | dashboard (atomic) |
| `~/.config/portboard/clients.json` | names given to LAN devices | dashboard (atomic) |
| `~/.config/portboard/proxmox.json` | Proxmox API token, pinned TLS fingerprint (mode 600) | user |
| `~/.ssh/portboard_ro` (+ `.pub`) | SSH key that can only list pve1's ports (see below) | created once on 2026-10-17 |
| `~/.config/portboard/pveports.json` | optional: SSH target for Proxmox ports; absent = pve1 defaults | user |
| `~/.config/portboard/winports.json` | optional: SSH target for the desktop's Windows ports; absent = Dev@192.168.1.7 | user |
| `~/.config/portboard/remote.json` | remote MCP: public URL, clients, token hashes (mode 600) | `portboard-remote` |
| `~/.local/state/portboard/usage-history.json` | last-used history, 30-day retention | `portboard` (throttled) |
| `~/.local/state/portboard/alerts-state.json` | alert state (only once something is watched) | `portboard` |
| `~/.local/state/portboard/devhealth-state.json` | device health alerts: each condition's state (read by the digest) | `portboard` (every minute) |
| `~/.local/state/portboard/selfwatch.json` | self-watch: each collector's down/up state, expiry warnings sent, the last view (read by the MCP server) | `portboard` (on change, else every 10 min) |
| `~/.local/state/portboard/known-devices.json` | known devices and 새 기기 state; seeded on first run | `portboard` (on change) |
| `~/.local/state/portboard/uptime.json` | uptime of watched ports, run-length segments, 30-day retention | `portboard` (at most once a minute) |
| `~/.local/state/portboard/deployed.json` | last deployed commit, time, units restarted | `scripts/deploy.sh` (on success) |
| `~/.local/state/compute-pool/alerts.json` | ntfy/webhook channel, read-only for portboard | compute-pool |
| `~/.local/state/portboard/previews/<port>/` | a preview's own config and state (copied prefs/clients, everything else it writes) | that preview |

## Self-watch (collectors and credentials)

Every background collector reports each attempt (`src/core/health.ts`): `usage` (the 30 s snapshot/usage sample), `pool` (compute-pool `/api/hosts`), `proxmox`, `pve-ports`, `win-ports`, `hostkeys`, `history`, `known-devices`, `alerts`. Once a minute `src/core/selfwatch.ts` looks at them:

- **Alerts:** one alert through compute-pool's channel when a collector has failed continuously for more than `PORTBOARD_SELFWATCH_MIN` minutes (default 15), and one when it works again. At most one down alert per collector per hour. A collector that stops reporting for 30 min counts as failing (except `hostkeys`, which only probes on demand). The state survives restarts; a long stop of Portboard itself doesn't count as failure time.
- **Not alerted:** turned-off collectors (no `proxmox.json`, `"enabled": false`, no Windows user) and setup steps never completed (key not installed, invalid config). Once a collector has worked, a setup error (key removed) is an outage again.
- **Expiry (hourly, and at start):** the Proxmox token (`/access/users/{user}/token/{id}`, else `/access/users?full=1`, which PVEAuditor may read; the user's own `expire` counts too) and remote MCP clients' newest refresh token (`remote.json`, read only, no hashes). One warning per credential and date at 7 days or past. The SSH key and the ntfy topic show "no expiry"; anything unreadable shows "unknown", never a guess.
- **Where:** `GET /api/health` stays `{"ok": true}`; `GET /api/health?detail` adds `collectors`, `failing`, `summary` and `expiry`. The header chip (수집 정상 / N개 실패) opens the details. MCP `portboard://status` (local) has a `collection` section. `PORTBOARD_ALERTS=off` keeps tracking but sends nothing.
- **compute-pool watching Portboard:** with compute-pool's `watch` support, `config.json` → `"watch": [{"name": "portboard", "url": "http://127.0.0.1:8790/api/health"}]` makes `cpool monitor` alert when Portboard itself stops answering for 3 min.

## Device health alerts

`src/core/devhealth.ts`, `src/features/devhealth.ts` (#2). Every 60 s the server reads the devices data (the same as `GET /api/devices`) and checks three conditions on the other machines, each with its own state:

- **Job failures:** a compute-pool host whose jobs failed `failPct` % or more of at least `failMinRuns` runs in the last 24 h (`pool.last24h`). The data is already a 24 h window, so it alerts on the first check that shows it.
- **Running but off the tailnet:** a Proxmox guest with status `running` whose matched tailnet device has been offline for `offlineMin` minutes (from its `lastSeen` when Tailscale knows it).
- **High load:** a pool host with load1 / cores at `loadPerCore` or more for `loadMin` minutes. Not for a host compute-pool has lost (`host-down`, `agent-away`): its numbers are stale.

One alert when a condition starts, a reminder every `reminderHours` while it lasts, one recovery once it has been clear (with a margin) for `recoverMin`. A host leaving compute-pool's rotation is not alerted here: `cpool monitor` does that. Thresholds: `devhealth.json` ([config.md](config.md#device-health-devhealthjson)). The state is `~/.local/state/portboard/devhealth-state.json`, so a restart doesn't re-alert. Alerts go through compute-pool's channel only where alerts may be sent (production, or a preview with `PORTBOARD_PREVIEW_ALERTS=1`; `PORTBOARD_ALERTS=off` stops them); the state is tracked either way. `GET /api/devhealth` shows the conditions now, and the daily/weekly digest has one line while a condition is alerted.

## Proxmox ports over SSH (read-only)

`portboard` reads the listening TCP ports of pve1 and its running containers (nas, jellyfin) with a dedicated key, `~/.ssh/portboard_ro`. On pve1 the key sits in `/root/.ssh/authorized_keys` as

```
command="/usr/local/bin/portboard-ports",restrict ssh-ed25519 AAAA… portboard-ro@devbox
```

so whatever the client asks for, sshd runs only that script, with no shell, pty, port or agent forwarding (`restrict`). The script prints `ss -ltnp` for the host and, through `pct exec`, for each running container. It changes nothing. Install snippet: [runbooks/ssh-readonly-setup.md](runbooks/ssh-readonly-setup.md).

- **Client side:** `ssh -F /dev/null -i ~/.ssh/portboard_ro -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes … root@192.168.1.201`: key auth only, no `~/.ssh/config`, and only against the host key already in `~/.ssh/known_hosts`. A changed host key is an error (`host-key`), not a prompt.
- **How often:** every 60 s while it works. On failures it backs off (1, 2, 4 … up to 10 min); while the key isn't installed (`Permission denied`) it tries every 5 min, so pve1's auth log gets a failed-publickey line at most every 5 min. 새로고침 in the dashboard re-checks at once (at most every 20 s).
- **Footprint on pve1:** one SSH login a minute and one `pct exec` per running container. sshd logs the key by fingerprint, not by comment: `Accepted publickey for root from 192.168.1.205 … ED25519 SHA256:…` (`ssh-keygen -lf ~/.ssh/portboard_ro.pub`).
- **Logs here:** one line per change of state (`[portboard] pve ports (pve1): ok …` / `not-installed …`), not one per minute.
- **Turning it off here:** `{"enabled": false}` in `~/.config/portboard/pveports.json` (read on every attempt; no restart needed), or remove the key.
- **Revoking it on pve1** (pve1 → Shell):
  ```bash
  sed -i '/portboard-ro@devbox/d' /root/.ssh/authorized_keys && rm /usr/local/bin/portboard-ports
  ```
  and here `rm ~/.ssh/portboard_ro ~/.ssh/portboard_ro.pub`. Either side alone is enough to stop it.

## Desktop Windows ports over SSH (read-only)

`portboard` reads the Windows side's listening TCP ports of the desktop (desktop-pc, outside WSL) through Windows OpenSSH at 192.168.1.7:22, with the same key `~/.ssh/portboard_ro`. On Windows the key is a forced-command key whose only command is

```
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\portboard\ports.ps1
```

which prints one `LocalAddress⇥LocalPort⇥PID⇥ProcessName` line per listening socket and changes nothing. WSL interop on that machine stays disabled; nothing runs inside WSL for this (the WSL side keeps coming from compute-pool).

- **Client side:** the same `ssh -F /dev/null -i ~/.ssh/portboard_ro -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes …` against the host key already in known_hosts for 192.168.1.7, as Windows user `Dev`. About 2 s per call (PowerShell start-up).
- **Config:** optional `~/.config/portboard/winports.json`; the defaults are user Dev, host 192.168.1.7, the key, device desktop-pc. Read on every attempt; no restart needed. `{"enabled": false}` turns it off; `{"user": null}` stops it connecting.
- **How often / logs:** as for pve1: every 60 s, backoff on failures, 5 min while not set up; one log line per change of state.
- **Revoking it on Windows:** remove the `portboard-ro@devbox` line from the authorized_keys file it was added to (`C:\ProgramData\ssh\administrators_authorized_keys` for an administrator account, else `%USERPROFILE%\.ssh\authorized_keys`) and delete `C:\ProgramData\portboard\`. Here: `"enabled": false`, or remove the key (which also stops pve1).

## Runtime footprint (measured 2026-10-17, 3.5 h uptime)

- `portboard`: about 155 MB RSS, unchanged over 3.5 h (no growth), about 0.1 % CPU. One journal line per restart; it is otherwise quiet.
- `portboard-remote`: about 100 MB RSS, idle CPU. One line per auth failure, registration, grant and tool call.
- Proxmox trends: rrddata for the node and each guest about once a minute while a 기기 tab is open (cached 60 s), the day series only while a detail needs it.
- Proxmox ports: one SSH call to pve1 a minute (about 1.6 s with two containers), cached in memory.
- Desktop Windows ports: one SSH call to 192.168.1.7 a minute.
- Background loops: a snapshot every 30 s (`ss`, `tailscale status`, `docker ps`, `systemctl show`, cached HTTP probes), SSH host-key probes about once an hour per IP (each shows in the target's sshd log as a pre-auth disconnect), and usage history at about 6 KB.

## Known host issue

The inotify watches are used up by one VS Code extension process (C# Dev Kit, about 517k of the 524k per-user watches), so systemd logs "Failed to add … inotify watch: No space left on device" and dev-server file watching can fail. See c10dev/portboard#5.
