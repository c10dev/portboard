// 메모리: where this server's RAM goes, grouped the way the owner thinks about it (Claude Code sessions, the MCP servers
// every session spawns, services and dev servers, docker containers, the rest), and memory-pressure alerts.
//
//   sources   /proc/meminfo, /proc/pressure/memory, /proc/stat (btime), /proc/<pid>/stat and cmdline for every
//             process, /proc/<pid>/environ of a Claude CLI's descendants (only CLAUDE_CODE_SESSION_ID is kept: the
//             CLI's own environ carries its OAuth token and is never read whole), /proc/<pid>/cwd of each CLI, and
//             /sys/fs/cgroup/system.slice/docker-<id>.scope for containers (no `docker stats`; `docker ps` names them,
//             cached). Nothing is spawned per process.
//   grouping  two views, on purpose different:
//             - groups: a strict partition, every process counted once: docker → MCP instances → services (port
//               owners and their descendants) → claude (the CLIs and their other descendants: tool shells, tests) →
//               other. Their sum is the RSS of all processes (RSS counts shared pages in each process, so it is a
//               little above what `free` calls used).
//             - sessions: each CLI's whole tree (its MCP servers and the servers it started included), with a
//               breakdown. A session's MB therefore also appears under groups.mcp / services.
//   MCP       a server is recognised by command (rea, @playwright/mcp, Portboard's mcp.ts, other *mcp* packages). Each
//             direct child subtree of a CLI that holds one is one instance, wrappers included (npm exec → sh → node).
//   idle      a session is idle when its transcript (~/.claude/projects/*/<id>.jsonl) hasn't been written for
//             `idleMin` and its tree used under IDLE_CPU_PCT of a core since the previous sample; null on the first sample.
//   pressure  stepPressure(): available under `availablePct`, PSI `some avg60` over `psiSome60` or swap over
//             `swapPct`, for `sustainMin` minutes → one warning; a reminder every `reminderHours` while it lasts; one
//             recovery after the condition has been clear (with a margin) for `sustainMin`. Thresholds: memory.json in
//             the config dir (read only, docs/memory/README.md).
//
// Read-only: nothing here stops, signals or changes a process.
//
// Modules (src/core/memory/): parse.ts (/proc parsers), classify.ts (CLI / MCP server / other), sample.ts (the model
// and buildSample), pressure.ts (state machine, alert text), advice.ts (suggestions, digest line), sampler.ts (the
// reader), state.ts (history, memory-state.json, status line). Import from here.

export * from './memory/parse.ts';
export * from './memory/classify.ts';
export * from './memory/sample.ts';
export * from './memory/pressure.ts';
export * from './memory/advice.ts';
export * from './memory/sampler.ts';
export * from './memory/state.ts';
