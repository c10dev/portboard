### Added
- Add accounts in Settings › Accounts (`accounts.enabled`, owner only): Claude (sign in on the vendor's page and paste the code), ChatGPT/Codex and GitHub Copilot (device code). An added account shows in the same list as the CLI logins, with its name and an "Added here" mark. Claude and Codex accounts show their limits; Copilot has none. Tokens stay in `accounts.json` (0600, `PORTBOARD_ACCOUNTS`; a file that group or others can read is not used) and are never refreshed yet. A device-code poll survives a network error, a timeout, a 5xx or a 429, and a flow cancelled while the vendor answers is not saved. The new `POST /api/accounts/login/start`, `finish`, `poll` and `cancel` routes need the owner and `X-Portboard`; the audit line keeps the key names and no pasted code. `list_accounts` lists added accounts too. See docs/accounts.md.

### Fixed
- Accounts: the usage cache drops entries unused for 24 hours and holds at most 64. A usage answer whose Content-Length is over the limit now closes its body unread.

### Docs
- Accounts: the cache and the failure wait are per process, `login store not read on this platform` is one of the fixed errors, other keys of the login files are "not used and not kept", and text from the login files is cut like text from an answer.
