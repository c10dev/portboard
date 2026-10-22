### Added
- 기기 tab: a Machines strip (this server, each `portboard agent`, the cloud) with CPU and memory bars, Claude Code sessions against `maxSessions`, checkouts with work and data age; a card opens its sessions and checkouts. Hidden while no other machine is listed.
- 개발 tab: other machines' checkouts under the same repo (read-only, marked with their machine), a machine filter, and a badge on a checkout whose repo@branch is also on another machine (amber when there are changes or an active session there).
- "Where to run…" on the strip and in the ⌘K palette: asks `GET /api/where-to-run` with a sentence and shows the recommendation, how to open the session, alternatives and the machines left out. Nothing is started.
