# Contributing to Portboard

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Development

```bash
npm ci                # dev dependencies only: TypeScript and @types/node
npm test              # node --test, no network, no root, no Tailscale needed (in Korean: PORTBOARD_LOCALE=ko)
npm run test:en       # the same suite in English, minus the files that assert Korean wording
npm run typecheck
npm run typecheck:public   # public/ JS files that start with // @ts-check
PORTBOARD_PORT=8797 npm start   # a preview: its own state dir, alerts off (docs/setup.md#preview-instances)
```

**Languages in tests.** `npm test` runs in Korean. `npm run test:en` ([scripts/test-en.ts](scripts/test-en.ts)) runs
every test file in English except `KO_ONLY`, the files whose assertions are Korean wording throughout (digests, the
setup checklist, the UI's own strings). A test that checks a message picks the expected text with
`L(ko, en)` from `test/fixtures/locale.ts`, so both catalogs get checked; once a ko-only file does that everywhere,
take it off the list. `npm test` itself skips nothing.

**Type-checking the pages.** `tsconfig.json` covers `src` and `claude-plugin`. The page scripts in `public/` have
their own `tsconfig.public.json` (DOM types, `checkJs` off), and a file is checked once its first line is
`// @ts-check`. Every `public/lib` module is, except the few listed in `test/public-typecheck.test.ts`; add the pragma
to a file you touch when it passes, and fix types with JSDoc rather than changing behaviour.

Requirements: Node.js ≥ 22.18 (24 recommended), git, and Linux for running the server (`ss`, `/proc`). The tests run on
any Linux with Node and git, including a bare container; anything that shells out to `ss`, `tailscale`, `systemctl` or
`docker` copes with it missing.

The Mac app is a Swift package: `cd mac-app && swift test` (macOS, or the `swift` Docker image on Linux). CI has no
macOS job (runner cost), so run it yourself before sending a change under `mac-app/`.

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
- `npm test`, `npm run test:en`, `npm run typecheck` and `npm run typecheck:public` pass (CI runs all four).
- Describe what changed for the user and how you checked it, with a screenshot for UI changes (from a preview with
  example data, not your own machines).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
