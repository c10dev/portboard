---
description: Where a repo or branch is checked out across machines (Portboard find_worktree).
argument-hint: "<repo@branch, branch, or part of it>"
---

Call the Portboard MCP tool `find_worktree` for: $ARGUMENTS

- `repo@branch` → pass `repo` and `branch`. A bare word → pass it as `query` (a substring of repo@branch).
- With nothing given, use this session's repository folder name and current branch.

List each match as `machine — repo@branch`, with its uncommitted file count, whether a process or an active Claude
Code session works there, and its reserved port. When `conflict` is set, lead with it: one branch is being worked on
in two places, so the person should pull or hand off before editing here.
