# Setup and running

### Running

```bash
npm start          # node src/server.ts (Node ≥ 22.18, no external dependencies)
npm run mcp        # node src/mcp.ts — stdio MCP server (see below)
npm test
npm ci && npm run typecheck   # dev only: TypeScript + @types/node (runtime stays zero-dependency)
```

| Environment variable | Default | Description |
|---|---|---|
| `PORTBOARD_PORT` | `8790` | Listening port. Any other port runs the preview profile (below) |
| `PORTBOARD_PROFILE` | from the port | `production` or `preview`, to force either |
| `PORTBOARD_PREVIEW_ALERTS` | unset | `1` lets a preview send alerts through production's channel |
| `PORTBOARD_HOSTS` | `127.0.0.1,<Tailscale IPv4>` | Addresses to bind to |
| `PORTBOARD_HISTORY` | `~/.local/state/portboard/usage-history.json` | Last-used history file |
| `PORTBOARD_PREFS` / `PORTBOARD_CLIENTS` | `~/.config/portboard/prefs.json` / `clients.json` | Labels, pins, device links / LAN device names |
| `PORTBOARD_SAMPLE_MS` | `30000` | How often the server samples who is connected |
| `PORTBOARD_ALERTS` | on (off in a preview) | `off` stops the down-alert checker and 새 기기 messages (API and test button still work) |
| `PORTBOARD_ALERT_CHANNEL` | `~/.local/state/compute-pool/alerts.json` | Alert channel file |
| `PORTBOARD_STATE_DIR` | `~/.local/state/portboard` | Alert state, quiet windows, sent log, uptime and known devices (not the history file, and not prefs/clients) |
| `PORTBOARD_UPTIME` | `<state dir>/uptime.json` | Uptime history of watched ports |
| `PORTBOARD_AUDIT` | `<state dir>/audit.jsonl` | 기록: every write, allowed or denied, and the stdio MCP server's write tools |
| `PORTBOARD_OWNER_LOGIN` | this node's Tailscale user | The Tailscale login allowed to write through `tailscale serve` ([security.md](security.md)). Needed when the server is a tagged node |
| `PORTBOARD_SITE` | `~/.config/portboard/portboard.json` | Optional site config: host, tailnet, checkout, repos root, compute-pool URL, pve/Windows defaults ([config.md](config.md)) |
| `PORTBOARD_PVEPORTS` | `~/.config/portboard/pveports.json` | Optional SSH target for Proxmox ports (`host`, `user`, `key`, `node`, `enabled`); off until a host is set ([runbooks/ssh-readonly-setup.md](runbooks/ssh-readonly-setup.md)) |
| `PORTBOARD_PVEPORTS_CMD` | unset | Preview/screenshots only: a command whose output stands in for the SSH call (e.g. `cat test/fixtures/pveports-pve1.txt`) |
| `PORTBOARD_WINPORTS` | `~/.config/portboard/winports.json` | Optional SSH target for the desktop's Windows ports (`host`, `user`, `key`, `device`, `enabled`); off until a host is set |
| `PORTBOARD_WINPORTS_CMD` | unset | Preview/screenshots only, like `PORTBOARD_PVEPORTS_CMD` (e.g. `cat test/fixtures/winports-desktop-pc.txt`) |

Every per-file variable wins over the profile. Paths are resolved in one place, `src/core/paths.ts`.

This server's own details (host name, tailnet, checkout, repos root, compute-pool URL, pve/Windows SSH defaults, public URL) come from the machine, then the optional `~/.config/portboard/portboard.json` (`PORTBOARD_SITE`) and a `portboard.json` in the checkout, then generic defaults: see [config.md](config.md).

#### Preview instances

A Portboard started on any port other than 8790 (a branch preview from a worktree) runs the **preview profile**, so it can't change production's state by accident:

- Its config and state live in `~/.local/state/portboard/previews/<port>/`. On first start that directory is created and production's `prefs.json`, `clients.json` and `portboard.json` are **copied** into it (labels, pins, device links, LAN names), so the preview looks real. Pins and labels changed in the preview stay there.
- `remote.json` (remote MCP OAuth state) is never shared: a remote server on a port other than 8794 gets its own.
- Secrets are read from production and never written: `proxmox.json`, `pveports.json`, `winports.json`, `~/.ssh/portboard_ro`.
- Alerts are off: no down checker, no 새 기기 messages, and the channel shows as 알림 채널 없음, so the test button can't send. `PORTBOARD_PREVIEW_ALERTS=1` turns them on with production's channel.
- The header shows a **미리보기 · <port>** badge, the tab title starts with `[미리보기 <port>]`, and the first log line names the profile and directory.

To clean up after a preview: stop it, then `rm -rf ~/.local/state/portboard/previews/<port>`.

Register it as a systemd user service so it starts automatically:

```bash
cp ~/projects/portboard/deploy/portboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now portboard
```

After a merge, deploy from the main checkout with `scripts/deploy.sh` (test → restart → live smoke checks → push, rolling back on failure); `--dry-run` checks what is running now. See [docs/operations.md § Deploy](operations.md#deploy).

### Mac app

Portboard for Mac is a native SwiftUI app: the dashboard in a window with native tabs, a menu bar item (`⇄ n`, plus `↓` for watched ports that are down, `⚠` for devices to check and `🧹` for leftover dev servers) and macOS notifications. Build it on the Mac (Command Line Tools or Xcode) and install it to /Applications:

```bash
rsync -a --exclude node_modules --exclude .git dev@devbox.example.ts.net:projects/portboard/ ~/portboard/ && ~/portboard/mac-app/build.sh --install
```

Details: [docs/mac-app/README.md](mac-app/README.md).

### Mac menu bar (SwiftBar, legacy)

Replaced by the Mac app above; kept for now.

A SwiftBar plugin shows `⇄ n` (services in use) in the Mac menu bar, with a red `⚠` when a compute-pool host is down or a pinned port is not listening. The dropdown lists devices (with what each one uses), services in use, pinned ports, local-only services with a "tailnet 공개" action, and links to the dashboard. Install it on the Mac after `brew install --cask swiftbar`:

```bash
scp dev@devbox.example.ts.net:projects/portboard/scripts/mac-menubar-setup.sh /tmp/ && bash /tmp/mac-menubar-setup.sh dev@devbox.example.ts.net
```

Details, rules and a live render: [docs/menubar/README.md](menubar/README.md).

### One-time setup for `tailscale serve` (the "tailnet 공개" button)

1. **Turn on Serve for the tailnet**: until it's on, the button shows a link to the settings page. You can also open it directly: https://login.tailscale.com/f/serve?node=nExampleNode1CNTRL
   (enable HTTPS certificates and Serve in the admin console).
2. If you then get a permission error, run this once on the server:
   `sudo tailscale set --operator=$USER`
