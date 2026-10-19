# Contributing to Portboard

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Development

```bash
npm ci                # dev dependencies only: TypeScript and @types/node
npm test              # node --test, no network, no root, no Tailscale needed
npm run typecheck
PORTBOARD_PORT=8797 npm start   # a preview: its own state dir, alerts off (docs/setup.md#preview-instances)
```

Requirements: Node.js ≥ 22.18 (24 recommended), git, and Linux for running the server (`ss`, `/proc`). The tests run on
any Linux with Node and git, including a bare container; anything that shells out to `ss`, `tailscale`, `systemctl` or
`docker` copes with it missing.

The Mac app is a Swift package: `cd mac-app && swift test` (macOS, or the `swift` Docker image on Linux).

## Rules of the codebase

- **Zero runtime dependencies.** Only Node's standard library at runtime. Don't add packages to `dependencies`.
- **One feature, one module.** Features register their routes, MCP tools and pages in the registry
  ([docs/architecture.md](docs/architecture.md)). Don't edit `src/server.ts` or `src/mcp.ts` to add a feature.
  In `src/features/registry.ts` the new import and `MODULES` line go in alphabetical order, not at the end; the
  module's `order` number sets its place in `tools/list`.
- **Writes are guarded.** A new POST route is declared a write so it gets the CSRF and owner checks and an audit line
  ([docs/security.md](docs/security.md)). The remote MCP server stays read-only.
- **Nothing machine-specific in code.** Host names, tailnets, paths and addresses come from the machine or
  `portboard.json` ([docs/config.md](docs/config.md)). Use example names (`devbox`, `example.ts.net`,
  `192.168.1.x`, `100.64.x.x`) in tests and docs, and never real tokens.
- **Tests with the change.** Every behaviour change comes with a test under `test/`.
- **Docs with the change.** Feature details go in `docs/<topic>.md`, not the README.
- **Changelog.** Don't edit `CHANGELOG.md`; add `changelog.d/<issue or topic>.md` ([format](changelog.d/README.md)).
  Parallel branches each add their own file, so they never conflict there. `npm run changelog -- <version>` folds them
  at release time.

## Pull requests

- One topic per pull request, on its own branch.
- `npm test` and `npm run typecheck` pass (CI runs both).
- Describe what changed for the user and how you checked it, with a screenshot for UI changes (from a preview with
  example data, not your own machines).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
