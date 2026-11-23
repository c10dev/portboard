### Added
- `npm run build:shim` builds `claude-plugin/bin/portboard-shim`, a Go binary (standard library only) for the plugin's MCP client and port nudge. `bin/run.sh` uses it when it is there and passes `portboard-shim version`; otherwise Node runs as before. `PORTBOARD_SHIM=0` turns it off. The Go and Node versions share the cases in `test/fixtures/shim-contract/`.

### Changed
- The thin MCP client's `-32603` message ends with the status code, `lost`, `timeout` or `bad reply`, instead of a system error code, so the Go and Node clients write the same bytes.
- The Go port nudge asks the dashboard about every Bash command of at most 4096 bytes (the Node hook filters first), and does not nudge a longer one.

### Docs
- A hook time limit above Claude Code's hook `timeout` (5 s) ends with Claude Code's timeout.
- The thin client's 409 `local only tool` exception to "a sent request is not sent again" is written in `docs/mcp.md`.
