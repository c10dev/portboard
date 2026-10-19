# Site config: `portboard.json`

Everything Portboard needs to know about the machine it runs on (its name, the tailnet, the checkout, where your repos are, the compute-pool monitor, the public connector URL, and the Proxmox and Windows SSH targets) is either read from the machine or set in one optional file, so nothing in the code names a host (c10dev/portboard#37).

**With no file, Portboard works on any Linux host.** The host name, tailnet and user come from `tailscale status` and the OS; the Proxmox and Windows readers stay off until you give them a host.

- **Where it is:** `~/.config/portboard/portboard.json`. Set `PORTBOARD_SITE` to read it from somewhere else. A **`portboard.json` at the root of the checkout** the code runs from is read too, under the user's file: the user's file wins key by key (and field by field inside `pve` and `windows`). Use it to keep an install's site config with the code; `.gitignore` leaves it out of commits. The 정보 section lists it as 체크아웃 설정 when it is used.
- **In a preview:** a preview (any port other than 8790/8794) reads its own copy, `~/.local/state/portboard/previews/<port>/portboard.json`. That copy is made from production's file when the preview directory is first created, the same way as `prefs.json` and `clients.json` ([setup.md](setup.md#preview-instances)). On a new preview's very first start, the text fixed at start (below) still shows the defaults, because it is built before the copy is made; the next start uses the copy. The checkout's file is the worktree's own.
- **The code:** `src/core/site.ts`. The defaults are `SITE_DEFAULTS` there. [`portboard.example.json`](../portboard.example.json) has every key.

## How a value is chosen

Each value is resolved on its own. The first source that has it wins:

1. **Environment variable.** `PORTBOARD_POOL_URL`, `PORTBOARD_REPOS_ROOT`, `PORTBOARD_DASHBOARD_URL`, `PORTBOARD_LOCALE` and `PORTBOARD_UTC_OFFSET`; `portboard agent` also reads `PORTBOARD_AGENT_*` over the `agent` key. The other keys have no variable.
2. **Runtime.** What the machine reports:
   - `tailscale status --json` gives the host name and tailnet.
   - git gives the checkout of the running code.
   - The OS gives the user Portboard runs as.
   - `tailscale serve status --json` gives the dashboard URL.
3. **`portboard.json`:** the user's file, then the checkout's.
4. **Default.** The value in `SITE_DEFAULTS`.

A runtime source that can't be read is skipped. For example, when Tailscale isn't running, the host name comes from the file or the default.

Text that is fixed when Portboard starts can't wait for `tailscale status`. That covers MCP tool descriptions, the remote server's instructions and collector labels. Those take only env, file and default (`SITE`). The 설정 tab's 정보 section and the setup checklist's commands use the full order (`site()`). The 정보 section also shows where each value came from: 환경 변수, 실행 중 확인, portboard.json or 기본값.

## Keys

Every key is optional. A key of the wrong type is ignored, and the rest still apply. The server prints the problem at start, and the 정보 section shows it next to 설정 파일. A file that isn't valid JSON is ignored as a whole.

| Key | Type | Default | Runtime source (wins over the file) | Env (wins over all) | Used for |
|---|---|---|---|---|---|
| `host` | string | this machine's short host name | `tailscale status` Self.HostName | — | This server's name in MCP tool descriptions, the remote server's instructions and the Mac agent command (`cpool agent --coordinator <host>`) |
| `tailnet` | string | none (the DNS name is then the host alone) | the DNS suffix of Self.DNSName | — | With `host`, this server's MagicDNS name (`<host>.<tailnet>`), e.g. in the Mac app's `rsync` command |
| `user` | string | the OS user | the OS user Portboard runs as | — | `user@host` in commands to copy |
| `checkout` | string | the checkout the code runs from | the main checkout of the running code (git's common dir; from a worktree, its main checkout) | — | The setup checklist's `claude plugin marketplace add <checkout>` and the Mac app's `rsync` source |
| `reposRoot` | string (comma list) or string array | `~/projects` | — | `PORTBOARD_REPOS_ROOT` | The 개발 tab: git repos directly under each root (`~` is expanded) |
| `poolUrl` | string | `http://127.0.0.1:7720` | — | `PORTBOARD_POOL_URL` | The compute-pool monitor the 기기 tab reads (optional; without one the tab shows tailnet devices only) |
| `dashboardUrl` | string | none | the `tailscale serve` https port that proxies to the dashboard (8443 in [setup.md](setup.md)) | `PORTBOARD_DASHBOARD_URL` | Links to the dashboard: alert messages, the consent page's link to the 설정 tab, and the 정보 section's 대시보드 address. It is only used when serve doesn't publish the dashboard |
| `publicUrl` | string | `https://<host>.<tailnet>` | — (`remote.json`'s `publicUrl` comes first) | — | The public Funnel URL `scripts/deploy.ts` smoke-checks when `remote.json` has none. The remote server itself still takes its issuer URL from `remote.json` only |
| `locale` | `"en"` or `"ko"` | `en` | — | `PORTBOARD_LOCALE` | The language of the text the server writes: alert, digest, new-port and memory pushes, the setup checklist, suggestions, MCP prompts and messages, the remote consent page, and the shell of each page as it is served. A browser shows the dashboard in the device's choice (Settings › Display › Language), else this locale when it is set, else the browser's language; the API text it reads follows the page ([docs/i18n](i18n/README.md)). Another value is ignored and reported |
| `utcOffset` | `"+HH:MM"`, `"-HH:MM"` or `"Z"` | `+09:00` | — | `PORTBOARD_UTC_OFFSET` | The fixed offset from UTC the digest time (`HH:MM`, and Monday for weekly) and the Claude adoption days are counted in. No DST: a zone that changes its clock needs the value changed with it. The default keeps the original KST behaviour. Another value is ignored and reported |
| `pve` | object | `{"host": "pve", "user": "root", "key": "~/.ssh/portboard_ro", "node": "pve", "enabled": false}` | — | — | Defaults for the Proxmox SSH port reader ([runbooks/ssh-readonly-setup.md](runbooks/ssh-readonly-setup.md)). `pveports.json` (`PORTBOARD_PVEPORTS`) still goes on top. `node` also names the reader in labels |
| `windows` | object | `{"host": "windows", "user": null, "key": "~/.ssh/portboard_ro", "device": "windows", "enabled": false}` | — | — | Defaults for a desktop's Windows SSH port reader (same runbook). `winports.json` (`PORTBOARD_WINPORTS`) still goes on top |
| `agents` | array of `{name, url, token?}` | `[]` | — | — | The board: other machines' `portboard agent`s to read ([multi-host.md](multi-host.md)). Their ports go on the tailnet device of that name, ahead of compute-pool's. `name` is a host name, unique; `url` is http(s) without credentials; `token` is sent as `Authorization: Bearer`. A bad entry is ignored and reported (never its token) |
| `agent` | object | `{"port": 8797, "allow": [], "token": null, "showAddresses": false}` | — | `PORTBOARD_AGENT_PORT`, `PORTBOARD_AGENT_ALLOW` (merged with `allow`), `PORTBOARD_AGENT_TOKEN`, `PORTBOARD_AGENT_HOSTS` (bind list) | This machine's `portboard agent`: its port, who may read it (`allow`: Tailscale node names or IDs, logins, `tag:` ACL tags), an optional shared `token`, and whether LAN addresses leave the machine. With no `allow` and no token only loopback reads ([multi-host.md](multi-host.md#who-may-read)). A field of the wrong type falls back to its default |

Each value of `pve` and `windows` resolves in this order: `pveports.json`/`winports.json`, then `portboard.json`, then the default. The dedicated files stay the per-install override for those SSH targets. They are validated the same way as before; an invalid value makes that reader report a config error.

The dashboard's own ports are not keys: 8790 (`PORTBOARD_PORT`) and 8794 (`PORTBOARD_REMOTE_PORT`) are set by environment, as before. The https port in front of the dashboard (8443) is whatever `tailscale serve` publishes.

## Example

A server with a Proxmox host and a Windows desktop on its LAN. Tailscale reports `host` and `tailnet` anyway; set them for the text that is fixed at start:

```json
{
  "host": "devbox",
  "tailnet": "example.ts.net",
  "reposRoot": ["~/src", "/data/repos"],
  "pve": { "host": "192.168.1.201", "node": "pve1", "enabled": true },
  "windows": { "host": "192.168.1.7", "user": "Dev", "device": "desktop-pc", "enabled": true }
}
```

Restart Portboard (`systemctl --user restart portboard portboard-remote`) after editing the file. It is read when Portboard starts; the 설정 tab and the setup checklist read it again at most once a minute.

## Outside `src/`

The web pages and the Claude Code plugin say "this server" (이 서버). Three things run elsewhere and can't read this file:

- **The Mac app** starts at the dashboard address it was built with: `PORTBOARD_SERVER_URL` (and `PORTBOARD_BUNDLE_ID`) for `mac-app/build.sh`, from the environment or `mac-app/build.env`. Without one it starts at a placeholder and asks in its 설정 ([mac-app](mac-app/README.md)).
- **The Mac setup scripts** take the server's SSH target as their argument, `bash mac-setup.sh <user>@<host>.<tailnet>.ts.net`, or from `PORTBOARD_REMOTE`, and stop if neither is given (the menu bar installer needs it only when it isn't run from a checkout). `mac-setup.sh` runs the MCP launcher as `projects/portboard/bin/portboard-mcp` relative to the SSH user's home (`PORTBOARD_LAUNCHER` overrides it) and prints the dashboard as `https://<host from the target>:8443`. The menu bar installer writes `PORTBOARD_URL`, else `https://<host from the target>:8443`, into the plugin it installs.
- **The systemd units** (`deploy/*.service`) run the checkout at `%h/projects/portboard`; edit `WorkingDirectory` and `ExecStart` for another path.

## Port rules

Port rules label, pin or hide many ports at once, and decide what happens when one of those ports starts listening. They follow VS Code's `remote.portsAttributes`. Labels used to be set one port at a time, so a scratchpad preview on 18893 or a new Vite server on 5191 never had one. Now one rule covers all of them.

Rules don't live in `portboard.json`. They are user preferences, so they sit in **`prefs.json`** next to the per-port labels: `~/.config/portboard/prefs.json` (`PORTBOARD_PREFS`). A preview reads its own copy, the same way as the rest of its prefs. You can edit them on the 설정 tab under **포트 규칙**, with `POST /api/port-rules` ([api.md](api.md)), or with the MCP tools `list_port_rules` and `set_port_rule` ([mcp.md](mcp.md)). The remote connector can't read or change them. You can also edit the file by hand; the dashboard picks the change up on the next snapshot.

```json
{
  "ports": { "8790": { "label": "Portboard" } },
  "portRules": {
    "18891-18899": { "label": "스크래치패드 미리보기" },
    "localhost:5173": { "pinned": true },
    "vite|next dev": { "label": "개발 서버", "onNew": "notify" },
    "code-server": { "onNew": "ignore" }
  },
  "otherPorts": { "onNew": "silent" }
}
```

### Keys

Keys are read the way VS Code reads them:

| Key | Matches |
|---|---|
| `3000` | That one port. It counts as an exact rule, but the port's own entry in `ports` still wins. `set_port_rule` and the 설정 editor write a single port into `ports`, the same as a rename on the dashboard |
| `3000-3010` | An inclusive range |
| `host:port` | That port when it is bound to that host. `localhost` means any loopback address (127.x, ::1). `*`, `0.0.0.0` and `::` mean bound to all interfaces. Any other host must equal one of the port's bind addresses (`127.0.0.1:5173`, `100.101.102.103:3000`, `[::1]:3000`). Ports on the other machines (the 기기 tab) are not matched yet |
| anything else | A regular expression, case-insensitive, tested against each owning process's command line (the first 300 characters) and `docker: <container>` for a container. For example `vite\|next dev` or `node_modules/\.bin/astro` |

A key that is none of these is ignored, and so is a rule with an unknown field or a wrong type. Examples are a backwards range, a port above 65535, an invalid regex, or `"onNew": "loud"`. The 설정 section and `list_port_rules` list what was ignored and why. There are at most 100 rules, and a key is at most 200 characters.

### Fields

| Field | Type | Meaning |
|---|---|---|
| `label` | string (≤ 80) | The display name of every matching port |
| `pinned` | boolean | Pinned to the top |
| `hidden` | boolean | Left out of the default view |
| `onNew` | `notify` \| `openBrowserOnce` \| `silent` \| `ignore` | What happens when a matching port starts listening (below) |

The down alert (`alert`) stays per port: a range of watched ports that aren't running would always be down.

### Precedence

Each field is taken from the first source that sets it, in this order:

1. **The port's own entry** in `ports`. A rename, pin or hide on the dashboard writes there, so it always wins. When rules exist, an unpin or un-hide is stored as `false` rather than removed, so a rule that pins or hides the range doesn't win again.
2. A single-port key in `portRules`.
3. `host:port` keys.
4. Ranges, the narrowest first, then the lowest start.
5. Regexes, in the order they are in the file.
6. `otherPorts`, but only when no key in `portRules` matched the port. A port's own entry doesn't count as a match.
7. The defaults: no label, not pinned, not hidden. `onNew` defaults to `notify` for a well-known dev server on an app port from 1024 up, and to `silent` for everything else. The well-known dev servers are `vite`, `next dev` (`next-server`), `astro`, `nuxt`, and `npm`/`pnpm`/`yarn`/`bun` with `run dev` or `dev`.

`"onNew": "ignore"` also hides the port, unless something sets `hidden` itself.

Precedence is shown in three places:

- The 서비스 tab's inspector has a **규칙** section. It lists the rules that matched, in this order, and where the name, 새 포트, 고정 and 숨김 came from (이 포트의 항목, 규칙 `18891-18899`, 나머지 포트 or 기본값).
- `GET /api/ports` entries carry `onNew` and `rules: {matched, from}`, where `from.<field>` is `port`, `rule:<key>`, `otherPorts` or `default`.
- `list_port_rules` lists the rules in the order they are consulted.

### New ports (`onNew`)

Every 15 s the server compares the listening ports with its last look. This runs in every profile. A port that wasn't there before gets its `onNew`:

| `onNew` | What happens |
|---|---|
| `notify` | A toast in every open dashboard page (`새 서버 :5173 Vite (myapp)`, with **열기** and, for a loopback-only HTTP port, **tailnet 공개**). Also one push through the down-alert channel (ntfy/webhook): ntfy gets the same two actions, and a tap opens the port's row. A look that finds several ports sends one message listing them. The push goes out only where alerts may be sent: production, or a preview with `PORTBOARD_PREVIEW_ALERTS=1`. `PORTBOARD_ALERTS=off` stops it |
| `openBrowserOnce` | Only the dashboard toast, with **열기**. The Mac app will open it once (later) |
| `silent` | Nothing |
| `ignore` | Nothing, and the port is hidden |

The following never produce a notice:

- Anything already listening at the server's first look after it starts, so restarting Portboard notifies about nothing.
- Portboard's own ports (`portboard*.service`, its own process).
- A port in its quiet window after `restart_service` or `stop_service` (`quiet.json`, 2 minutes).
- The same port and command line again within 10 minutes, for example a dev server restarting on a file change.

A look whose `ss` returned nothing changes nothing. The events are kept in memory for the toast and the Mac app: `GET /api/new-ports` ([api.md](api.md#new-ports)).

## Access: `access.json`

Who may change things ([security.md](security.md)). A separate file because it is a security setting: it must be mode
0600 (a file group or others can read or write is refused), and it is read on every write, so an edit applies at once.

- **Where it is:** `~/.config/portboard/access.json` (a preview: its own config dir). `PORTBOARD_ACCESS` moves it.
- **The code:** `src/core/access.ts` (`loadWriteDevices`, `loadAccessPolicy`).

| Key | Type | Default | Env | Meaning |
|---|---|---|---|---|
| `writeDevices` | string array | unset (every device logged in as the owner) | `PORTBOARD_WRITE_DEVICES` (merged) | Tailscale only: the devices that may write through `tailscale serve` ([security.md](security.md#write-devices)); 설정 › 쓰기 허용 기기 writes it |
| `mode` | `"tailscale"` or `"token"` | `"tailscale"` | `PORTBOARD_ACCESS_MODE` (wins) | `"token"`: a request with the owner token (`Authorization: Bearer …`) may write from any address but Funnel ([token mode](security.md#token-mode-c10devportboard12)). Any other value is reported and counts as `"tailscale"` |
| `requireTokenOnLoopback` | boolean | `false` | `PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK=1` (can only turn it on) | Token mode only: processes on this machine (and `tailscale serve`) need the token too |

The owner token itself is never stored: `portboard token` writes its sha256 to `~/.config/portboard/owner-token.json`
(`PORTBOARD_TOKEN_FILE`; 0600, `{"sha256": "…", "created": "…"}`) and prints the token once. A file that isn't 0600
or isn't that shape refuses every token until `portboard token` runs again.

```json
{ "mode": "token", "requireTokenOnLoopback": false }
```

## Device health: `devhealth.json`

The thresholds of the device health alerts ([operations.md](operations.md#device-health-alerts)). A separate file, read on every check and never written; every key is optional, and a missing, wrong-typed or out-of-range key keeps its default.

- **Where it is:** `~/.config/portboard/devhealth.json` (a preview: its own config dir). Set `PORTBOARD_DEVHEALTH` to read it from somewhere else.
- **The code:** `src/core/devhealth.ts` (`DEFAULT_THRESHOLDS`, `parseThresholds`).

| Key | Default | Range | Meaning |
|---|---|---|---|
| `failMinRuns` | 5 | 1–1000 | A compute-pool host's failure rate counts only with at least this many runs in the last 24 h |
| `failPct` | 50 | 1–100 | Alert when this share (%) of those runs failed; it recovers at 10 points under |
| `offlineMin` | 30 | 1–1440 | Alert when a Proxmox guest is `running` and its tailnet device has been offline this many minutes |
| `loadPerCore` | 2 | 0.1–64 | Alert when a pool host's load1 / cores is at this or more; it recovers at 80 % of it |
| `loadMin` | 15 | 1–1440 | … for this many minutes |
| `recoverMin` | 5 | 1–120 | A condition must be clear this many minutes to send the recovery |
| `reminderHours` | 6 | 1–168 | A reminder while a condition lasts |

```json
{ "failPct": 60, "offlineMin": 60, "loadPerCore": 3 }
```
