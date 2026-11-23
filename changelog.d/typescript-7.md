### Changed
- The dev dependency `typescript` is now 7.0.2, the compiler that is written in Go. `npm run typecheck` takes about 3 s instead of about 13 s on a Linux x64 host. The runtime does not change: Node still strips the types, and the published `dist/` differs from a TypeScript 5.9 build only in the quote style of import paths.
