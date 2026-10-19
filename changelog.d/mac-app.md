### Added
- Portboard for Mac (`mac-app/`, [docs/mac-app/](docs/mac-app/README.md)): a native SwiftUI app, the successor of the SwiftBar plugin.
  - The dashboard in a window with native tabs (서비스 · 기기 · 개발 · 설정), 뒤로, 새로고침 and 브라우저에서 열기. Links that leave the dashboard open in the default browser, and the window size and position are remembered.
  - A menu bar item: `⇄ n` services in use, `↓` watched ports down, `⚠` devices to check, `🧹` cleanup candidates. The menu has services in use, pinned ports, devices, local-only services with tailnet 공개, and leftover servers.
  - macOS notifications when a watched port or device goes down or comes back, and when a new device appears. Deduped across restarts; off by default when ntfy already sends them.
  - Settings: server URL with 연결 확인 (`/api/whoami`), notification toggles, poll interval, 로그인할 때 열기.
  - Unreachable server (Tailscale off) is said in plain Korean with 다시 시도, never a blank page.
  - Built on the Mac with `mac-app/build.sh` (Swift package, Command Line Tools, ad-hoc signed; `--install` copies it to /Applications). The pure logic has XCTest tests on the plugin's fixtures (`swift test`, also in the Swift docker image on Linux).

### Changed
- 설정 체크리스트 (Mac 메뉴바): the Mac app's `User-Agent: portboard-mac/<version>` counts as installed, like the plugin's `portboard-menubar/1`; the item's next step is now building and installing the Mac app.
- Mac app, one bar: the window has no title bar or toolbar, like the Claude desktop app. The dashboard's header is the window's bar: traffic lights, an app-only ‹ 뒤로 (when there is history), the 서비스 · 기기 · 개발 · 설정 tabs and every control on one 52 px row; narrower than 1280 px the controls wrap inside the bar. The empty parts of the header move the window, and a double-click zooms or minimizes as the system setting says. Tabs, 뒤로, 새로고침 and 브라우저에서 열기 stay in the 대시보드 menu (⌘1–⌘4, ⌘[, ⌘R, ⇧⌘O). Browser and phone layouts are unchanged. Rebuild the app (`mac-app/build.sh --install`) to get it.

### Fixed
- Mac app: clicking the one bar crashed the app (`-[NSEvent clickCount]` on a non-mouse event). A drag was sent as a script message, which reaches the app over IPC after the click. Now the page reports where the header and its controls are, and the app's mouse-down monitor drags on empty bar space with the real event (double-click as the system setting says). Rebuild the app.

### Docs
- The SwiftBar menu bar plugin (`menubar/`, docs/menubar/) is marked legacy; it is kept for now.
- Wide windows (the Mac app, a desktop browser at 900 px or more): every device card is shown, wrapping onto a second row instead of being cut off at the right edge; 상세 sits under the port number, so a closed row is about 25% shorter; past 1280 px the list uses up to 1400 px instead of 1100.
