### Fixed
- Accounts: a use and a remove of the same account run one after the other, so no folder with tokens is left behind. A refresh that was running when a use marked the account keeps its new tokens, and the use writes them to the folder file.
- Accounts: a folder file that cannot be checked (an error other than "not found") counts as a folder, so the account is not refreshed. The list passes the account folder to the refresh.
- Accounts: an account added by sign-in whose profile has a rate-limit tier stores that tier as its plan too, so the list shows it once. An account with a folder shows the tier when the folder file's `rateLimitTier` differs from the plan.
- Settings › Accounts no longer shows the text "null" above the add-account row.

### Docs
- Accounts: the file table lists `rateLimitTier`, `account needs sign-in again` has its two meanings, a use of an account that was added again replaces the login file and keeps a `.bak`, and `docs/security.md` names the real protection of the folder delete.
