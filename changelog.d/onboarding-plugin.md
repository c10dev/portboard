### Fixed
- 설정 체크리스트: the Claude Code item recognises the portboard plugin (`enabledPlugins` in `~/.claude/settings.json`) instead of reporting "MCP 서버가 없어요" after the move from `claude mcp add`; its next step is now the plugin install.
- The ended-sessions list (#43) no longer serves a stale cache when two writes land within one mtime tick (seen on CI): the cache key includes the inode and size.
- Remote connector: an unauthenticated `GET` (or `HEAD`, `DELETE`, `OPTIONS`) on `/mcp` now gets the `401` + `WWW-Authenticate` challenge instead of `405`, so a client whose first probe is a GET starts OAuth discovery. claude.ai reported "the server did not respond" for this URL. With a valid token, non-POST methods still get `405`.
