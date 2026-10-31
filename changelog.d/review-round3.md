### Fixed
- Reservations: a `reservations.json` that cannot be read or parsed is an error now, not an empty list. Before, `free_port` offered reserved ports and the next `reserve_port` replaced the file with one reservation.
