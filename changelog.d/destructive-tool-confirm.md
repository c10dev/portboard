### Changed
- MCP: the descriptions of `restart_service`, `unexpose_port` and `stop_dev_server` tell the model to confirm with the user first unless the user asked for the action, as `stop_service` already does. A test checks that every destructive local tool says this.
- MCP: the stdio server's `initialize` instructions ask before `stop_service`, `restart_service`, `unexpose_port` or `stop_dev_server` unless the user asked for it. Before, they named only `stop_service`. The plugin's dev-servers-and-ports skill marks `stop_dev_server` "ask first" too.

### Fixed
- Tests: the two tests that start the stdio MCP server give it a clean environment with `HOME` in a temp dir. The server can no longer use the real config and state dirs or the parent's `PORTBOARD_*` overrides.

### Docs
- docs/agents.md: step 6 says that the `stop_dev_server` description tells the agent to ask the user first.
