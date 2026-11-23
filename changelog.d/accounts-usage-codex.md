### Added
- Accounts: the usage log now records input, output and cache token counts for Codex requests, read from the `usage` of `response.completed` and `response.incomplete` (or of a JSON answer). A Codex `input` includes cached tokens; a Claude `input` does not. See docs/accounts.md.
