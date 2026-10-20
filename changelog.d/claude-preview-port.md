### Added
- `write_launch_config` (MCP) and `POST /api/dev-servers/launch-config`: point Claude Code Desktop's preview at a worktree's reserved port by writing a `portboard` entry into its `.claude/launch.json` (`autoPort: false`, or attach to the server Portboard already runs). Files with comments, tracked files and symlinks are left alone; the file is added to the repo's `info/exclude`.
- Claude Code plugin 0.2.0: a SessionStart and CwdChanged hook exports the worktree's reserved port as `PORT` for the session's Bash commands (via `CLAUDE_ENV_FILE`) and adds one `[portboard]` line about it. Off with the `session_port` option or `PORTBOARD_SESSION_PORT=0`.

- Service pages have **Claude로 열기**: a `claude://code/new` link that opens Claude Code Desktop on a new SSH session to this server, in the service's project folder, with a prompt about the port filled in (not sent). The Mac app opens only that `claude://` page and no other.

### Changed
- Worktrees under `<repo>/.claude/worktrees/` are marked "Claude Code" on the 개발 page and are never offered for removal: Claude Code locks and removes its own worktrees.
- The port nudge mentions the port a worktree's `.claude/launch.json` gives the preview, and the plugin's skill covers the preview, the `PORT` variable, and giving SSH-session users a tailnet URL (`expose_port`) instead of `ssh -L`.
