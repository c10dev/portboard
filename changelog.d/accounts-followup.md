### Fixed
- Accounts: a use and a remove of the same account run one after the other, so no folder with tokens is left behind. A refresh that was running when a use marked the account keeps its new tokens, and the use writes them to the folder file (#154).
- Accounts: a folder file that cannot be checked (an error other than "not found") counts as a folder, so the account is not refreshed. The list passes the account folder to the refresh (#154).
- Accounts: an added Claude account now shows its tier in the list, from its record or, with a folder, from the folder file's `rateLimitTier` (#155).

### Docs
- Accounts: the file table lists `rateLimitTier`, `account needs sign-in again` has its two meanings, a use of an account that was added again replaces the login file and keeps a `.bak`, and `docs/security.md` names the real protection of the folder delete (#154).
