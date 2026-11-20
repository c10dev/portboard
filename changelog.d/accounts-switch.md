### Added
- Settings › Accounts: **Use this account** for an added Claude or Codex account makes a folder for it (`account-homes/<id>/` in the config folder, `PORTBOARD_ACCOUNT_HOMES`; 0700, files 0600), writes the CLI login file into it and shows `CLAUDE_CONFIG_DIR='…' claude` or `CODEX_HOME='…' codex` with a copy button. `~/.claude`, `~/.codex` and running CLIs are not touched. A file that is there is kept once as `.bak`. The account is marked `active` for its provider. **Remove** (with a confirmation) deletes an added account and its folder; a CLI login cannot be removed. The new `POST /api/accounts/use` and `remove` routes need the owner and `X-Portboard`; the audit line keeps the key name and no id. `list_accounts` and `GET /api/accounts` have `active` and `command`. The Claude login file shape is not verified with a real Claude Code yet. See docs/accounts.md.
- An added Claude or Codex account without a folder is refreshed when its access token has expired and the dashboard asks for limits, and before it is used. A 400 or 401 from the vendor saves `needsReauth` ("Sign in again"). Accounts with a folder are never refreshed by Portboard: the CLI refreshes the file in the folder.

### Fixed
- Accounts: the page cancels an add-account flow when the finish request fails. A GitHub Copilot poll answered with a 5xx or 429 and an unknown `error` keeps the flow open. A Copilot flow lives 15 minutes at most. The usage cache holds 64 entries at most when many tokens are added at once.

### Docs
- Accounts: a transient poll failure is one before the vendor's first answer; `accounts.json` and `account-homes` are in the platform table.
