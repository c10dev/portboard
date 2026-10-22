### Changed
- MCP: the descriptions of `restart_service`, `unexpose_port` and `stop_dev_server` tell the model to confirm with the user first unless the user asked for the action, as `stop_service` already does. A test checks that every destructive local tool says this.

### Fixed
- Tests: the two tests that start the stdio MCP server give it a clean environment with `HOME` in a temp dir. The server can no longer use the real config and state dirs or the parent's `PORTBOARD_*` overrides.
