### Fixed
- The Proxmox and Windows port readers now say why they show no ports when their last good read is too old (`STALE_AFTER`, 15 min): "last good read 34m ago, reading again (0s)". Before, a process that sat idle (often the stdio MCP server) answered its first request with `ok: true`, an old `checkedAt` and no ports, which looked like a stopped reader.
