import AppKit
import Combine
import PortboardCore
import SwiftUI
import WebKit

/// The dashboard in a WKWebView. One instance for the app's life, so closing and reopening the window keeps the page.
///
/// - Links that leave the dashboard host (an opened service, docs on GitHub, target=_blank) go to the default browser.
/// - The dashboard asks before stopping or exposing with window.confirm/prompt; WKWebView answers those with
///   false/null unless the app shows them, so they become NSAlerts here.
/// - A page that cannot load (Tailscale off, server down) sets `loadError` and the window shows it instead of a
///   blank page. It is tried again on its own (LoadRetry: at once, 15 s, then every 30 s for 3 minutes) and at once
///   on window focus, wake from sleep and screen unlock. The error stays up during automatic tries, so it doesn't
///   flash.
/// - A dead web content process is reloaded, at most 3 times in 5 minutes (CrashReloads).
/// - The window has no title bar, so the page header moves it: lib/macapp.js reports where the header and its controls
///   are (`barRegions`), and the window's mouse-down monitor (MainWindow.swift) drags on empty bar space. The page is
///   told whether 뒤로 can go back and whether the window is full screen.
@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published private(set) var canGoBack = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    /// The next automatic try; nil when none is planned (the page loads fine, or the 3 minutes are over)
    @Published private(set) var nextRetry: Date?
    /// A try (automatic or 다시 시도) is loading: the error stays up until it answers
    @Published private(set) var autoTry = false

    private let base: () -> URL
    private var lastRequested: URL?
    private var fullScreen = false
    /// The page header's last reported layout (CSS px); nil until the current page reports it
    private(set) var barRegions: WindowChrome.BarRegions?
    private var bag: Set<AnyCancellable> = []
    private var retry = LoadRetry()
    private var retryTask: Task<Void, Never>?
    /// The current main-frame answer was 5xx (loadError is set even though the page commits)
    private var httpFailed = false
    private var crashes = CrashReloads()
    /// The page died too often: no automatic tries until 다시 시도
    private var crashedOut = false
    /// Lives as long as the app, like this controller
    private var observers: [NSObjectProtocol] = []

    init(base: @escaping () -> URL = { AppInfo.serverBase }) {
        self.base = base
        let config = WKWebViewConfiguration()
        // Appended to Safari's User-Agent, so the page still sees a normal browser
        config.applicationNameForUserAgent = AppInfo.userAgent
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true // Safari → 개발자용 → Portboard, for debugging the page
        webView.configuration.userContentController.add(PageMessages(self), name: "portboard")
        webView.publisher(for: \.canGoBack).sink { [weak self] in
            self?.canGoBack = $0
            self?.syncPageState()
        }.store(in: &bag)
        webView.publisher(for: \.isLoading).sink { [weak self] in self?.isLoading = $0 }.store(in: &bag)
        // Wake from sleep and screen unlock: the network is often back, so try at once (window focus: windowBecameKey)
        let wake = NSWorkspace.shared.notificationCenter
        observers.append(wake.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tryNow() }
        })
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tryNow() }
        })
    }

    var home: URL { Server.url(base(), "") }

    // MARK: the window's bar (the page header)

    /// Tells the page what only the app knows: the app-only back button and the full-screen layout depend on it
    func syncPageState() {
        webView.evaluateJavaScript(WindowChrome.pageStateScript(canGoBack: webView.canGoBack, fullScreen: fullScreen), completionHandler: nil)
    }

    func setFullScreen(_ on: Bool) {
        guard on != fullScreen else { return }
        fullScreen = on
        syncPageState()
    }

    /// From lib/macapp.js: where the header and its controls are, sent on load and whenever they move. Only the
    /// dashboard's own main frame is listened to; other message types are ignored. Nothing here acts on a click:
    /// messages arrive later over IPC, so the click itself is handled by the window's mouse-down monitor.
    fileprivate func received(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url ?? webView.url, Server.isDashboard(url, base: base()),
              let regions = WindowChrome.BarRegions(body: message.body) else { return }
        barRegions = regions
    }

    /// The first time the window shows
    func loadIfNeeded() {
        if webView.url == nil && lastRequested == nil { load("") }
    }

    /// A dashboard path relative to the server URL ("", "devices.html#mac", "service.html#3000")
    func load(_ path: String) {
        load(url: Server.url(base(), path))
    }

    func load(url: URL) {
        lastRequested = url
        loadError = nil
        cancelRetry()
        // a page you asked for: if it fails, a new 3 minutes of automatic tries
        retry = LoadRetry()
        crashedOut = false
        webView.load(URLRequest(url: url))
    }

    func open(_ tab: DashboardTab) { load(tab.path) }

    func goBack() { webView.goBack() }

    /// The port whose service.html page is in front: the window is key in the active app and the page loaded
    func viewingPort() -> Int? {
        let key = NSApp.isActive && webView.window?.isKeyWindow == true && loadError == nil
        return Notify.viewingPort(page: webView.url, base: base(), keyWindow: key)
    }

    /// 새로고침, or 다시 시도 after an error (the page that failed, else the dashboard's first page). 다시 시도 starts
    /// a new 3 minutes of automatic tries.
    func reload() {
        if loadError != nil {
            _ = retry.nudge(at: Date(), byHand: true)
            crashedOut = false
            startAutoTry()
        } else if webView.url == nil {
            load(url: lastRequested ?? home)
        } else {
            webView.reload()
        }
    }

    // MARK: automatic retry

    /// The window became key (MainWindow.swift): while the error shows, try at once
    func windowBecameKey() { tryNow() }

    /// Focus, wake or unlock: try at once when the error shows, at most every 10 s
    private func tryNow() {
        guard loadError != nil, !crashedOut, !autoTry, retry.nudge(at: Date()) else { return }
        startAutoTry()
    }

    /// The page failed (loadError is set): plan the next automatic try
    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = nil
        autoTry = false
        guard !crashedOut, let next = retry.failed(at: Date(), random: Double.random(in: 0...1)) else {
            nextRetry = nil
            return
        }
        nextRetry = next
        retryTask = Task { [weak self] in
            let wait = next.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            self?.retry.attempted(at: Date())
            self?.startAutoTry()
        }
    }

    /// Loads the page that failed again, keeping the error up until it answers
    private func startAutoTry() {
        retryTask?.cancel()
        retryTask = nil
        nextRetry = nil
        autoTry = true
        webView.load(URLRequest(url: lastRequested ?? webView.url ?? home))
    }

    private func cancelRetry() {
        retryTask?.cancel()
        retryTask = nil
        nextRetry = nil
        autoTry = false
    }

    /// A main-frame page answered without a 5xx
    private func loaded() {
        loadError = nil
        crashedOut = false
        retry.succeeded()
        cancelRetry()
    }

    /// The page in the default browser
    func openInBrowser() {
        let url = webView.url.flatMap { Server.isDashboard($0, base: base()) && $0.scheme?.hasPrefix("http") == true ? $0 : nil } ?? home
        NSWorkspace.shared.open(url)
    }

    private func fail(_ error: Error) {
        let e = error as NSError
        // A cancelled load (a new one started, or we sent a link to the browser) is not an error
        guard e.domain == NSURLErrorDomain, let text = Problem.text(urlErrorCode: e.code, timeout: 30) else {
            // Another error (WebKit's) ended our own try: keep the error up and plan the next one, so it doesn't hang
            if autoTry && !(e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) { scheduleRetry() }
            return
        }
        loadError = text
        scheduleRetry()
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if mainFrame && !Server.isDashboard(url, base: base()) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // tailscale serve answers 502 when Portboard itself is down: say so instead of showing its bare page
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 500 {
            httpFailed = true
            loadError = Problem.text(httpStatus: http.statusCode)
            scheduleRetry()
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        httpFailed = false
        if !autoTry { loadError = nil } // an automatic try keeps the error up until it answers
        barRegions = nil // the next page reports its own header
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if !httpFailed { loaded() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncPageState()
    }

    /// The page's process died (memory, a WebKit crash) and left a white view: reload, at most 3 times in 5 minutes
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if crashes.allow(at: Date()) {
            webView.reload()
        } else {
            cancelRetry()
            crashedOut = true
            loadError = CrashReloads.text
        }
    }

    // MARK: WKUIDelegate

    /// target=_blank and window.open: the dashboard in this view, anything else in the browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if Server.isDashboard(url, base: base()) && url.scheme?.hasPrefix("http") == true { load(url: url) }
            else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Portboard"
        alert.informativeText = message
        alert.addButton(withTitle: L10n.t("mac.alert.ok"))
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Portboard"
        alert.informativeText = message
        alert.addButton(withTitle: L10n.t("mac.alert.ok"))
        alert.addButton(withTitle: L10n.t("mac.alert.cancel"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Portboard"
        alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: L10n.t("mac.alert.ok"))
        alert.addButton(withTitle: L10n.t("mac.alert.cancel"))
        alert.window.initialFirstResponder = field
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
}

/// The `portboard` script message handler. WKUserContentController keeps its handlers alive, so this holds the
/// controller weakly instead of the controller registering itself.
@MainActor
private final class PageMessages: NSObject, WKScriptMessageHandler {
    weak var target: WebController?

    init(_ target: WebController) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message)
    }
}

/// Puts the shared WKWebView into SwiftUI
struct DashboardWebView: NSViewRepresentable {
    let controller: WebController

    func makeNSView(context: Context) -> WKWebView {
        controller.webView.removeFromSuperview() // in case an earlier window still holds it
        return controller.webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
