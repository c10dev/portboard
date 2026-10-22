### Added
- `machine_status`, `find_worktree` and `where_to_run` (local stdio MCP tools, and `GET /api/machines`, `/api/where-to-run`, `/api/find-worktree`): every machine work can run on (this one, each `portboard agent`, the cloud when `machines.cloud.enabled`) with load, Claude Code sessions, checkouts (repo@branch, dirty, in use, reserved port) and port counts; which machine has a branch checked out, with a conflict note when two do and one has work in it; and which machine a task should run on, with why, caveats, how to open the session there and alternatives. Nothing is started: a person opens the session (docs/multi-host.md).
- `portboard agent` serves `GET /agent/v1/status` (its own schema, so older boards and agents keep working): sessions with 8-character ids, checkouts by repo@branch (paths only with `agent.showPaths`), port counts and capabilities. The board reads it with info and ports; an older agent's 404 leaves it empty.
- `portboard.json`: `agents[].kind`, `tags` and `maxSessions`, `machines.self` / `machines.cloud`, `recommend.weights`, `agent.showPaths` (docs/config.md).

### Changed
- The worktree scan also lists repos without linked worktrees (`checkouts`, with the branch read from `.git/HEAD`), and the memory view's sessions carry their cwd (local only; the remote `memory_usage` never shows it).
- On macOS, the agent's load reports total and free memory instead of none.
