---
description: Which machine to run a task on (Portboard where_to_run). Recommends, never starts anything.
argument-hint: "<task, e.g. shop-web feat-map dev server>"
---

Call the Portboard MCP tool `where_to_run` for this task: $ARGUMENTS

- Pass the sentence as `task`. When it names a repository and a branch you can tell apart, also pass `repo` and
  `branch`; when it clearly needs something (a dev server, docker, macOS, a long run, parallel or isolated work), pass
  `needs`. Don't guess beyond what it says.
- With no task given, use this session's repository and branch (`git rev-parse --show-toplevel`, folder name, and
  `git branch --show-current`).

Answer in a few lines: the recommended machine and why, its caveats, how to open the session there (`how.via`, `cwd`,
`steps`), then the alternatives in one line each and the excluded machines with their reasons. Say how old the data is
when any machine's `dataAge` is over a minute. Portboard does not start sessions: say what the person opens (Desktop
app SSH, cloud, Remote Control or `--teleport`), and do not start one yourself.
