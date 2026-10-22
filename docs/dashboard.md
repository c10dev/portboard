# Dashboard

### What each row shows

- **Port and name**: the name links to the service page (below). It comes from, in order of priority, the systemd unit description, the HTTP `<title>`, the project folder, or the process name. Docker ports show the container name. System ports whose owner (root) isn't visible are named from the port: 22 `SSH (sshd)`, 53 `DNS (systemd-resolved)`, 631 `CUPS 프린터 (cupsd)`, and tailscaled's own listeners (`tailscale serve HTTPS` on the serve ports, `Tailscale PeerAPI` on the ports in `tailscale status` → `Self.PeerAPIURL`). Anything else stays `unknown`.
- **Groups**: ports owned by the same thing are one card with a sub-row per port: the same docker compose project (`com.docker.compose.project`, e.g. `supabase (webapp)` → `kong` 54321, `db` 54322), the same container, the same systemd unit (`compute-pool monitor` 7720/7721, `Syncthing` 8384/22000), the same process, or tailscaled. Each sub-row keeps its own 열기, tailnet 공개, SSH 복사 and ⋯ menu. A group whose other ports are filtered out (hidden, system, search) shows as a plain row.
- **Last used** (`◷ 3시간 전 사용 · dev-mac`): on rows nobody is using right now, from the last-used history below.
- **Uptime** (🔔 rows only): the last 30 checks as a bar (green up, red down, yellow right after a restart/stop from Portboard, grey not checked) and `24시간 99.9% · 7일 100%`. See Down alerts.
- **Bind scope**:
  - `모든 인터페이스` / `tailnet`: reachable directly over the tailnet. **열기** (open) links straight to it.
  - `local only`: bound to 127.0.0.1 only. You can either
    - press **tailnet 공개** (publish to tailnet), which registers it with `tailscale serve --https=<port>`, so `https://devbox.….ts.net:<port>` reaches it from tailnet devices only, or
    - press **SSH 복사** (copy SSH) to copy the old `ssh -N -L` command.
- **상세** (details): PID, command, working directory, systemd unit, what controls it, URLs. Wider than a phone, rows are dense and a click (or ↑/↓) shows all of this, with the uptime, who uses it, suggestions, the actions and a live log tail, in the inspector on the right; on a phone it stays the row's inline 상세. With nothing selected the inspector shows 한눈에: how many ports are shown, in use now, on tailnet, on this server only, and the down alerts. Dense rows show ☆ and 🔔 only on hover, focus and the selected row unless they are on. On a phone the rows are one divided list with everything inline, and 상세 at the end of the buttons' line.
- **☆ / ★**: pin a port to the top.
- **⋯ menu** (wider than a phone it shows when the row is hovered, focused or selected, always on touch; a right-click on the row opens it too):
  - **이름 바꾸기** (rename): a label of your own; the detected name stays in the gray line below.
  - **숨기기 / 다시 보이기** (hide / show). Hiding, unpinning, clearing a label and turning 🔔 off apply at once with a **되돌리기** (undo) toast that puts the previous setting back.
  - **로그 보기** (logs): `journalctl --user` for systemd units, `docker logs` for containers, or the file a plain process writes stdout to. Output that goes to a terminal can't be shown.
  - **재시작** (restart): systemd user units and docker containers only.
  - **중지** (stop): `systemctl --user stop`, `docker stop`, or SIGTERM to a plain process. Last, after a separator, in red. Asks first, and refuses to stop portboard itself.
- Copy buttons: on a plain `http://` address (not a secure context) the browser blocks clipboard access, so a prompt with the text to copy appears instead.
- The **전체** (all) checkbox also shows what's hidden by default: system ports (owner not visible to this user: sshd, DNS, tailscaled…), ephemeral helper ports (32768–60999 with no unit or container, e.g. VS Code server) and ports you hid. Pinned ports always show.

Labels, pins and hidden flags are stored in `~/.config/portboard/prefs.json` (override with `PORTBOARD_PREFS`), outside the repo. A preview instance keeps its own copy (see [Preview instances](#preview-instances)).

### Last-used history

Live connections are forgotten as soon as they close, so the server samples who is connected (the same data as the 기기 tab and the 사용 중 chips) every 30 s in the background, and also on every `/api/usage` request. Per (device, port) it keeps `firstSeen`, `lastSeen`, `activeSince` (start of the current run of use; a gap over 5 min starts a new one), the number of samples, the peak connection count, and minutes in use per UTC day, for 30 days.

- File: `~/.local/state/portboard/usage-history.json` (override with `PORTBOARD_HISTORY`). Written atomically (tmp + rename) at most once a minute, and on SIGTERM/SIGINT. Before writing it re-reads the file and merges, taking the max of each counter, so two Portboard processes pointed at the same file (for example a preview run with `PORTBOARD_HISTORY` set to production's) can share it without counting the same minutes twice. A preview keeps its own history by default.
- Device keys are the 기기 card ids (Tailscale name, `lan:<ip>`, `pool:<name>`), `local` for this server's own processes, and `<router>~routed` for traffic that came through a subnet router.
- Shown as: `◷ N시간 전 사용 · 기기` on idle port rows; the 기기 tab's "아무도 안 쓰는 서비스" list (grouped, with who used it last or "N 동안 사용 기록 없음"); `최근 7일: SSH 3시간 · …` on device cards and in the detail; `N시간 전 사용` on idle device chips, plus chips for LAN devices that aren't connected now. The detail's 언제부터 uses the persisted `activeSince`, so restarting Portboard no longer resets it; 처음 사용 is `firstSeen`.
- Limits: a connection that opens and closes between two samples (a quick HTTP request) can be missed; minutes are time with at least one connection open, not per-connection minutes.

### Service page

`service.html#<port>` opens from a row's name. It shows:
- what the service is: name, unit / container / compose group (with links to the group's other ports), bind scope, addresses, URLs, PID, command, path
- who is connected right now, and since when
- the last-used history: every device that used it, when it was last seen, and minutes in use over 7 and 30 days
- for 🔔 ports: uptime over 24 h / 7 d / 30 d, the last 30 checks, a 24 h bar (48 × 30 min) and a 30-day bar, the outages with their length and reason, and the alerts that were sent
- the row's actions with the same guards: 열기, tailnet 공개 / 공개 해제 (only for the entry tailnet 공개 made), SSH 복사, 로그 보기, 재시작 and 중지 (both ask first), 🔔

It works at 390 px, for a watched port that is down, and for a port only the history knows.

### Devices strip

Above the port list, one card per device: this server and every Tailscale peer (online, last seen, direct or relayed path), joined with [compute-pool](integrations/compute-pool.md)'s host status where a pool host matches a device. The card then shows the monitor's state (정상, 일부 문제, WSL 꺼짐, 응답 없음, 사용 중…), CPU, memory, free disk and busy slots; hover for addresses, runners and the last 24 h of runs.

- Other machines' ports: when compute-pool reports a host's listening ports (`listening` / `listeningAt` in `/api/hosts`: the desktop from the monitor's ssh probe, the Mac from a worker new enough to send them), its 기기 card shows "열린 포트 N" with each port's process and reach: `tailnet` with an `열기 ↗` link to `http://<MagicDNS name>:<port>` for ports on all interfaces or the device's Tailscale IP, `그 기기 안에서만` for loopback. The 서비스 tab gets a host picker (이 서버 / desktop / mac); this server's list is unchanged.
- Source: `cpool monitor` on `http://127.0.0.1:7720` (`PORTBOARD_POOL_URL`). It reads `GET /api/hosts` (compute-pool's versioned contract). On an older monitor that answers 404 there, it falls back to `/api/state` plus `~/.local/state/compute-pool/hosts.json` (`COMPUTE_POOL_DIR`) for addresses. If the monitor is down, the strip shows Tailscale data only.
- Matching a pool host to a device: the pool's local host is this server; an agent host matches the device whose Tailscale IP it connects from (needs a monitor with `/api/hosts`); a host the pool reaches over the LAN can't be matched automatically (Tailscale doesn't report peers' LAN addresses), so link it in `prefs.json`:

  ```json
  { "ports": {}, "deviceLinks": { "desktop": "desktop-pc" } }
  ```

  Unmatched pool hosts get their own card (`pool · ssh`).
- Proxmox host and container ports: pve1's own ports and those of its running containers (nas CT 203, jellyfin CT 204) are read over SSH with a dedicated read-only key (`~/.ssh/portboard_ro`, a forced command on pve1 that runs only `ss -ltn`), about once a minute in the background. They show the same way: "열린 포트 N" on the pve1 / nas / jellyfin cards and in the 서비스 tab's host picker. jellyfin has no Tailscale, so its card is made from the Proxmox tree and its ports open at its LAN address (`LAN` tag, through pve1's subnet route). Until the key is installed on pve1, the 기기 tab shows a setup hint linking to the install snippet. For access and revoking it, see [operations.md](operations.md) and [runbooks/ssh-readonly-setup.md](runbooks/ssh-readonly-setup.md).
- The desktop's Windows side: Windows' own listening ports (outside WSL) are read over Windows OpenSSH with the same key (forced command: a PowerShell script that prints `address⇥port⇥pid⇥process`). They join the WSL ports from compute-pool on the desktop-pc card and in the 서비스 tab, each tagged `Windows` or `WSL`; a Windows socket that only forwards a WSL port (wslrelay, or an unnamed owner on the same port) is folded into the WSL row. The Windows account defaults to `Dev` (override in `~/.config/portboard/winports.json`); while the read fails the 기기 tab shows a setup hint. Setup: [runbooks/ssh-readonly-setup.md](runbooks/ssh-readonly-setup.md).

### Down alerts

Pick ports with the 🔔 in their row (or ⋯ → 🔔 다운 알림 켜기) and Portboard pushes a notification when they go down and when they come back, through compute-pool's existing alert channel (ntfy → iPhone, and/or a webhook).

- Channel: `~/.local/state/compute-pool/alerts.json` (`{"ntfy": {"server", "topic"}, "webhook": {"url"}}`, same parsing as `cpool monitor`), read on every use. It is never copied, logged or returned by the API: the ntfy topic works like a password. Without a usable channel the 🔔 dialog shows **알림 채널 없음** and nothing is sent.
- Checks: every 30 s in the server process. A watched port is down when nothing listens on it, or when it has been seen speaking HTTP and `GET /` gets no answer within 5 s. Two failed checks in a row send one down alert (`portboard: 8780 uploader is down`, high priority); the first good check after that sends `portboard: 8780 uploader is back (down 3m)`.
- At most one down alert per port per 10 minutes (a flapping service doesn't page every time); recovery alerts always go out. An outage that outlasts the 10 minutes is still announced. A down alert no channel accepted is retried on the next check.
- Restart / stop from Portboard (dashboard or MCP) keeps that port quiet for 2 minutes. If it is still down after that, it alerts, with the downtime counted from when it went away.
- Watched ports that stop listening drop out of `/api/ports`, so the dashboard shows them as red rows at the top until they are back.
- Devices: on the 기기 tab, a tailnet device's detail (or the 🔔 on its card) turns on an alert for it going offline. compute-pool hosts and this server have no toggle: `cpool monitor` already alerts when a pool host leaves rotation.
- The header 🔔 opens the list of what is watched, the channel status, the last alerts sent, and **테스트 알림 보내기**.
- Uptime: every check is also recorded, with or without a channel, in `~/.local/state/portboard/uptime.json` (`PORTBOARD_UPTIME` overrides the file). It holds run-length segments per port (`[firstCheck, lastCheck, u|d|h|q]`), is kept for 30 days, and is written atomically at most once a minute and on SIGTERM. Time nothing was checked (Portboard stopped, or `PORTBOARD_ALERTS=off`, which records nothing) is left out of the %, not counted as down; time in the 2-minute window after a restart/stop from Portboard counts neither way.
- State: `~/.local/state/portboard/alerts-state.json` (so a restart doesn't re-alert), `quiet.json` (2-minute windows, shared with the MCP process), `alerts.jsonl` (titles of what was sent). `PORTBOARD_STATE_DIR` moves all three, and `uptime.json`.
- Prefs: `"alert": true` on a port in `prefs.json`, `"deviceAlerts": {"desktop-pc": true}` for devices.

### Network tree (구조)

The 기기 tab opens on **구조**, a simple indented tree of the network; **카드** switches back to the cards (the choice is remembered per browser). The sidebar's 기기 section shows the same tree in 24 px rows.

```
hv1                            ← a subnet router and/or Proxmox host
├─ old             VM 202  오프라인   (Proxmox에서는 실행 중: only its Tailscale is down)
├─ store           CT 203
├─ media           CT 204  LAN 전용
├─ box             VM 205  이 서버
└─ LAN 10.0.0.0/24 · hv1가 라우팅
   ├─ desk         tailnet 직접       (it has its own Tailscale address)
   ├─ tv           hv1 경유로만       (LAN only, seen connecting or named)
   └─ gateway      ARP로만 확인       (only in this server's ARP table)
직접 연결                       ← the other tailnet devices (DERP when relayed)
그 밖의 LAN 기기                 ← LAN clients outside every routed subnet (only when there are some)
```

- **The model** is `src/core/nettree.ts` (`buildNetTree`, pure, tests in `test/nettree.test.ts`). It reads `routes` (Tailscale `PrimaryRoutes`) and the new `standbyRoutes` (an approved subnet in `AllowedIPs` that another router serves now), the Proxmox tree, and the LAN addresses this server knows: clients connected now and named ones (`seen: client`), and the ARP table (`seen: neighbor`, docker bridges left out).
- **Every device appears once.** A guest stays under its Proxmox host, with its LAN IP (this server's own LAN address comes from its interfaces). A device on a routed LAN goes into that LAN group, in the most specific subnet that holds it. Everything else is 직접 연결. Funnel/ingress peers never get here.
- **Several routers:** each LAN is listed under its primary router; a router that advertises the same subnet as a standby gets an empty `LAN … · 대기 (지금은 X가 라우팅)` row. Two nodes both claiming primary (a stale netmap): the online one, then by name. A router that isn't a Proxmox host, a Proxmox host that routes nothing, an offline router and no Proxmox token all work; exit-node routes are not LANs.
- **Where it is served:** `tree` on `GET /api/devices` (the sidebar), `GET /api/usage` (this tab) and MCP `list_devices`. The remote `list_devices` keeps names, kinds, states and `reach`, and drops subnets, addresses, endpoints and the UI's keys unless `showAddresses` is on (`src/remote/redact.ts`).
- **A row opens** the device's card detail, a Proxmox guest's sheet, or, for a LAN address with neither, a short sheet with its address and how it is reached. A group's ▸ folds it. The sidebar remembers its folds in `pb.navFold` and paints them from the cache before anything loads (`lib/shell-boot.js`); the tab keeps its own in `pb.devTreeFold`.
- **"<router> 경유" chips** (사용 중 chips, the headline, a card's routed block, the detail, the 서비스 detail's history) now say the route in their tooltip, e.g. "10.0.0.0/24를 hv1이 라우팅해서 출발지가 hv1로 보여요", and link to the router, whose detail explains SNAT.

### New devices (새 기기)

Portboard remembers every device it has seen and tells you when an unfamiliar one shows up.

- **What counts as a device:** a tailnet device (keyed by its Tailscale name, `ts:<name>`) or a LAN device (keyed by MAC, `mac:…`, or by IP when the MAC isn't known). A device first known only by IP, for example from the history, is taken over by the first MAC seen at that IP. A different MAC on a known IP is a new device. Not tracked: this server, compute-pool hosts (you added those yourself), subnet-routed traffic (the router is the device), tailnet IPs that `tailscale status` doesn't know (a transient state), docker and `tailscale serve` legs, and internet clients.
- **Day one:** the first run seeds the record from everything visible: tailnet peers (online or not), LAN cards, this server's neighbour table and the devices in the last-used history. Nothing alerts that day. A sample taken while `tailscale status` or `ip neigh` failed is skipped, so a failure can't make known devices look new.
- **After that:** a device's **first connection to a service on this server** marks it 새 기기 (a badge on its card, plus a list at the top of the 기기 tab) and queues one alert. **이름 붙이기** (LAN devices; `POST /api/clients/name`) and **확인** both clear the badge. 모두 확인 clears every badge. An acknowledged device that hasn't been announced yet won't be.
- **Alerts:** these go through the down-alert channel (`alerts.json`, ntfy/webhook). The first new device is announced at once. Later ones wait until 10 minutes have passed since the last message and then go out together ("portboard: 3 new devices"). The window survives restarts. Sending happens in the background, so it never holds up the dashboard. A send that fails is tried again after 30 s. With no channel configured, nothing is queued for later. Tapping the ntfy notification opens the device in the 기기 tab. Like the down alerts, the text has names, vendors and services only. It never has an IP or MAC, because ntfy topics can be read by anyone who knows the name. An unnamed LAN device is called "unnamed LAN device". `PORTBOARD_ALERTS=off` stops sending, and devices found while it is off are not announced later; the badges still work.
- **Why connections only, by default** (`prefs.json` → `"newDevices": {"connections": true, "neighbors": false}`; the toggles are at the bottom of the 기기 tab): a first connection to one of your services is the case worth a push: a device that can reach SSH or a dashboard here and hasn't before. The neighbour table (ARP/NDP) is noisier and says less. Linux adds an entry for anything this server exchanges packets with, including the router, printers, other VMs on pve1, and phones whose private Wi-Fi MAC rotates. Turning `neighbors` on alerts on those too. A neighbour that is new while the option is off is recorded quietly, and its first real connection still alerts. A device announced as a neighbour isn't announced again when it connects.
- **State:** `~/.local/state/portboard/known-devices.json` (moved by `PORTBOARD_STATE_DIR`, like the alert state). It is written only when something changes. Sent alerts are also logged in `alerts.jsonl`, so they show in the 🔔 dialog's recent list. The local MCP tool `list_new_devices` reads the same file.

### Proxmox trends

The pve1 card and guest cards (this server, nas…) show **CPU and 메모리 sparklines for the last hour** with the current value, and each row of the VM/CT list has a small CPU sparkline. Tap a card, or a guest row or its sparkline, for the **최근 24시간** chart in the detail panel. It shows 10-minute averages, average and peak, and the value at any point you tap or hover. A guest with no card of its own (jellyfin) opens a guest-only detail.

- Data: Proxmox's own RRD data, read-only. It comes from `/nodes/{node}/rrddata` and `/nodes/{node}/{qemu|lxc}/{vmid}/rrddata` (`timeframe=hour|day`, `cf=AVERAGE`), with the same token, pinned TLS and no-secret rule as the VM/CT tree. The PVEAuditor role is enough (Sys.Audit on nodes, VM.Audit on guests). This was checked against pve1 on 2026-10-17. If a call is refused, only that node or guest loses its trend, and the detail says which permission is missing.
- CPU is a share of all the guest's (or node's) cores. Memory is `memused/memtotal` for the node and `mem/maxmem` for guests, the same numbers as the VM/CT list. Gaps (a stopped guest) stay gaps; they are not drawn as 0. The CPU scale steps (5/10/25/50/100 %) so a 3 % line is still visible. The 24 h chart labels its scale.
- Cached 60 s per timeframe. The page fetches the hour every minute, and the day only while a detail that needs it is open. That makes 1 + number-of-guests API calls per minute.
