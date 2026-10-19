import AppKit
import PortboardCore
import SwiftUI

/// The dashboard window. It has no title bar: the dashboard's own header is the one bar (traffic lights at its left,
/// public/lib/macapp.js and style.css [data-app="mac"]), and the tabs, 뒤로, 새로고침 and 브라우저에서 열기 are in
/// the 대시보드 menu with ⌘1–⌘4, ⌘[, ⌘R and ⇧⌘O. When the page cannot load, a plain Korean error with 다시 시도.
struct MainWindow: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var web: WebController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ZStack {
            DashboardWebView(controller: web)
            if let error = web.loadError {
                ConnectionErrorView(message: error, base: model.base, nextRetry: web.nextRetry, trying: web.autoTry, retry: { web.reload() })
                    // no page header to drag by: a strip where the bar would be
                    .overlay(alignment: .top) { TitleBarDragArea().frame(height: WindowChrome.barHeight) }
            }
        }
        .ignoresSafeArea()
        .frame(minWidth: 720, minHeight: 480)
        .background(WindowChromeView(autosaveName: "PortboardMainWindow", web: web))
        .onAppear {
            web.loadIfNeeded()
            // normally set by the menu bar label; this covers a label that never appeared
            if model.openMainWindow == nil { model.openMainWindow = { openWindow(id: PortboardApp.mainWindowID) } }
        }
    }
}

/// Shown over the web view when the dashboard cannot be read, with when the next automatic try is (WebController)
struct ConnectionErrorView: View {
    let message: String
    let base: URL
    let nextRetry: Date?
    let trying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("Portboard에 연결할 수 없어요")
                .font(.title2.weight(.semibold))
            Text(message)
                .multilineTextAlignment(.center)
            Text(Problem.hint(base: base))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            // a countdown, redrawn every second
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 6) {
                    if trying { ProgressView().controlSize(.small) }
                    Text(trying ? "다시 연결하는 중…" : LoadRetry.status(next: nextRetry, now: context.date))
                        .monospacedDigit()
                }
                .font(.callout)
                .foregroundStyle(.secondary)
            }
            HStack {
                Button("다시 시도", action: retry)
                    .keyboardShortcut(.defaultAction)
                SettingsLink { Text("서버 주소 바꾸기…") }
            }
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

/// Sets up the window behind the dashboard: no title or title bar background, content under the traffic lights, the
/// traffic lights centred in the 48 px bar (re-done after every resize and full screen change, since AppKit lays the
/// title bar out again), size and position remembered (frame autosave), and full screen passed on to the page.
struct WindowChromeView: NSViewRepresentable {
    let autosaveName: String
    let web: WebController

    func makeNSView(context: Context) -> NSView { ChromeView(autosaveName: autosaveName, web: web) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class ChromeView: NSView {
        let autosaveName: String
        weak var web: WebController?
        private var observers: [NSObjectProtocol] = []
        private var mouseMonitor: Any?

        init(autosaveName: String, web: WebController) {
            self.autosaveName = autosaveName
            self.web = web
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { return nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // moved to another window, or out of one (then window is nil): drop the old observers
            for o in observers { NotificationCenter.default.removeObserver(o) }
            observers = []
            if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
            mouseMonitor = nil
            guard let window else { return }
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.styleMask.insert(.fullSizeContentView)
            window.isMovableByWindowBackground = false
            if window.frameAutosaveName != autosaveName {
                // restores a saved frame, then saves every later move and resize
                window.setFrameUsingName(autosaveName)
                window.setFrameAutosaveName(autosaveName)
            }
            TitleBar.placeTrafficLights(window)
            let names: [Notification.Name] = [
                NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification,
                NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
                NSWindow.didBecomeKeyNotification,
            ]
            for name in names {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.windowChanged() }
                })
            }
            // Focus: while the page can't load, try again at once (WebController, at most every 10 s)
            observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.web?.windowBecameKey() }
            })
            windowChanged()
            // The bar's empty space moves the window. A local monitor sees the mouse-down before the web view does,
            // so performDrag gets the real event while it is being handled.
            mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                let consumed = MainActor.assumeIsolated { self?.handleMouseDown(event) ?? false }
                return consumed ? nil : event
            }
        }

        /// true when the click was on empty bar space and became a window drag (or a double-click action)
        private func handleMouseDown(_ event: NSEvent) -> Bool {
            guard let window, event.window === window,
                  let web, web.loadError == nil, let regions = web.barRegions else { return false }
            let webView = web.webView
            // Only clicks that would reach the web view: not the traffic lights, not the error screen
            guard let hit = window.contentView?.superview?.hitTest(event.locationInWindow),
                  hit === webView || hit.isDescendant(of: webView) else { return false }
            let p = webView.convert(event.locationInWindow, from: nil)
            let css = WindowChrome.cssPoint(
                x: Double(p.x), y: Double(p.y), viewHeight: Double(webView.bounds.height),
                flipped: webView.isFlipped, scale: Double(webView.magnification * webView.pageZoom)
            )
            guard regions.hit(x: css.x, y: css.y) == .drag else { return false }
            if event.clickCount >= 2 { TitleBar.doubleClick(window) } else { TitleBar.drag(window, with: event) }
            return true
        }

        private func windowChanged() {
            guard let window else { return }
            TitleBar.placeTrafficLights(window)
            web?.setFullScreen(window.styleMask.contains(.fullScreen))
        }
    }
}

/// The title bar the window no longer shows: where the traffic lights go, and what dragging and double-clicking do
enum TitleBar {
    /// Centres close, minimize and zoom in the 48 px bar, starting 16 px from the left (WindowChrome). Public AppKit
    /// only: the buttons' container is made as tall as the bar and the buttons are moved inside it.
    static func placeTrafficLights(_ window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let titlebar = close.superview,
              let container = titlebar.superview else { return }
        let barHeight = CGFloat(WindowChrome.barHeight)
        var rect = container.frame
        if rect.height != barHeight || rect.origin.y != window.frame.height - barHeight {
            rect.size.height = barHeight
            rect.origin.y = window.frame.height - barHeight
            container.frame = rect
        }
        let measured = mini.frame.minX - close.frame.minX
        let step = measured > 0 ? measured : CGFloat(WindowChrome.defaultStep)
        let y = CGFloat(WindowChrome.lightsY(containerHeight: Double(titlebar.bounds.height), buttonHeight: Double(close.frame.height)))
        for (i, button) in [close, mini, zoom].enumerated() {
            button.setFrameOrigin(NSPoint(x: CGFloat(WindowChrome.lightsX) + CGFloat(i) * step, y: y))
        }
    }

    /// Starts moving the window; `event` must be the left mouse-down being handled right now
    static func drag(_ window: NSWindow, with event: NSEvent) {
        window.performDrag(with: event)
    }

    /// A double-click on the bar: zoom, minimize or nothing, as 시스템 설정 → 데스크탑 및 Dock says
    static func doubleClick(_ window: NSWindow) {
        let d = UserDefaults.standard
        switch WindowChrome.DoubleClick(action: d.string(forKey: "AppleActionOnDoubleClick"), legacyMinimize: d.bool(forKey: "AppleMiniaturizeOnDoubleClick")) {
        case .zoom: window.performZoom(nil)
        case .minimize: window.performMiniaturize(nil)
        case .none: break
        }
    }
}

/// An empty strip that moves the window (over the error screen, where there is no page header)
struct TitleBarDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount >= 2 { TitleBar.doubleClick(window) } else { TitleBar.drag(window, with: event) }
        }
    }
}
