### Added
- A read-only Accounts section in Settings (`#settings/accounts`), `GET /api/accounts` and the local MCP tool `list_accounts`. They show the plan, expiry and remaining limits of this machine's Claude Code and Codex logins. Off by default: set `accounts.enabled` in `portboard.json`. Owner only, no remote MCP, and no token leaves the process. See docs/accounts.md.
