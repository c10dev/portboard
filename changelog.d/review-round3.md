### Fixed
- Reservations: a `reservations.json` that cannot be read or parsed is an error now, not an empty list. Before, `free_port` offered reserved ports and the next `reserve_port` replaced the file with one reservation.
- Reservations: two `reserve_port` calls without a port at the same time get two different ports. Before, both picked the same port and the second call failed with "is reserved for".
- Remote MCP: the last scrub over every string also hides macOS paths (`/Users/<name>/…`, `/private/…`, `/Volumes/…`), as it hides `/home/<name>/…`.
- `GET /api/free-ports`: a `count` or `preferred` that is not an integer in range is 400, as for `free_port`. Before, `count=abc` gave an empty list and `count=1.5` gave two ports.

### Changed
- Service logs (`GET /api/ports/:port/logs`) are the machine owner's only, as the audit log is. Other callers get `403 owner only`.
