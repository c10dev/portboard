### Fixed
- The MCP tool `name_device` now also clears the device's 새 기기 mark, like 이름 붙이기 in the dashboard. It asks the running server (`POST /api/known-devices/ack`); `acknowledged` is null when the server can't be reached.
