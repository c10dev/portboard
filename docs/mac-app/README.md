# Portboard for Mac

A native macOS app (SwiftUI, no Electron) for Portboard. It replaces the [SwiftBar plugin](../menubar/README.md) as the way to use Portboard on the Mac:

- **Window**: the dashboard (`https://devbox.example.ts.net:8443`) in a web view with no title bar. The dashboard's header is the window's one bar: traffic lights, then the tabs (서비스 · 기기 · 개발 · 설정) and every control on a single row. 뒤로, 새로고침 and 브라우저에서 열기 are in the 대시보드 menu.
- **Menu bar**: services in use, pinned ports, devices, local-only services with **tailnet 공개**, and leftover dev servers.
- **Notifications**: a watched (🔔) port or device goes down or comes back, and a new device appears. None for the port whose page you are looking at; the Dock badge counts watched ports that are down.
- **Settings**: server URL and 연결 확인, notification toggles, poll interval, 로그인할 때 열기.

Source: [`mac-app/`](../../mac-app/). It is a Swift package with no Xcode project. [`build.sh`](../../mac-app/build.sh) builds `Portboard.app`.

## Build and install (on the Mac)

Needs macOS 14 (Sonoma) or newer and Swift 5.9 or newer. The Command Line Tools are enough to build the app:

```bash
xcode-select --install
```

Get the source onto the Mac. It is the main checkout on devbox; password-less SSH as for `mac-setup.sh`. Then build and install:

```bash
rsync -a --exclude node_modules --exclude .git dev@devbox.example.ts.net:projects/portboard/ ~/portboard/
cd ~/portboard/mac-app && ./build.sh --install
```

- `./build.sh` runs `swift build -c release` and assembles `mac-app/build/Portboard.app`. The bundle gets:
  - an `Info.plist`: bundle id `io.github.c10dev.portboard`, version from `package.json`, build number from `git rev-list --count HEAD` or the date, `LSApplicationCategoryType` developer-tools, `LSMinimumSystemVersion` 14.0. `NSAppTransportSecurity` stays at the defaults, since the dashboard is https.
  - an icon: [`Resources/AppIcon.png`](../../mac-app/Resources/AppIcon.png) turned into `AppIcon.icns` with `sips` and `iconutil`.
  - an ad-hoc signature (`codesign --sign -`).
- `./build.sh --install` also quits a running Portboard, copies the app to `/Applications` and opens it.
- `PORTBOARD_VERSION=1.2.3 ./build.sh` overrides the version, for example when only `mac-app/` was copied and there is no `package.json` next to it.

The 설정 체크리스트's **Mac 메뉴바** item offers the same command as one line. To update the app later, run it again.

### Tests

The pure logic (`PortboardCore`) has XCTest tests against the SwiftBar plugin's fixtures ([`menubar/fixtures/`](../../menubar/fixtures/)):

```bash
cd ~/portboard/mac-app && swift test
```

`swift test` needs XCTest. Some Command Line Tools versions lack it. If it fails with `no such module 'XCTest'`, install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`. On devbox the same tests run without a Mac, in the Swift docker image. The macOS app target is left out on Linux:

```bash
docker run --rm -v "$PWD:/src:ro" -w /src/mac-app swift:6.3.3-noble swift test --scratch-path /tmp/.build
```

Run it from the repository root. The fixtures are read from `../menubar/fixtures`.

## First launch

**Built on this Mac** (`./build.sh`): the app opens normally. Gatekeeper only checks apps that carry the quarantine flag, and a local build has none.

**Copied from elsewhere** (AirDrop, a download, a zip): the app is unsigned (ad hoc), so macOS refuses to open it at first.

- macOS 14: right-click `Portboard.app` → **열기** → **열기**.
- macOS 15 and newer: open it once, then 시스템 설정 → 개인정보 보호 및 보안 → **그래도 열기**.

Or remove the flag:

```bash
xattr -dr com.apple.quarantine /Applications/Portboard.app
```

On the first poll the app decides the notification default and may ask for notification permission (see below).

## What each part does

### Window

- **Web view.** It shows the dashboard at the configured server URL, under a hidden title bar (see [One bar](#one-bar)). The 대시보드 menu has the tabs on ⌘1 to ⌘4, 뒤로 ⌘, 새로고침 ⌘R and 브라우저에서 열기 ⇧⌘O. 설정 is the dashboard's own `settings.html` tab (server settings and the checklist). The app's own settings are ⌘, (below).
- **Links.** A link that leaves the dashboard opens in the default browser. "Leaves" means another host or port: an opened service, the docs on GitHub, `target=_blank`. Dashboard pages stay in the window.
- **Dialogs.** The dashboard asks with `confirm()`/`prompt()` before stopping, exposing and naming. The app shows these as native dialogs; a bare WKWebView would silently answer "취소".
- **Writes.** They work as in Safari. Through `tailscale serve` the server sees the Mac's Tailscale login and device, and the Mac is on the `writeDevices` allowlist ([security.md](../security.md)).
- **Window frame.** Size and position are remembered (`NSWindow` frame autosave).
- **Closing.** Closing the window keeps the app running in the menu bar. The Dock icon or **대시보드 열기** brings the window back.
- **Errors.** When the page cannot load, the window says so in Korean instead of showing a blank page. Examples: `서버 주소를 찾지 못했어요 (Tailscale이 꺼져 있나요?)`, `8초 안에 응답이 없어요`, or `Portboard 서버가 응답하지 않아요 (HTTP 502)` when tailscale serve answers but Portboard is down. A hint to check Tailscale and the server URL follows, with **다시 시도** and **서버 주소 바꾸기…**.
- **Automatic retry.** After sleep or a Tailscale reconnect the first load often fails, so the window tries again on its own, like the Claude desktop app (`PortboardCore/Retry.swift`, `LoadRetry`):
  - at once, then after 15 s, then every 30 s, each ±20 % so it doesn't land in step with anything, for 3 minutes from the first failure. After that only a trigger below tries again.
  - at once when the window becomes key, the Mac wakes from sleep (`NSWorkspace.didWakeNotification`) or the screen is unlocked (`com.apple.screenIsUnlocked`), at most every 10 s. Each of these starts a new 3 minutes.
  - **다시 시도** tries at once and starts a new 3 minutes too.
  - The error screen says `자동으로 다시 시도하는 중… 다음 시도 14:03:12 (12초 후)`, and `다시 연결하는 중…` with a spinner while a try loads. The error stays up during a try instead of flashing a blank page. When the 3 minutes are over it says so and leaves 다시 시도.
  - A load that fails with an HTTP 5xx (Portboard down behind tailscale serve) or a network error is retried. Nothing else is (a cancelled load, a link sent to the browser).
- **Page crashes.** When WebKit's page process dies (`webViewWebContentProcessDidTerminate`), the page is reloaded, at most 3 times in 5 minutes (`CrashReloads`). After that the window shows `대시보드 페이지가 5분 안에 3번 멈춰서 더 다시 불러오지 않았어요` with 다시 시도, and no automatic tries until you press it.

### Menu bar

The native successor of `menubar/format.mjs`. The rules are the same and are tested on the same fixtures.

**Title**: an icon and counts.

| Shows | Meaning |
|---|---|
| `⇄ 3` | services in use now: ports in the dashboard's default view that a device is connected to (`/api/usage` `byPort`). `?` while `/api/usage` fails |
| `↓1` | watched (🔔) ports that are down (`/api/alerts` `watching[]`, `down`) |
| `⚠2` | devices to check: compute-pool hosts in `degraded`, `wsl-down`, `host-down` or `auth`, plus watched devices that are offline. Counted once per device. `agent-busy` (the Mac in use) is normal and never counts |
| `🧹1` | leftover dev servers, the cleanup candidates of `/api/owners` |
| `⚠` alone | something else to look at: a pinned port not listening, or an endpoint that failed |
| Wi-Fi icon with `!`, no text | `/api/ports` cannot be read: the menu says why |

**Menu**:

1. The warnings. Each one opens the page in the window: `service.html#<port>`, or the device in the 기기 tab.
2. **사용 중 서비스**: each with who is using it. Its submenu has **열기 ↗** (the served or direct http URL, in the browser) and 서비스 상세 보기.
3. **고정한 포트**: state (tailnet HTTPS, local only, 리스닝, 리스닝 없음), with **열기 ↗**.
4. **기기**: status dot, online or offline or pool state, CPU and memory. The submenu lists the services the device uses, then 기기 탭에서 보기.
5. **local only 서비스**: **tailnet 공개** posts `/api/ports/<port>/expose` with `X-Portboard: 1`. The result is shown at the top of the menu for a minute; a refusal is shown in a dialog, with the Tailscale link when Serve has to be turned on first. Also: the reason it can't be exposed, SSH 터널 명령 복사, 서비스 상세 보기.
6. **정리할 수 있는 서버**: name, port and why it is a candidate. A click opens the 서비스 tab, which has the 정리 banner. The menu itself never stops anything.
7. 대시보드 열기, 브라우저에서 열기, 새로고침 (⌘R), last update time, Portboard 앱 설정… (⌘,), 종료.

When the server cannot be read, the menu shows **Portboard 연결 안 됨**, the reason, the Tailscale hint and **다시 시도**.

**Polling.** Each poll reads `/api/ports`, `/api/usage`, `/api/devices`, `/api/alerts` and `/api/owners` in parallel, with an 8 s timeout. It polls every 30 s while the app is in front or a menu is open, and every 2 min otherwise; both intervals can be changed in settings. Opening the menu refreshes at once if the data is older than the short interval. `/api/ports` is required. The others only add detail, and a failure of one becomes a ⚠ line. These reads are bounded on the server (shared 2 s cache, [api.md](../api.md) **Load bounds**).

The app sends `User-Agent: portboard-mac/<version>`. The 설정 체크리스트's **Mac 메뉴바** item counts it as installed, like the plugin's `portboard-menubar/1`.

### Notifications

macOS notifications, through UserNotifications:

- **🔔 down / ✅ back.** A watched port stops answering, or a watched device goes offline; then it comes back. Down and back share one id, so the recovery banner replaces the down one. A click opens the service page or the device.
- **새 기기.** A device appears in `/api/usage` `newDevices.pending` for the first time. A click opens it in the 기기 tab.

**Where you are.** The rules are in `Notify` (`PortboardCore/Notify.swift`) and tested:

- **Not for the page in front.** No banner for a port whose `service.html#<port>` is in the window while it is key and the app is active. Its earlier banner (the 다운 one, when it comes back) is taken out of Notification Center. The state is still saved, so the banner doesn't come later when you leave the page.
- **Levels.** 다운 is `.timeSensitive`, 복구 `.passive` (quietly: no sound, the screen stays dark), 새 기기 `.active`. Time-sensitive needs the `com.apple.developer.usernotifications.time-sensitive` entitlement, which needs a provisioning profile. The ad-hoc build has none, so macOS may show 다운 as an ordinary notification and hold it during a Focus.
- **Threads.** One `threadIdentifier` per watched port or device (`watch-port:3000`, `watch-device:…`), one for all new devices, so Notification Center groups them that way.
- **Dock badge.** The number of watched (🔔) ports that are down, the one thing that waits on you (the menu bar's `↓` count). Nothing else counts, and the badge is empty at 0. It is set after every poll, whatever the toggles say. When `/api/alerts` fails the last count stays.

**Dedupe.** What was last seen (the keys of watched items that are down, the pending new devices) is kept in the app's defaults:

- Restarting the app does not notify again.
- The very first poll only records.
- A poll where `/api/alerts` or `/api/usage` failed changes nothing.
- Turning a toggle on later does not replay old changes.

**Default.** On the first answer from `/api/alerts`, the app turns both toggles **off when the server's ntfy channel is set up**, since ntfy already sends the same alerts to the phone, and on otherwise. The settings window explains this in one line. The decision is made once; after that the toggles are yours.

Notifications only work from `Portboard.app`. The bare binary from `swift run` has no bundle, so it skips them, and the login item too.

### Settings (⌘,)

- **서버**: the dashboard URL. `https://` is added when no scheme is given; 적용 reloads the window and the menu.
- **연결 확인**: calls `/api/whoami` and shows the login, the device (name and Tailscale address) and whether this Mac can write (with the reason when it can't). Through the `:8443` address the Mac should show as the owner with 쓰기 가능. The plain `http://…:8790` address is read-only.
- **알림**: the two toggles, the macOS permission state, and a button to the system notification settings.
- **갱신 주기**: the interval while in front or with the menu open (15 s to 2 min, default 30 s), and in the background (1 to 10 min, default 2 min).
- **로그인할 때 Portboard 열기**: `SMAppService.mainApp`. If macOS wants approval, a button opens 시스템 설정 → 로그인 항목.

## Code

| Path | Role |
|---|---|
| [`mac-app/Package.swift`](../../mac-app/Package.swift) | Swift package (tools 5.9, macOS 14). The app target is only declared on macOS, so `swift test` works on Linux |
| [`Sources/PortboardCore/`](../../mac-app/Sources/PortboardCore/) | Pure logic, Foundation only. `JSON.swift`: lenient JSON. `Models.swift`: typed views of the API documents. `Summary.swift`: menu rows, warnings and title, ported from format.mjs. `Notify.swift`: notification dedupe, texts, levels, threads, the page-in-front rule and the Dock badge. `Retry.swift`: the window's automatic retry schedule and the crash-reload limit. `Server.swift`: URLs, tabs, Korean error texts, poll intervals. `Chrome.swift`: the bar's numbers (48 px, 78 px clear), the page's bar report and its hit-testing, the double-click setting. `Format.swift`: text helpers |
| [`Tests/PortboardCoreTests/`](../../mac-app/Tests/PortboardCoreTests/) | XCTest. The cases of `test/menubar.test.ts` on the same fixtures, plus dedupe, URLs, errors, models, the retry schedule and the notification rules |
| [`Sources/Portboard/`](../../mac-app/Sources/Portboard/) | The app. `PortboardApp.swift`: scenes, commands, app delegate. `AppModel.swift`: polling, notifications, tailnet 공개. `APIClient.swift`. `MenuBar.swift`. `WebView.swift`: WKWebView, link policy, JS dialogs. `MainWindow.swift`: the window with no title bar (traffic lights, drag, double-click, frame autosave), error view. `SettingsView.swift`. `Notifier.swift`. `LoginItem.swift`. `AppInfo.swift`: version, User-Agent, settings keys |
| [`mac-app/build.sh`](../../mac-app/build.sh) | Release build, bundle, icon, Info.plist, ad-hoc signature, `--install` |
| [`mac-app/scripts/render-icon.py`](../../mac-app/scripts/render-icon.py) | Renders `public/icon.svg` to `Resources/AppIcon.png` (1024 px, Apple's icon grid). There is no SVG tool on the server and `sips` can't read SVG. Re-run it after changing the icon |

**Reading the API.** The app reads every field defensively, like the plugin. Responses decode into a `JSON` value, and models read what they need from it. A missing key, an added key or a changed type reads as "not there", so a newer or older server never breaks the menu. This is tested with the same odd documents as the plugin.

## Relation to the SwiftBar plugin

The plugin (`menubar/`, [docs/menubar/](../menubar/README.md)) is **legacy**. It stays in the repository and keeps working, but the Mac app is the supported way.

- The app's menu shows what the plugin did, and more: watched ports down, cleanup candidates, notifications, the dashboard in a window, settings.
- Both send a User-Agent the checklist recognises.
- Use one or the other. To remove the plugin, delete its link in SwiftBar's plugin folder and `~/Library/Application Support/portboard-menubar/`, and quit SwiftBar if nothing else uses it.

## One bar

The window has no title bar and no toolbar, like the Claude desktop app. The dashboard's own header is the window's bar: the traffic lights, then 뒤로 (when there is history), the tabs, and the page's controls, all on one row.

**Page side.** [`public/lib/macapp.js`](../../public/lib/macapp.js) and `style.css` `[data-app="mac"]`, on every page.

- The web view's User-Agent carries `portboard-mac/<version>`, so the page sets `<html data-app="mac">`.
- The header is 48 px tall, with 78 px on the left kept clear for the traffic lights. The first row is centred on the lights.
- The page's tabs show; the Portboard logo, title and host text are hidden.
- A small ‹ 뒤로 button shows only when the app says there is history (`data-can-go-back`).
- From 1280 px everything is on one row. Narrower, the controls wrap onto a second row inside the same bar, still clear of the lights.
- In full screen there are no traffic lights, so the inset goes (`data-fullscreen`).
- The browser and phone layouts don't change: every new rule is scoped to `[data-app="mac"]`, and `test/macapp.test.ts` checks that.

**App side.** `MainWindow.swift`, `WebView.swift`, `PortboardCore/Chrome.swift`.

- The window uses `.windowStyle(.hiddenTitleBar)`: transparent title bar, full-size content view, no title.
- The traffic lights start 16 px from the left and are centred in the 48 px bar. They are placed again after every resize and full-screen change, because AppKit lays the title bar out again.
- **Moving the window.** WKWebView ignores CSS `app-region`.
  - The page tells the app where things are. It posts `{type: 'bar', bar, noDrag: [...]}` to the `portboard` message handler: the header's rect and the rects of its controls (links and tabs, buttons and chips, fields, labels), in CSS px relative to the viewport. It sends this on load and again whenever they move (resize, ResizeObserver, MutationObserver, `pageshow`), at most once per frame and only when something changed.
  - The app watches the window's left mouse-downs with a local event monitor. Only clicks that would reach the web view count: not the traffic lights, not the error screen. It converts each point to CSS px (flipped y, page zoom) and hit-tests it against the last report.
  - On empty bar space, the app calls `performDrag(with:)` with that real mouse-down, or on a double-click zooms, minimizes or does nothing, as 시스템 설정 → 데스크탑 및 Dock → "윈도우 제목 막대를 이중 클릭하여" says. The page doesn't get that click. Anywhere else the click goes to the page unchanged.
  - Script messages arrive asynchronously over WebKit IPC, after the click has been handled. That's why the click itself is never sent as a message. The first one-bar build did that and crashed reading `clickCount` from `NSApp.currentEvent`.
- Only the dashboard's own main frame is listened to.
- When the page can't load, the error screen has its own drag strip where the bar would be.

## Layout in the app

From 900 px wide, device cards wrap instead of being cut off, and 상세 sits under the port number.
