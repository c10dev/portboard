# Public demo and landing page

**https://c10dev.github.io/portboard/**: a landing page, and under `app/` the real dashboard running in the browser
on example data. No server, no Tailscale, nothing to install. It is read-only: nothing a visitor clicks reaches a
server, because there is none.

The link works once GitHub Pages is turned on for the repository (below). Until then it answers 404.

## What it is

`npm run demo` (`scripts/demo.ts`) writes a static site to `demo/` (gitignored):

| Path | What |
|---|---|
| `index.html` | the landing page: the pitch, the README's screenshots, links to the demo, the install steps and the repo (`scripts/demo/landing.html`) |
| `images/` | the screenshots from `docs/images/` |
| `app/` | `public/` with every page expanded as the server would serve it: the shell markers filled (`src/core/shell.ts`), the features' scripts added, the text in English |
| `app/api/…json` | the answer to each `GET /api/…` the pages make |

Each page gets a small script first in `<head>` (`scripts/demo/shim.js`). It stands in for the server:

- `fetch('/api/ports?fresh')` reads `app/api/ports.json`. The path maps to a file with `apiFile()` in
  `scripts/demo.ts`; only the query keys that pick other data count (`detail`, `mode`, `port`, `timeframe`), so
  `/api/health?detail` is `api/health.detail.json` and `/api/audit?port=3000` is `api/audit.port-3000.json`. What has no
  file answers 404, as a missing feature would.
- Every timestamp in an answer moves forward by the time since the data was captured, so "used 3h ago" and the uptime
  bars look the same whenever the demo is opened.
- Every write (any method but GET) is answered in the browser with 403 "This is a read-only demo: nothing was
  changed", which the page shows as its usual error toast. Nothing is sent.
- A banner at the bottom says it is a demo with example data, with links to the landing page and the repo. Its text
  is English or Korean, after the page's language (Settings › Display › Language works as usual; Auto follows the
  browser). The banner's text lives in the shim, not in `public/i18n/`: it is not part of the dashboard.

## The data

Everything comes from files in the repo, never from the machine that builds it:

- `scripts/demo/data/api/`: one JSON file per answer, at the path the pages read. `ports.json`, `devices.json` and
  `usage.json` are the menu bar's fixtures (`menubar/fixtures/`, the example host `devbox` on `example.ts.net`) with
  the server's text in English and a pin, two alerts and the remote MCP server added, like the README's screenshots.
  The rest are written by hand in the same shapes the server returns.
- Computed at build time with the server's own functions, at the capture time (`ports.json`'s `at`): service groups
  (`src/core/groups.ts`), the network map (`src/core/nettree.ts`), a three-week usage history and the uptime of the
  watched ports (`exampleHistory()`, `exampleUptime()`), each port's service page (`src/core/detail.ts`) and its audit
  lines.

The server's own text in the answers (device names such as "This server", setup and health messages) stays English in
the Korean UI; the dashboard's text follows the language as usual.

To change what the demo shows, edit the files under `scripts/demo/data/api/` (keep the example names: `devbox`,
`example.ts.net`, `100.64.x.x`, `192.168.1.x`) and run `npm run demo`. `test/demo.test.ts` checks that every GET the
pages make on load has an answer.

## Keeping real data out

- **Example data only.** The build refuses to run unless the site config is the repo's `portboard.example.json`
  (`npm run demo` sets `PORTBOARD_SITE`) and resolves to `devbox.example.ts.net`, and the data describes that same
  host. A real install's `portboard.json`, or a `PORTBOARD_*` variable that moves the host or tailnet, stops it.
- **Scanned before it is written.** It builds into `demo.staging/`, runs `scripts/public-scan.mjs` over it (plus
  `private/denylist.txt` when there is one), and only then replaces `demo/`. A finding leaves the old `demo/` as it was
  and exits 1.

## Building and looking at it

```bash
npm run demo                              # → demo/
npx serve demo                            # or any static server: open /, and /app/ for the dashboard
node scripts/demo.ts --out /tmp/site      # elsewhere (PORTBOARD_SITE=portboard.example.json)
```

The site works under any path (GitHub Pages serves it at `/portboard/`): the pages use relative links, and the shim
catches their absolute `/api/…` calls wherever the site is.

## Publishing (GitHub Pages)

`.github/workflows/demo.yml` runs on every push to `main` and on demand (Actions › demo › Run workflow): it runs
`npm run demo` and deploys `demo/` with `actions/deploy-pages`. Only the deploy job may write to Pages.

Turn Pages on once: **Settings › Pages › Build and deployment › Source: GitHub Actions**. Then run the workflow (or push
to `main`). By default the `github-pages` environment that creates only accepts deploys from `main`.
