# Architecture

```
src/core/index.ts     snapshot() / expose(port) / unexpose(port)  ← the single core API
src/core/ss.ts        parses `ss -ltnpH`
src/core/proc.ts      /proc (cmdline, cwd, cgroup→systemd unit)
src/core/docker.ts    docker ps → container that owns each port
src/core/probe.ts     HTTP probe (status code, <title>)
src/core/tailscale.ts tailscale status / serve
src/core/control.ts   restart / stop / logs per owner (systemd, docker, process), free-port picking
src/core/paths.ts     every config/state path, production vs preview profile, preview seeding
src/core/prefs.ts     label / pinned / hidden / alert (+ deviceLinks, deviceAlerts) in ~/.config/portboard/prefs.json
src/core/alerts.ts    down/up alerts: channel, state machine, 30 s checker, quiet windows
src/core/known.ts     known devices: seeding, first-seen diffing, 새 기기 badges, batched new-device alerts
src/core/pvetrends.ts Proxmox rrddata → CPU/memory series per node and guest (downsampled, cached 60 s)
src/core/uptime.ts    uptime of watched ports: run-length segments, %, bars, outages, uptime.json
src/core/detail.ts    one port in full (service.html, /api/ports/:port/detail, service_detail)
src/core/pool.ts      compute-pool host status (GET /api/hosts, fallback /api/state)
src/core/hostports.ts other machines' listening ports: scope (all/tailnet/loopback/other), tailnet/LAN reach, open links
src/core/sshread.ts   shared SSH port reader: key-only ssh args, error codes, schedule/backoff, cache, status
src/core/pveports.ts  Proxmox host + container ports (ss sections) on top of sshread.ts
src/core/winports.ts  the desktop's Windows-side ports (PowerShell TSV) on top of sshread.ts
src/core/devices.ts   tailscale peers joined with pool hosts
src/core/usage.ts     who uses what now: device cards, 사용 중 per port, idle services
src/core/history.ts   last-used history: sampling, merge, 30-day retention, usage-history.json
src/core/groups.ts    ports of the same compose project / container / unit / process → one group
src/features/         feature modules: each owns its REST routes, MCP tools (local and remote), jobs, collectors, page scripts
src/features/registry.ts  MODULES (alphabetical) → FEATURES (by order) + buildRegistry(): derived views and the security checks
src/features/types.ts what a feature module declares
src/features/router.ts REST routing over the declared routes; the one X-Portboard + owner guard and the audit line for every write route
src/features/context.ts the dashboard's shared state: 2 s snapshot/topology/usage caches, history, uptime, checker, 새 기기, self-watch
src/features/jobs.ts  starts the declared background jobs
src/server.ts         binds, checks Host, routes through the registry, serves public/ (plus the features' page scripts), starts jobs
src/mcp.ts            stdio MCP server (Claude Code / Desktop); its Core is the features' mcpCore() merged
src/mcp/kit.ts        what every tool needs: Core (filled in by the features), ToolResult, RpcError, parsePort…
src/mcp/views.ts      the port summary shared by list_ports, service_detail, the port resources and the remote list_ports
src/mcp/tools.ts      tools/list and tools/call over the registry
src/mcp/resources.ts  MCP resources: portboard://status, port/{port}, device/{id} (offered by features/overview.ts)
src/mcp/status.ts     statusReport(): the status summary, shared with the remote's redacted copy
src/mcp/prompts.ts    MCP prompts (Korean): server_status_summary, port_cleanup, new_dev_server, why_not_open
src/mcp/rpc.ts        MCP JSON-RPC dispatch (initialize, ping, tools/*, resources/*, prompts/*)
src/remote/tools.ts   the remote MCP surface: what the features mark remote, nothing else (docs/remote-mcp/)
src/remote/core.ts    RemoteCore (what the remote may read) and readOnlyCore()
bin/portboard-mcp     SSH entry point for remote MCP clients (finds node without nvm)
scripts/mac-setup.sh  one-time Mac setup for Claude Code + Claude Desktop
scripts/mac-menubar-setup.sh  Mac menu bar plugin installer (SwiftBar)
menubar/              SwiftBar plugin (portboard.30s.mjs) + pure formatting (format.mjs), legacy
mac-app/              Native macOS app (SwiftUI): Package.swift, PortboardCore (pure, tested), Portboard (app), build.sh
public/               web dashboard: plain HTML/CSS and native ES modules, no build step, no packages
public/*.html, *.js   one page and its entry script each: index.html + app.js (서비스), devices.html + devices.js (기기),
                      dev.html + dev.js (개발), service.html#<port> + service.js (the service page)
public/features/      the UI of a src/features module, same name: ports, control, devices, usage, known, alerts, uptime,
                      host-ports, proxmox, owners, selfwatch
public/lib/           shared by every page: api (fetch, X-Portboard), dom (el, h, escapeHtml, button, dl), time, format,
                      toast (+ copy), badge (badges, user chips), menu (⋯), dialog (modal, sheet), sparkline, profile
```

The REST API and the MCP server both wrap the same functions in `src/core/`, and each feature module in `src/features/` puts the two side by side:

| Feature module | Core | REST | MCP tool |
|---|---|---|---|
| `ports.ts` | `snapshot()` | `GET /api/ports` | `list_ports` (also remote) |
| `ports.ts` | `expose(port)` / `unexpose(port)` | `POST /api/ports/:port/expose` / `unexpose` | `expose_port` / `unexpose_port` |
| `ports.ts` | `setPrefs(port, patch)` | `POST /api/ports/:port/prefs` | (`set_alert` in `alerts.ts`: alert flag only) |
| `control.ts` | `restart(port)` / `stop(port)` | `POST /api/ports/:port/restart` / `stop` | `restart_service` / `stop_service` |
| `control.ts` | `logs(port, lines)` | `GET /api/ports/:port/logs` | `tail_logs` |
| `devices.ts` | `devices()` | `GET /api/devices` | `list_devices` (also remote) |
| `usage.ts` | `usage()`, history | `GET /api/usage`, `/api/topology`, `POST /api/clients/name` | `who_uses`, `list_usage`, `name_device`; remote `who_uses_what` |
| `free-ports.ts` | `freePorts(count, preferred)` | `GET /api/free-ports` | `free_port` (also remote) |
| `alerts.ts` | the checker (alerts.ts) | `GET /api/alerts`, `POST /api/alerts/test`, `POST /api/devices/:id/alert` | `set_alert` |
| `known.ts` | the 새 기기 tracker | `GET /api/known-devices`, `POST …/ack`, `…/settings` | `list_new_devices` |
| `service-detail.ts` | `serviceDetail(…)` (detail.ts) | `GET /api/ports/:port/detail` | `service_detail` |
| `proxmox.ts` | `proxmoxTrends()` | `GET /api/proxmox/trends` | (in `list_devices`) |
| `host-ports.ts` | pve1 / Windows SSH reads | (in `/api/devices`, `/api/usage`) | (in `list_devices`) |
| `selfwatch.ts` | the self-watch | `GET /api/health` | (in `portboard://status`) |
| `digest.ts` | `buildDigest`, `decide` (core/digest.ts) | `GET`/`POST /api/digest`, `GET /api/digest/preview`, `POST /api/digest/send` | `digest_preview`, `set_digest` |
| `adoption.ts` | `scanTranscripts`, `summarize` (core/adoption.ts) | `GET /api/adoption`; a digest line | `adoption_stats` |
| `port-rules.ts` | `parseRuleKey`, `setPortRule` (prefs.ts), `ruleResolver` (portrules.ts; the snapshot applies it) | `GET`/`POST /api/port-rules` | `list_port_rules`, `set_port_rule` |
| `newports.ts` | the new-port tracker (core/newports.ts), a 15 s job | `GET /api/new-ports` | |
| `overview.ts` | | | resources `portboard://status`, `port/{port}`, `device/{id}`; the prompts |

Actions take only a port; the server resolves the owner (systemd unit → docker container → process) itself and never accepts unit names or pids from clients.

## How to add a feature

A feature is one file in `src/features/` plus one import and one `MODULES` line in `src/features/registry.ts`. Adding or changing a feature should not touch `server.ts`, `mcp/tools.ts`, `mcp/rpc.ts`, `remote/tools.ts` or `mcp.ts`.

1. **The core.** Put the logic in `src/core/<name>.ts` as plain functions, testable without a server (as today).
2. **The module.** Create `src/features/<name>.ts` exporting a `FeatureModule` (`src/features/types.ts`). Declare only what the feature has:
   - `routes`: `{ method: 'GET', path, handler }` or `{ method: 'POST', write: true, body?: { limit }, path, handler }`. Paths may use `:port` (checked 1–65535, else 400 `bad port`) and `:device`. Handlers get `{ url, params, body }` and the shared `ServerContext` and return `{ status, body }` (`ok()` / `reply()` from `router.ts`). The router checks the `X-Portboard: 1` header and, in the dashboard (`appRouter`), that the caller is the owner (src/core/access.ts, [security.md](security.md)) on every non-GET route before the handler runs, parses the JSON body, and writes an audit line for every write. Body fields named `port`, `path`, `repo`, … are logged as targets; free text never is.
   - `tools`: `{ def, call(args, core) }`, where `def` is the MCP tool definition. If the tool needs something from the core, add it to `Core` in the same file with `declare module '../mcp/kit.ts' { interface Core { … } }`, and provide it for the stdio server in `mcpCore()`. Keep the argument checks and result shaping in the module.
   - `jobs`: `{ name, everyMs, runAtStart?, run(ctx) }` or `{ name, start(ctx) }` for something with its own timer, with `enabled(paths)` when it must not run everywhere (anything that sends alerts: `paths.alertsOn`, which is false in a preview).
   - `shutdown(ctx)` for what must be flushed on exit, `collectors` for the `health.ts` collector names it reports (add the label to `COLLECTORS` there), `ui` for page scripts (`{ pages: ['index.html'], script: 'features/x.js' }`: the server adds the `<script type="module">` before `</body>`, so the page doesn't carry it). See [Adding UI for a feature](#adding-ui-for-a-feature).
   - `resources` / `prompts` for MCP resources (a `claims(uri)` / `read()` pair and `list()`) and prompts. `list()` must not reject: `resources/list` waits for every module's list, so one failing source should leave its entries out instead.
3. **Register it.** Give the module an `order` number and import it in `registry.ts`, putting the import and the `MODULES` line in alphabetical order (by file name, and by name ignoring case); `test/registry.test.ts` checks both. Don't append at the end: branches that all append to one list conflict on every merge, while alphabetical lines land in different places. `FEATURES` is `MODULES` sorted by `order`, and that order is the order of `tools/list`, routes, jobs and page scripts (`test/registry.test.ts` pins the current order). Existing modules are spaced by 100, so pick a free number between the two features the new one should sit between; below 2600 keeps it before `remote-connector`, `access`, `write-devices` and `settings`, which stay last. If two branches pick the same number, the merge has no textual conflict, but the unique-order test fails until one of them changes.
4. **Remote (internet-facing) only on purpose.** A tool is offered to the remote connector only with `remote: { description, call(args, remoteCore, policy) }` next to its local definition (or as a `remoteTools` entry). Only read-only tools may (the registry refuses others), the remote `call` only gets the read-only `RemoteCore` and must redact (`src/remote/redact.ts`), and `test/registry.test.ts` pins the remote set: changing it is a security review (`docs/remote-mcp/SECURITY-REVIEW.md`). If the remote server needs a new read, add it to `RemoteCore` (`src/remote/core.ts`) and `src/remote.ts`.
5. **Shared state.** If the feature needs state the dashboard keeps across requests (a cache, a store, a tracker), it goes in `ServerContext` (`src/features/context.ts`). That file is the one shared piece still edited by more than one feature; one scheduler for all collection (#24) is meant to take it over.
6. **Tests and docs.** Test the core and the module's handlers with fakes (`test/registry.test.ts` shows a router with a fake context). Run `npm test` and `npm run typecheck`. Document user-facing changes in the topic's doc and add a `changelog.d/<issue>.md` fragment.

Still shared on purpose: the `MODULES` list (one alphabetical line per feature), `ServerContext`, `COLLECTORS` labels in `src/core/health.ts`, `RemoteCore` / `readOnlyCore` (a security boundary that should stay one reviewed place), the stdio and remote `initialize` instructions in `src/mcp/rpc.ts` and `src/remote/tools.ts`, and each page's entry script (`public/app.js`, `devices.js`, `service.js`, `dev.js`), which wires the feature modules together.

## Background jobs

`src/features/jobs.ts` runs every feature's interval job (`{ name, everyMs, runAtStart?, run }`) on one scheduler: a 1 s tick, jittered start times, no overlap per job, error isolation, state in `/api/health?detail` → `runtime.jobs`. A job that needs its own timer declares `start(ctx)` instead (alert checker, self-watch). Read-only commands that several jobs need within seconds go through `runShared` (`src/core/exec.ts`).


## Adding UI for a feature

The front end is native ES modules served as they are from `public/`: no bundler, no packages, nothing to build. A module imports others by relative path (`import { el } from '../lib/dom.js'`).

- **Where it goes.** The UI of `src/features/<name>.ts` lives in `public/features/<name>.js` (same name). Helpers that know nothing about a feature go in `public/lib/`; `lib/` never imports from `features/` or a page (a test checks).
- **Two ways onto a page.**
  - *Self-contained* (a header chip, a banner, a dialog of its own): declare it in the feature module, `ui: [{ pages: ['index.html'], script: 'features/<name>.js' }]`, and it runs on its own; the server adds the tag. `features/selfwatch.js` and `features/owners.js` work this way.
  - *Part of a page's rendering* (rows, cards, a section the page redraws every 10 s): export functions that return elements and import them from the page's entry script, which owns the state and the refresh loop. Pass what the module needs from the page as a small context object (`{ data, showDetail, refresh, … }`, with getters for state that changes) instead of reaching into the page.
- **The shell.** Every page sits in one shell (one bar, the sidebar, the inspector). Its markup comes from `src/core/shell.ts`, which the server expands into the page's `<!--#shell:…-->` markers. `lib/shell-boot.js` is inlined to paint the remembered state before the first paint, and `lib/shell.js`, imported first by the page's entry script, wires it. Page controls go in the header's `.controls`, the title's context in `#shellCtx`, and filters in `#filterPanel`. A chip or note for the sidebar footer goes in `#shellFoot`. Main content that needs its data first waits with `<main data-wait="page …">` and `done('page')`.
- **Use `lib/`, don't copy it.**
  - `api.js`: `getJSON` (throws `HTTP n`), `readJSON` (any status), `tryJSON` (null on failure, for optional parts of a page), `post(path, body?)` → `{ ok, status, body }` with `X-Portboard: 1` already set (a 403 with the Korean reason, without sending, once `access.js` knows this browser is read-only), `postOrThrow`, `errorText`. `access.js`: `showAccess()` asks `/api/whoami` and marks a read-only page. `audit.js`: one audit entry as a list row.
  - `dom.js`: `$`, `el(tag, cls, text)`, `h(tag, props, ...children)`, `button(label, onClick, { disabled, danger, title })`, `extLink`, `dl(rows)`, and `escapeHtml` for anything put into an HTML string (prefer building nodes).
  - `time.js` / `format.js`: the Korean relative times (`ago`, `agoMonths`, `agoDays`, `lasting`, `checkedAgo`) and durations, sizes and percentages. The pages use slightly different wordings; pick the one the page already uses rather than adding another.
  - Components: `badge(text, tone)`, `usingChip(u)` / `userChip(…)`, `moreMenu({ ariaLabel, items, open, onToggle })`, `modal(id, html, closeId)` for a dialog from a fixed template, `sheet(panel, closeBtn, onClose)` for a side panel, `toast(text, error, { link, ms })` and `copy(text)` (clipboard, or a prompt on plain http), `sparkline(values, …)`.
- **Markup and text.** Reuse the existing CSS classes (`style.css`, the page's own CSS); labels are Korean. A write that stops or removes something asks first with `window.confirm`.
- **Checks.** `test/ui-static.test.ts` parses every module, resolves every import and checks the imported names are exported, and fails on a module no page loads. Pure helpers get node tests (`test/ui-lib.test.ts`).
