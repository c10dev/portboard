### Changed
- A server left running after Claude Code removed its worktree (`<repo>/.claude/worktrees/<name>`) is a cleanup candidate with its own reason, "its Claude Code worktree was removed", instead of the generic "working folder deleted".
- When a worktree's `.claude/launch.json` gives Claude Code's preview a different port than the one reserved for it, the port nudge says so and points at `write_launch_config`.
