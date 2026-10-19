# Mac menu bar (SwiftBar) — legacy

> **Legacy.** The native Mac app ([mac-app/](../mac-app/README.md)) replaces this plugin: the same menu (its pure logic is tested against the same fixtures), plus the dashboard in a window, notifications and settings. The plugin is kept for now and still works; it is no longer where new menu bar features go. Run one or the other, not both. To remove it, delete the link in SwiftBar's plugin folder and `~/Library/Application Support/portboard-menubar/`.

A [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin that shows Portboard at a glance in the Mac menu bar. It runs every 30 seconds on the Mac and reads Portboard over the tailnet. It is modelled on the acme plugin (`projects/acme/menubar/`).

| File | Role |
|---|---|
| [`menubar/portboard.30s.mjs`](../../menubar/portboard.30s.mjs) | The plugin. Fetches the three endpoints and prints the menu. `30s` in the name is the refresh interval |
| [`menubar/format.mjs`](../../menubar/format.mjs) | Pure formatting: API JSON in, SwiftBar lines out. No I/O |
| [`menubar/fixtures/`](../../menubar/fixtures/) | `/api/ports`, `/api/usage` and `/api/devices` captured from the running server (MACs and command lines stripped) |
| [`test/menubar.test.ts`](../../test/menubar.test.ts) | `node:test` on those fixtures, part of `npm test` |
| [`scripts/mac-menubar-setup.sh`](../../scripts/mac-menubar-setup.sh) | Installer, run on the Mac |

## Install (on the Mac)

1. Install SwiftBar and open it once (it asks for a plugin folder; any folder is fine):

   ```bash
   brew install --cask swiftbar
   ```

2. Fetch and run the installer (needs Tailscale up and password-less `ssh dev@devbox.example.ts.net`, the same as `mac-setup.sh`). The argument is that SSH target (or set `PORTBOARD_REMOTE`):

   ```bash
   scp dev@devbox.example.ts.net:projects/portboard/scripts/mac-menubar-setup.sh /tmp/ && bash /tmp/mac-menubar-setup.sh dev@devbox.example.ts.net
   ```

The installer:

1. Checks SwiftBar is installed. If it is missing, it prints `brew install --cask swiftbar` and stops.
2. Finds a node 18 or newer that SwiftBar can run: `$PORTBOARD_NODE`, then `node` on PATH, then the newest `~/.nvm/versions/node/*/bin/node`, then Homebrew's. SwiftBar does not load nvm, so the plugin's shebang is rewritten to that absolute path.
3. Copies `portboard.30s.mjs` (as `portboard.mjs`) and `format.mjs` to `~/Library/Application Support/portboard-menubar/`. If the script sits in a checkout it copies from there, otherwise it uses scp from `<target>:projects/portboard/menubar/` and needs the target.
4. Reads SwiftBar's plugin folder (`defaults read com.ameba.SwiftBar PluginDirectory`), or sets `~/Library/Application Support/SwiftBar/Plugins` if none is set. It links `portboard.30s.mjs` there. Only the link goes in the plugin folder, so SwiftBar does not run `format.mjs` as a second plugin. A link with another interval from an earlier install is removed.
5. Runs the plugin once with SwiftBar's bare environment (`env -i PATH=/usr/bin:/bin`) and prints the title, or the reachability error.
6. Asks SwiftBar to reload (`swiftbar://refreshallplugins`), or starts it.

Re-running is safe; do it again after removing the node version it found. Options: `PORTBOARD_INTERVAL=1m` (file name interval), `PORTBOARD_NODE=/path/to/node`, `PORTBOARD_REMOTE=user@host` (instead of the argument). To remove the plugin, delete the link in the plugin folder and `~/Library/Application Support/portboard-menubar/`.

The plugin sends `User-Agent: portboard-menubar/1`; the dashboard's 설정 체크리스트 uses it to see that the menu bar is installed. An install from before #32 shows as not installed there until it is re-run.

The server URL defaults to `https://devbox.example.ts.net:8443` (`PORTBOARD_URL` in the plugin's `<swiftbar.environment>` header).

## What it shows

**Title**

- `⇄ n`: the number of services in use right now. A service is a port in the dashboard's default view (`visible`: pinned, or an app that is not hidden) that `usage.byPort` lists with at least one connection. SSH and ephemeral ports are not counted, as in the dashboard's default list.
- ` ⚠` in red: a compute-pool host is `degraded`, `wsl-down`, `host-down` or `auth`, a pinned port is not listening, or `/api/usage` or `/api/devices` failed. `agent-busy` (the Mac is being used), `agent-away` and `unknown` do not warn. They still show in the 기기 rows with the same labels as the dashboard.
- `portboard ⚠`: `/api/ports` could not be read (timeout after 8 s, DNS, refused, HTTP error, bad JSON) or formatting threw. The menu shows the error in one line plus the links, never a stack trace.

**Menu**

1. Warnings (red, when there are any). Each opens the dashboard or the device's card.
2. **기기**: one row per device card from `/api/usage` (or from `/api/devices` when usage failed). It shows a status dot, online or offline, the compute-pool state, CPU (`cpuPct`, or `load/cores` for agent hosts) and memory for pool hosts, and the number of services it uses. Its submenu lists the services that device is using (`uses[]`), the pool detail, and "기기 탭에서 보기".
3. **사용 중 서비스**: one row per in-use service, with who is using it. Clicking opens its served URL (tailnet HTTPS) or its direct URL. `tcp://` services (SSH, Syncthing sync) have no link.
4. **고정한 포트**: pinned ports with their state (tailnet HTTPS, local only, 리스닝, or 리스닝 없음 in red).
5. **local only 서비스**: visible ports bound to loopback only and not served. Each has a submenu with **tailnet 공개** (when the server allows it, `canExpose`) or the reason it cannot. It also shows the SSH tunnel command.
6. 대시보드 열기, 기기 탭, 새로고침.

**tailnet 공개** is the only write. SwiftBar runs it as:

```
bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=<PORTBOARD_URL>/api/ports/<port>/expose terminal=false refresh=true
```

The header is written without a space (`X-Portboard:1`) so no SwiftBar parameter needs quoting. Checked through tailscale serve from the server, without changing anything, by sending the same request for port 1, where nothing listens: it returns `409 nothing is listening on 1`. Without the header it returns `403 missing X-Portboard header`. A refused expose fails silently (`terminal=false`). After the refresh the port is still under local only.

Text is escaped for SwiftBar: `|` in a name becomes `¦`, newlines become spaces, a leading `-` becomes `–` (it would read as a submenu marker), and lines are cut at 110 characters. Missing or extra API fields are tolerated (tested), so fields that other branches add do not break the plugin.

## Limitation: pinned ports that stopped

`/api/ports` lists only listening ports, plus `tailscale serve` entries with nothing behind them. A pinned port whose process stopped disappears from the API, so the menu cannot flag it until the server lists stopped pins with `pinned: true, listening: false`. When it does, the menu flags them with no change.

## Live render

Rendered on devbox from the running production instance (read only) at
2026-10-17T12:43:38Z. The server cannot resolve its own MagicDNS name, so it fetched from `http://127.0.0.1:8790` with `env -i PATH=/usr/bin:/bin PORTBOARD_URL=http://127.0.0.1:8790 node menubar/portboard.30s.mjs`. The base URL in the output was then replaced with the tailnet URL the Mac uses. SwiftBar shows `--` lines as a submenu, `-----` as a separator inside a submenu, and `| …` as item parameters.

```
⇄ 4
---
기기 9 | size=12 color=#8E8E93
🟢 개인 Wi-Fi 주소 기기 · 온라인 · 서비스 1
--SSH :22 ×5
-----
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#lan%3A192.168.1.108
🟡 dev-mac · pool 사용 중 · load 4.7/10 · 서비스 2
--SSH :22 ×2
--compute-pool monitor :7721
--connected, but not available: idle 7 min of 10 | color=#8E8E93
-----
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#dev-mac
🟢 pve1 · 온라인 · 서비스 1
--SSH :22 ×2
-----
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#pve1
🟢 desktop-pc · pool 정상 · CPU 0% · 메모리 9% · 서비스 1
--SSH :22
-----
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#desktop-pc
🟢 nas · 온라인 · 서비스 1
--Syncthing :22000
-----
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#nas
🟢 devbox (이 서버) · pool 정상 · CPU 4% · 메모리 57%
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#devbox
🟢 iphone · 온라인
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#iphone
🟢 gpu-box · 온라인
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#gpu-box
⚪ docker-vm · 오프라인 | color=#8E8E93
--기기 탭에서 보기 | href=https://devbox.example.ts.net:8443/devices.html#docker-vm
---
사용 중 서비스 4 | size=12 color=#8E8E93
compute-pool monitor :7721 · dev-mac
Portboard :8790 · 이 서버 ×3 | href=https://devbox.example.ts.net:8443/
Portboard :8792 · 이 서버 | href=http://devbox.example.ts.net:8792
Syncthing :22000 · nas
---
고정한 포트 0 | size=12 color=#8E8E93
고정한 포트 없음 (대시보드에서 고정) | color=#8E8E93
local only 서비스 9
--Agent Web UI (agent web) on 127.… :3080
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/3080/expose terminal=false refresh=true
----ssh -N -L 3080:127.0.0.1:3080 dev@devbox | color=#8E8E93 font=Menlo size=11
--ShopSim :5281
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/5281/expose terminal=false refresh=true
----ssh -N -L 5281:127.0.0.1:5281 dev@devbox | color=#8E8E93 font=Menlo size=11
--compute-pool monitor (host health, alerts… :7720
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/7720/expose terminal=false refresh=true
----ssh -N -L 7720:127.0.0.1:7720 dev@devbox | color=#8E8E93 font=Menlo size=11
--Supabase MCP SSH Tunnel :8080
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/8080/expose terminal=false refresh=true
----ssh -N -L 8080:127.0.0.1:8080 dev@devbox | color=#8E8E93 font=Menlo size=11
--Syncthing - Open Source Continuous File S… :8384
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/8384/expose terminal=false refresh=true
----ssh -N -L 8384:127.0.0.1:8384 dev@devbox | color=#8E8E93 font=Menlo size=11
--Portboard :8796
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/8796/expose terminal=false refresh=true
----ssh -N -L 8796:127.0.0.1:8796 dev@devbox | color=#8E8E93 font=Menlo size=11
--webapp OpenAI Secure MCP Tunnel :18080
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/18080/expose terminal=false refresh=true
----ssh -N -L 18080:127.0.0.1:18080 dev@devbox | color=#8E8E93 font=Menlo size=11
--MainThread :18893
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/18893/expose terminal=false refresh=true
----ssh -N -L 18893:127.0.0.1:18893 dev@devbox | color=#8E8E93 font=Menlo size=11
--Directory listing for / :18894
----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=https://devbox.example.ts.net:8443/api/ports/18894/expose terminal=false refresh=true
----ssh -N -L 18894:127.0.0.1:18894 dev@devbox | color=#8E8E93 font=Menlo size=11
---
대시보드 열기 | href=https://devbox.example.ts.net:8443/
기기 탭 | href=https://devbox.example.ts.net:8443/devices.html
새로고침 | refresh=true
```

When the server cannot be reached (e.g. Tailscale is off on the Mac):

```
portboard ⚠ | color=#FF3B30
---
portboard 연결 안 됨: ENOTFOUND | color=#FF3B30
Tailscale 연결과 https://devbox.example.ts.net:8443/ 를 확인하세요 | color=#8E8E93
---
대시보드 열기 | href=https://devbox.example.ts.net:8443/
기기 탭 | href=https://devbox.example.ts.net:8443/devices.html
새로고침 | refresh=true
```

Not checked on a Mac: the SwiftBar rendering itself, the symlinked plugin and the click on **tailnet 공개**. They were written on Linux. The pure module is tested there, and the installer was run there with macOS commands stubbed.
