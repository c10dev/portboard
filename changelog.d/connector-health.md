### Added
- **커넥터 상태 on the 설정 tab** (REA top-10 #10): each remote MCP client and authorization shows its last use and a badge: 정상, 만료 임박 (the authorization ends within `soonDays`), 응답 없음 (live tokens, but no call for `idleDays`) or 만료됨 (a registered client whose tokens are gone). A banner "연결 n개가 확인이 필요해요" offers 다시 연결, with the steps and 승인 코드 만들기 inline, and "n일 동안 숨기기", which is per browser and returns early when something new needs a look. `GET /api/remote/clients` adds `health`, `attention` and `thresholds`. The thresholds are set in `remote.json` `"health"` and default to 7/7/7 days. The setup checklist's claude.ai 커넥터 item warns, and the digest adds one 🔌 line, only when a connection needs attention ([docs/settings](docs/settings/README.md#커넥터-상태)).

### Changed
- The remote server copies an access token's "last used" onto its authorization's live refresh token. The 설정 tab then still knows when ChatGPT or claude.ai last called after the hour-long access token has expired.
