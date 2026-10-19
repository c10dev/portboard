### Fixed
- **No flash on a tab click** ([docs/layout](docs/layout/README.md#no-flash-on-a-tab-click)). Before, every tab click first painted the page's unstyled HTML (an underlined Portboard link, the old nav, the placeholder sections), then the module-built shell, then the data shifting things again.
  - **Shell markup from the server:** `src/core/shell.ts` expands `<!--#shell:…-->` markers into each page as it is served, so the first paint has the final bar, sidebar and inspector. `lib/shell.js` only wires them.
  - **Boot before the first paint:** `lib/shell-boot.js`, inlined into `<head>`, applies the remembered toggles, app mode and read-only before anything paints, and paints the last sidebar (counts, 고정, 기기, footer chips; `localStorage` `pb.nav`).
  - **Main content waits in place:** it stays invisible but takes its space (`data-wait`) until it has rendered, with a 2.5 s CSS fallback.
  - **View transitions:** cross-document view transitions keep the bar and sidebar still while the main area cross-fades. This is progressive enhancement and is off with reduced motion.

### Changed
- The filter popover is a button and a panel instead of a `<details>`, so the phone's inline filters need no script. 설정 n/m and 수집 정상 now show in the sidebar footer on every page.
- `docs/frontend-modules/serve-static.mjs` expands the shell markers too. `docs/layout/filmstrip.mjs` records the navigation filmstrips.
