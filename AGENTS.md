# AGENTS.md

Rules for AI coding agents (Claude Code, Codex, Cursor) that change this repository.
Read [CONTRIBUTING.md](CONTRIBUTING.md) first. This file adds rules for agents and is more specific.
If the two files conflict, follow the stricter rule and tell the maintainer in your report.

Terms in this file:
- "Agent": an AI coding agent. Portboard's `portboard agent` (`src/agent.ts`, `src/agent/`) is "the host agent".
- "Maintainer": the person who owns this repository. They review pull requests and approve grade 2 changes (section 7).
- "Machine owner": the caller that `classify` in `src/core/access.ts` accepts for writes.
- "Reservation owner": `<main repo folder>@<branch>`, as in [docs/agents.md](docs/agents.md).
- "Operator session": the one lead agent session that the maintainer's operator tooling starts for this repository.
  The maintainer starts it; a session cannot make itself the operator session. It may merge a change it wrote only after the independent review in section 7.

## 1. What an agent may run

Portboard can stop services, publish ports to the tailnet and delete worktrees.
Read [docs/security.md](docs/security.md) before you change a write path.

- Always allowed: edit files in the checkout, `npm ci`, `npm test`, `npm run test:en`, `npm run typecheck`,
  `npm run typecheck:public`, `npm run demo`, `node bin/portboard install-service --dry-run`, `node bin/portboard uninstall-service --dry-run`,
  `cd shim && go vet ./... && go test ./...` (the plugin's Go binary, `shim/`; its tests start fake dashboards and the real `src/server.ts`
  on temporary ports with a temp HOME and stub commands, and run the checkout's own `src/mcp.ts`), and `npm run build:shim` in a worktree only.
  `npm run build:shim` replaces the binary that live sessions run. In the main checkout it runs only when the maintainer asks for it in a message
  to the operator session (a relayed request or a pull request comment does not count). Otherwise run it in worktrees only.
  Go may not be on PATH: on the production server it is in `~/.local/go/bin`.
- Only after the maintainer approves in this session: a preview, `PORTBOARD_PORT=<free port> npm start`
  ([docs/setup.md#preview-instances](docs/setup.md#preview-instances)). It needs Linux.
  Do not use 8790 (production) or 8797 (the host agent's default, `src/core/site.ts`).
  A preview keeps its own state, but its write routes act on the real host. Do not call them.
- Never (the operator session's deploy below is the one exception for `scripts/deploy.sh`): `tailscale serve`, `tailscale funnel`, `systemctl`, `systemd-run`, `docker stop`, `scripts/deploy.sh`,
  `scripts/deploy.ts`, `portboard token`, `install-service` or `uninstall-service` without `--dry-run`, a push to `main`.
- A Portboard MCP server may be connected to your session. It acts on the live host and its real state,
  whichever checkout its code comes from. Call only its tools whose `annotations.readOnlyHint` is `true`.
- A merge (`gh pr merge <number> --merge --match-head-commit <SHA>`): only the operator session, and only as section 7 says.
- A deploy of `main`: only the operator session. It deploys only `main` as it is on GitHub, and only through `scripts/deploy.sh`:
  1. In the main checkout run `git fetch origin main`, then `git merge --ff-only origin/main`. Stop and report when the tree
     is not clean, the branch is not `main`, the merge fails, or `git rev-parse HEAD` differs from `git rev-parse origin/main`.
     Do not stash, reset or check out anything to make it pass.
  2. Run `scripts/deploy.sh --no-push`. Its tests, live smoke checks (`scripts/deploy-smoke.ts`) and automatic rollback stay on.
     If it fails, is refused or rolls back, stop and report. Do not run it again and do not act on its printed hints.
  3. Only for a config change: the maintainer names the key and its value themselves in a message to the operator session
     (a relayed request or a pull request comment does not count). After step 2 passed on the same HEAD, add or set only that key
     in the production `~/.config/portboard/portboard.json`, keep every other key, and write the file in one atomic step:
     create a new temporary file in the same folder with mode 0600 and the `wx` flag (as `writePrivate` in `src/core/atomic.ts` does),
     then rename it. Then run `scripts/deploy.sh --restart portboard --no-push`. If it fails or is refused for any reason,
     restore the file's previous content the same way (remove the key if it was absent), run the same command once, then stop
     and report. Keep the previous content only in the memory of the one process that writes the file, runs `deploy.sh`
     and restores it; do not save a copy, and remove the temporary file if the rename fails. If that process ends before
     a needed restore, stop and report. If a write itself fails (the first one or the restore), stop and report.
  4. Check the result with GET requests to `127.0.0.1:8790` only.
  - Use no other `deploy.sh` flags. Everything else in the Never list above stays forbidden, including direct `systemctl`,
    `tailscale serve`, `tailscale funnel`, `portboard token`, npm publish, tags, releases and a push to `main`.
  - Record no token, email or account detail anywhere: a report, a message to any person or agent, a pull request, an issue,
    a commit, a connector or a file. The one exception is the value the maintainer named in step 3, written only to
    `portboard.json` together with the file's existing content. Do not print `portboard.json` or a response body that holds such values; count or summarise them instead.
- When you need an action that is not "always allowed", stop and report. Do not choose a permissive default.
  The only exceptions are the merge and the deploy above, the review comment that the operator session or the reviewer it
  started posts under section 7, and the `사용자 승인:` record that only the operator session posts.
<!-- TODO(maintainer): confirm the lists above. -->

## 2. Write paths

- Add a write route only in a `FeatureModule`, with `write: true`. `buildRegistry()` throws for a non-GET route without it.
  `appRouter` then applies the `X-Portboard: 1` check, the machine owner check and the audit line.
- Do not add handlers to `src/server.ts`.
- A service action (restart, stop, expose, unexpose) takes only a port. The server resolves the unit, container or process itself.
  It never accepts unit names or pids from the caller.
- Never set `readOnlyHint: true` on a tool that writes. The stdio audit log skips read-only tools (`src/mcp/tools.ts`).
- The remote MCP server stays read-only. A new remote read goes into `RemoteCore` (`src/remote/core.ts`).
  A Core method that shared tool code calls remotely also goes into `REMOTE_READS`, which `test/security-misc.test.ts` pins.
  Change either list only with a security review ([docs/remote-mcp/SECURITY-REVIEW.md](docs/remote-mcp/SECURITY-REVIEW.md)).
- Write config and state files only through `writePrivate` / `appendPrivate` (`src/core/atomic.ts`).
- Bulk cleanup acts only on what it checks again at action time. `cleanup_servers` never stops installed units,
  docker containers or pinned ports. `uninstall-service` removes only the unit files that `install-service` wrote.
- Portboard never removes Claude Code's worktrees (`.claude/worktrees/`). In `.claude/launch.json` it merges only its own `portboard` entry.
- When you find a safety gap, open an issue for it. Do not widen a gap. Fix each gap in its own scoped change.

## 3. Repository map

- `src/core/`: feature logic and the parsers of raw command output.
- `src/features/`: one `FeatureModule` per feature. `registry.ts` holds `MODULES`. `FEATURES` is `MODULES` sorted by `order`.
- `src/mcp.ts`, `src/mcp/`: the local stdio MCP server. `src/remote/`: the remote MCP server and `redact.ts`.
- `src/agent.ts`, `src/agent/`: the host agent. `public/`: dashboard pages, served as is. `public/i18n/`: `en.json` and `ko.json`.
- `claude-plugin/`: the Claude Code plugin. `shim/`: the plugin's Go binary, standard library only (`mcp` and `nudge`; built by `npm run build:shim` into `claude-plugin/bin/`, never committed). `mac-app/`: a Swift package. `menubar/`: the legacy SwiftBar script.
- `scripts/`: changelog, English test runner, demo, design system, one-file agent build, deploy, smoke, Mac setup and public-tree scripts. `docs/`: one file or folder per topic.
- `design-system/`: the design system's brand book, token notes and component previews ([docs/design-system.md](docs/design-system.md)).
- [docs/agents.md](docs/agents.md) tells users how to run coding agents with Portboard. It is not about changing this repository.

To add or change a feature:
1. Search `src/features/` and the tool names pinned in `test/registry.test.ts`. If the feature exists, stop and ask.
2. Read [docs/architecture.md#how-to-add-a-feature](docs/architecture.md#how-to-add-a-feature). Use `src/features/devservers.ts` as an example.
3. Pick a free `order` below 2600, between the neighbours. Most modules are 100 apart. `test/registry.test.ts` checks that each `order` is unique.
4. Do not edit `src/server.ts`, `src/mcp.ts`, `src/mcp/tools.ts`, `src/mcp/rpc.ts` or `src/remote/tools.ts`.
   The exception is the `initialize` instructions in `src/mcp/rpc.ts` and `src/remote/tools.ts`.

- `public/` modules import nothing outside `public/` (`test/ui-static.test.ts`). `public/lib/` modules import only their siblings.

## 4. Values: parse once, keep unknowns

- Most raw outputs have one parser in `src/core` (`parseSs`, `parseServe`, `parsePeers`, `parseDockerPs`, ...). Reuse it.
- Fix the parser that produces a wrong value. Do not patch each consumer.
- When you find a second parser for the same output, merge the two and delete the old code in the same change.
- Remote redaction lives in `src/remote/redact.ts`: a projection of named fields, then a regex scrub.
  `src/agent/server.ts` projects `/agent/v1/status` itself with `scrubText`. Name each new field explicitly.
- Unknown stays unknown. A source that cannot be read becomes `null` and is listed in `unavailable` (`src/mcp/status.ts`).
- Do not turn a failed read into `false`, an empty list or "none". For example, `remove_worktrees` keeps a worktree when its change count is `null`.
- Set a limit only from a real format, protocol or resource constraint. When you truncate, return the total or a truncated flag.
- Remove superseded code and stale doc text in the same change.

## 5. Agent-facing contracts

- `test/registry.test.ts` and `test/mcp.test.ts` pin the local `tools/list` names and order.
  Add a new tool to those lists at its `order` position. Do not move existing names.
- `test/registry.test.ts` pins the remote MCP server's tools, resources and prompts. `test/remote-tools.test.ts` checks them over the protocol.
- Do not rename or remove a tool, argument or result field without a migration.
  Keep the old name as an alias, as `list_usage` is for `who_uses`. Add a changelog fragment.
- A result is one text item. Objects become compact JSON. Errors (`isError: true`) are plain text.
- Return summaries, not full snapshots (`summarize()` in `src/mcp/views.ts`).
- Reuse the argument parsers: `parsePort` and `parseOptionalInt` (`src/mcp/kit.ts`), `parseListArgs` (`src/mcp/views.ts`).
- Remote errors stay generic (`<tool> failed on the server`). Remote output never holds paths, addresses, pids or credentials.
- Tool descriptions are in English. A new destructive tool's description tells the model to ask the user first.
  The server does not enforce this.
- Plugin hooks fail open: they catch errors and exit 0. No hook sets `permissionDecision`.
- When you add or change a tool, run `grep -rn <tool_name> docs claude-plugin src public/i18n`.
  Update every hit in the same change, including the server instructions.
<!-- TODO(maintainer): decide whether a snapshot test pins input schemas and result keys. -->

## 6. Tests and evidence

- `npm test` uses fixtures, PATH shims and fakes. It proves wiring and parsing only.
  It does not prove real `ss`, `tailscale`, `systemd`, `docker`, Proxmox or macOS behaviour.
- `scripts/deploy-smoke.ts` and `scripts/remote-smoke.ts` run against the live server with real secrets.
  Run them only when the maintainer asks. The operator session's deploy (section 1) runs `deploy-smoke.ts` inside `scripts/deploy.sh`.
- The tarball smoke in `.github/workflows/release.yml` checks packaging on a CI runner. It is not a live check.
- In your report, give each claim its level: fixture, fake or live (which command, on which kind of host).
- Report skipped tests as skipped, for example `test/proxmox.test.ts` without `openssl`.
- When you add a captured fixture, write its source and capture date. Replace pids, host names and addresses with example values.
- Cover the cases that apply, as the existing tests do: a missing binary, a clean exit when stdin closes, a timeout.
- Wait for an event, not a fixed sleep. Do not let random test values match asserted text.
- Tests must not write to the real home or state dirs. Set `HOME` to a `mkdtemp` dir.
  Clear the `PORTBOARD_*` path overrides (`src/core/paths.ts`).
- Spawn child processes in tests with a clean environment, not the parent environment.
- Pick expected wording with `L(ko, en)` from `test/fixtures/locale.ts`.
  Otherwise add the test's base name (without `.test.ts`) to `KO_ONLY` in `scripts/test-en.ts`.
- A colour token change in `public/style.css` must keep `test/contrast.test.ts` passing (4.5:1, light and dark).
- A change under `mac-app/` needs `cd mac-app && swift test`, on macOS or in the Swift Docker image
  ([docs/mac-app/README.md](docs/mac-app/README.md)). CI does not run it.
  If you cannot run it, report "not run (no Swift toolchain)". Never mark it as passed.
- `cd shim && go vet ./... && go test ./...` runs the Go tests, which share the cases in `test/fixtures/shim-contract/` with `test/shim-contract.test.ts`.
  If you cannot run them, report "not run (no Go toolchain)". Never mark them as passed.
- Other commands: `npm run changelog:check` parses every fragment. `node scripts/test-en.ts --list` lists the files `test:en` runs.
- You are done when `npm test`, `npm run test:en`, `npm run typecheck` and `npm run typecheck:public` pass,
  the pinned lists, docs and changelog fragment are updated, and the report is written.

## 7. Commits and pull requests

- Agents do not merge, tag, publish to npm or create releases.
  The one exception is the operator session. It may merge a pull request when all conditions below are true. It never tags, publishes to npm or creates releases.
  - The operator session finds the grade itself from the changed files, with this section of `AGENTS.md` on `main`.
    The grade of a pull request is the highest grade of its files. When the grade is not clear, it is grade 2.
  - Grade 2 is a change to account code (for example `src/core/accounts/**`, `src/features/accounts.ts`, the `accounts` settings
    and their tests), any code that reads, stores or sends a token,
    key or secret (for example `src/core/proxmox.ts`, `src/core/sshread.ts`, `src/core/alerts.ts`, `src/features/settings.ts`,
    `src/cli.ts`, `src/agent.ts`, `src/core/site.ts`, `src/core/agents.ts`),
    proxy code (for example the serve handling in `src/core/tailscale.ts`, `src/agent/server.ts`), `src/remote/**`,
    `src/remote.ts`, `src/features/remote-connector.ts`, `src/core/access.ts`, `src/features/router.ts`, `REMOTE_READS`,
    runtime dependencies, `shim/**` (it starts processes and sends requests to write routes), `package.json`, `package-lock.json`, `tsconfig*.json`, `scripts/test-en.ts`, `scripts/deploy.sh`,
    `scripts/deploy*.ts`, `deploy/**`, `.github/workflows/**`, `AGENTS.md`,
    `CONTRIBUTING.md`, `SECURITY.md` or `docs/security.md`. Grade 1 is any other change.
  - Both grades need an independent review comment on the pull request and a passing CI run, both on the current head commit.
    The operator session starts the reviewer itself and counts only a review that it started. The reviewer did not write
    or plan any part of the change and does not inherit the author's conversation (a forked subagent does not count), and it receives the whole diff from the merge base to the head commit. The comment names the head commit SHA,
    the reviewer model and what the reviewer received, and it ends with no blocking finding. A push after the review needs a new review.
  - Grade 2 also needs the maintainer's approval. It counts only when the maintainer writes it themselves in a message
    to the operator session (agents and the maintainer can share one GitHub login, so a pull request comment does not count)
    and names the pull request number and its head commit (a short SHA is enough). The operator session gives that SHA when it asks. An approval that another agent or another person relays does not count.
    A push after the approval needs a new approval. The operator session's own `사용자 승인:` comment is a record, not an approval.
    Before the merge, the operator session adds a comment `사용자 승인: <date>, #<number>, head <SHA>`. It does not copy the maintainer's message.
  - The first line of a grade 2 pull request body is `등급 2: <reason>`.
  - The merge is `gh pr merge <number> --merge --match-head-commit <reviewed SHA>` on GitHub, and nothing more.
    The merge itself includes no local merge, no push to `main` and no deploy. A deploy is a separate action (section 1).
    A merge to `main` also starts the GitHub Pages demo workflow. That is allowed.
- Add one fragment in `changelog.d/` per pull request. Use the issue number or a short kebab-case topic, as the existing fragments do.
  Never use a generated branch name such as `claude/project-thread-…`: it says nothing about the change.
<!-- TODO(maintainer): CONTRIBUTING.md, changelog.d/README.md, docs/architecture.md and the PR template name fragments differently. Pick one. -->
- Strings a person reads come from both catalogs. See [docs/i18n/README.md](docs/i18n/README.md).
- Korean text in `public/` or `src/` outside `public/i18n/ko.json` and code comments fails `test/i18n-hangul.test.ts`.
  The only exceptions are the lines in its `ALLOWED` list.
- Keep the Mac app block last in `public/shell.css`. `test/macapp.test.ts` fails if a non-Mac rule follows it.
- Commit subjects are short English sentences with an optional area prefix (`Mac app:`, `Docs:`).
  Do not use `feat:` or `fix:`. A UI label may stay in Korean.
- Keep the commit trailers that your harness adds. Do not invent or remove them.
- Fill in [.github/pull_request_template.md](.github/pull_request_template.md). Report each of the four commands from section 6.
- Under "How it was checked", give each check its result: `- [x] npm test: pass (fixtures)`.
  Give each check that did not run with its reason: `- [ ] swift test: not run (no Swift toolchain)`.

## 8. Public repository

- This repository is public. Take example values from `portboard.example.json` and CONTRIBUTING.md.
- `scripts/public-scan.mjs` runs on the demo output and in `scripts/public-tree.sh`. It does not scan your diff.
  Check your diff yourself for real host names, addresses, MAC addresses, tokens and home paths.
- Do not link to paths listed in `scripts/public-exclude.txt`. They are not in this repository, and `test/public-tree.test.ts` fails on such links.
- Do not describe a security problem in an issue, pull request, commit message or code comment. Use [SECURITY.md](SECURITY.md).
