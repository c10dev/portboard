# Setup and running

### Install

From npm (Node ≥ 22.18; the package has no dependencies):

```bash
npx @c10dev/portboard start                  # run once, without installing
npm i -g @c10dev/portboard                   # or install the `portboard` command
portboard install-service [--remote | --agent] [--enable] [--dry-run]
portboard uninstall-service [--dry-run]
```

| Command | What it does |
|---|---|
| `portboard start` | The dashboard (`src/server.ts`) on 127.0.0.1:8790 and the Tailscale IP |
| `portboard remote [approve\|status\|revoke [id]]` | The read-only remote MCP server on :8794, or its client admin ([remote-mcp/](remote-mcp/README.md)) |
| `portboard mcp` | The stdio MCP server, e.g. `claude mcp add portboard -- portboard mcp` |
| `portboard agent` | This machine's read-only agent on :8797 (loopback and the Tailscale IP) for a board on another machine; `install-service --agent` writes `portboard-agent.service` alone ([multi-host.md](multi-host.md)) |
| `portboard install-service` | Writes `~/.config/systemd/user/portboard.service` (with `--remote`, also `portboard-remote.service`) for **the node running the command** (`process.execPath`) and **this install** (the global package or the checkout), with the hardening of `deploy/portboard.service`: `UMask=0077`, `NoNewPrivileges=yes`, `Restart=always`. Then prints `systemctl --user daemon-reload && systemctl --user enable --now portboard`; `--enable` runs it instead. `--dry-run` prints the units and writes nothing |
| `portboard uninstall-service` | `systemctl --user disable --now`, then removes the units `install-service` wrote (a hand-copied unit is left alone). Config and state stay |
| `portboard token` | Makes the owner token for token mode and prints it once; running it again replaces it ([Without Tailscale](#without-tailscale)) |
| `portboard --version`, `--help` | |

The unit names absolute paths, so run `install-service` again after upgrading node under nvm or moving the install.
npx copies live in a cache npm may clear: `npm i -g @c10dev/portboard` before `install-service`. User units stop at logout
unless lingering is on (`sudo loginctl enable-linger $USER`). On macOS `install-service` writes launchd agents to
`~/Library/LaunchAgents` instead ([platforms.md](platforms.md#macos)); a Mac can also be just a client, with the app
(below).

The npm package carries `src/` compiled to `dist/`, because Node refuses to strip types under `node_modules`
(`npm run build`, run by `prepack`, with `tsconfig.build.json`). A checkout runs the `.ts` files directly;
`bin/portboard` runs `src/cli.ts` when it is there and `dist/cli.js` otherwise.

#### Releasing

Fold the fragments (`npm run changelog -- X.Y.Z "title"`), set `"version": "X.Y.Z"` in package.json, commit, then push a
tag `vX.Y.Z`. `.github/workflows/release.yml` checks that the tag matches package.json, runs the typecheck and tests,
packs the tarball and runs it once, publishes to npm with provenance, and creates the GitHub Release from that
version's CHANGELOG section (`node scripts/changelog.ts --notes X.Y.Z`). Repository secrets:

| Secret | For |
|---|---|
| `NPM_TOKEN` | `npm publish`: an npm automation (or granular, publish-only) token of the `portboard` package's owner |
| `APPLE_CERTIFICATE_P12` | Mac app: the "Developer ID Application" certificate and key, exported as .p12, base64 (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12's password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | `notarytool`: the Apple ID, its team, and an app-specific password |

Without all six Apple secrets the `mac-app` job is skipped and the release has the npm package only. With them, it
builds `mac-app/build.sh` on a macOS runner, re-signs with the Developer ID and the hardened runtime, notarizes,
staples, and attaches `Portboard-X.Y.Z-mac.zip` to the release.

### Running from a checkout

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
| `PORTBOARD_HOSTS` | `127.0.0.1,<Tailscale IPv4>` | Addresses to bind to (comma list). Without Tailscale, `127.0.0.1` only |
| `PORTBOARD_ALLOWED_HOSTS` | unset | Extra names the `Host` header may carry (comma list, e.g. `devbox.lan`), for a LAN bind ([Without Tailscale](#without-tailscale)) |
| `PORTBOARD_ACCESS_MODE` | `tailscale` | `token` turns on token mode (wins over access.json's `mode`) ([security.md](security.md#token-mode-c10devportboard12)) |
| `PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK` | unset | `1`: in token mode, local processes need the owner token too |
| `PORTBOARD_ACCESS` / `PORTBOARD_TOKEN_FILE` | `~/.config/portboard/access.json` / `owner-token.json` | Write access settings ([config.md](config.md#access-accessjson)) / the owner token's hash |
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
~/projects/portboard/bin/portboard install-service --enable   # the unit runs this checkout with this node
```

`deploy/portboard.service` and `deploy/portboard-remote.service` stay as reference units (with the production host's
paths); `install-service` writes the same settings with yours.

After a merge, deploy from the main checkout with `scripts/deploy.sh` (test → restart → live smoke checks → push, rolling back on failure); `--dry-run` checks what is running now. See [docs/operations.md § Deploy](operations.md#deploy).

### Without Tailscale

Portboard runs without Tailscale. Ports, processes, history and the dev tab work as before; what needs Tailscale is
left out: the owner's login and device names, **tailnet 공개** (expose/unexpose: the button isn't shown, and the API
answers `409` "This needs Tailscale…"), and the write-device allowlist (설정 › 쓰기 허용 기기 leaves the menu). By
default the dashboard then listens on 127.0.0.1 only and only processes on this machine can change anything.

To make changes from a browser on another machine (or to require a secret even locally), turn on **token mode**:

```bash
umask 077
printf '%s\n' '{"mode":"token"}' > ~/.config/portboard/access.json   # or PORTBOARD_ACCESS_MODE=token
portboard token                     # prints pbt_… once; only its sha256 is kept (owner-token.json, 0600)
```

Then, in each browser that should make changes, open 설정 › 화면 › **소유자 토큰** and paste it. It is kept in that
browser's localStorage and sent as `Authorization: Bearer <token>` with every request; scripts send the same header
(plus `X-Portboard: 1` on a POST). Running `portboard token` again is the rotation: the old token stops working at
the next request. A server restart isn't needed for either step.

To reach the dashboard from the LAN, bind a LAN address too and name it for the `Host` check:

```bash
PORTBOARD_HOSTS=127.0.0.1,192.168.1.10 PORTBOARD_ALLOWED_HOSTS=devbox.lan portboard start
```

(`0.0.0.0` binds every interface and allows this machine's own addresses as `Host`.) Without token mode a LAN address
is read-only and the server says so at start. The token travels in clear text over plain http: use it on a network
you trust, or put a TLS proxy in front on this machine. Funnel never gets write access, token or not. To require the
token from local processes too, add `"requireTokenOnLoopback": true` (or `PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK=1`);
then the Claude plugin's hooks, `curl` without the header and `tailscale serve` logins can't write either. Details and
the threat model: [security.md](security.md#token-mode-c10devportboard12).

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
