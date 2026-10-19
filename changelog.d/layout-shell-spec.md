### Changed
- **Shell tuned to a measured teardown of the Claude desktop app** (claude.ai artifact "Claude 앱 레이아웃 실측", measured 2026-10-19; [docs/layout](docs/layout/README.md)):
  - **Sizes:** a 48 px bar (was 52). A 288 px sidebar (was 220) with a 0.5 px edge, 272 × 32 px view rows at 14 px, 24 px secondary rows at 13 px and 12 px section labels.
  - **Main column:** the pane has 8 px on the left, then a centred column of at most 808 px (960 on the 기기 tab); wider windows only grow the margins.
  - **Breakpoints:** the inspector is a column from 1200 px (288 + 8 + 808 + 300 fits at 1440) and a sheet below. The column loses its padding and inputs are 16 px under 768. The sidebar becomes a drawer under 704 (was 800). The phone layout at 640 and below is unchanged.
- **Warm neutral colour tokens** in style.css, light and dark: sidebar → main → raised surfaces get lighter in dark mode (`#111111` → `#151515` → `#20201F`), three text levels (`--text`, `--text-2`, `--text-3`), borders at 10% black or white, and fewer shadows. There is also a dense type scale, `--fs-1` … `--fs-5` (11–15 px). Portboard keeps its own accent and status colours.
- Mac app: `WindowChrome.barHeight` is 48, so the traffic lights are centred in the new bar; the 78 px inset and the bar's hit-testing are unchanged. The page and the app have to ship together for the lights to line up.
