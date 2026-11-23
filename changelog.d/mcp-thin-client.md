### Changed
- The plugin's MCP process asks the running dashboard to answer (`POST /api/mcp`) and stays small, and falls back to the in-process server when the dashboard is down; `GET /api/claude/port-advice` also takes a `command` (#62).
