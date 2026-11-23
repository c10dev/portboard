### Changed
- Plugin hooks read an optional `PORTBOARD_HOOK_TIMEOUT_MS` (1 to 10000) for their HTTP time limit, so tests that start a hook as a child process do not fail under load. The defaults (300 ms, 500 ms) stay.
