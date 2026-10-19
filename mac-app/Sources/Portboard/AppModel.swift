import AppKit
import Foundation
import PortboardCore

/// The app's state: the last poll of the API, the polling loop, notifications and the one write (tailnet 공개).
/// Shared by the menu bar, the window and the settings window.
@MainActor
final class AppModel: ObservableObject {
    /// The last good poll (kept while a later one fails, but the menu then shows the error instead)
    @Published private(set) var snapshot: Snapshot?
    /// Why /api/ports could not be read, in Korean; nil when it could
    @Published private(set) var problem: String?
    @Published private(set) var lastUpdate: Date?
    @Published private(set) var refreshing = false
    /// The result of the last action (tailnet 공개), shown at the top of the menu for a minute
    @Published private(set) var flash: String?

    var menuOpen = false
    /// Set by a view that has SwiftUI's openWindow (the menu bar label): shows the dashboard window
    var openMainWindow: (() -> Void)?
    /// Set by the window's web view: loads a dashboard path in it
    var loadInWindow: ((String) -> Void)?
    /// Set by the window's web view: the port whose service page is in front in the key window, if any
    var viewingPort: (() -> Int?)?

    private var loop: Task<Void, Never>?
    private var lastAttempt: Date?
    private var flashClear: Task<Void, Never>?
    private let defaults = UserDefaults.standard
    private var badgeCount = 0

    var base: URL { AppInfo.serverBase }

    var status: MenuStatus? { snapshot.map(MenuStatus.init) }

    private var activeInterval: TimeInterval { defaults.double(forKey: Pref.pollActive) }
    private var backgroundInterval: TimeInterval { defaults.double(forKey: Pref.pollBackground) }

    func start() {
        guard loop == nil else { return }
        // A 5 s tick that polls when the interval for the current state (in front / menu open / background) is due,
        // so switching to the app or opening the menu takes effect at once.
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollIfDue()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func pollIfDue() async {
        let interval = Poll.interval(appActive: NSApp.isActive, menuOpen: menuOpen, active: activeInterval, background: backgroundInterval)
        if let lastAttempt, Date().timeIntervalSince(lastAttempt) < interval { return }
        await refresh()
    }

    /// The menu opened: refresh now if what it shows is older than the short interval
    func menuOpened() {
        menuOpen = true
        if Poll.isStale(lastUpdate: lastAttempt, now: Date(), active: activeInterval) { refreshNow() }
    }

    func menuClosed() { menuOpen = false }

    func refreshNow() {
        Task { await refresh() }
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        lastAttempt = Date()
        defer { refreshing = false }

        let api = APIClient(base: base)
        async let ports = api.fetch("/api/ports")
        async let usage = api.fetch("/api/usage")
        async let devices = api.fetch("/api/devices")
        async let alerts = api.fetch("/api/alerts")
        async let owners = api.fetch("/api/owners")
        let results = await (ports: ports, usage: usage, devices: devices, alerts: alerts, owners: owners)

        switch results.ports {
        case .failure(let e):
            problem = e.message
        case .success(let portsDoc):
            var errors: [String: String] = [:]
            func value(_ r: Result<JSON, APIError>, _ name: String) -> JSON? {
                switch r {
                case .success(let j): return j
                case .failure(let e): errors[name] = e.message; return nil
                }
            }
            let s = Snapshot(
                ports: portsDoc,
                usage: value(results.usage, "usage"),
                devices: value(results.devices, "devices"),
                alerts: value(results.alerts, "alerts"),
                owners: value(results.owners, "owners"),
                errors: errors
            )
            snapshot = s
            problem = nil
            lastUpdate = Date()
            notify(s)
            updateBadge(s)
        }
    }

    // MARK: notifications

    private func notify(_ s: Snapshot) {
        let alerts = s.alerts.map(AlertsDoc.init)
        // Decide the default once, from the first answer: off when ntfy already sends these alerts
        if let alerts, !defaults.bool(forKey: Pref.notifyDecided) {
            let on = Notify.defaultEnabled(alerts)
            defaults.set(on, forKey: Pref.notifyWatch)
            defaults.set(on, forKey: Pref.notifyNewDevices)
            defaults.set(!on, forKey: Pref.ntfyCovers)
            defaults.set(true, forKey: Pref.notifyDecided)
            if on { Task { _ = await Notifier.shared.requestAuthorization() } }
        }
        let pending: [NewDevice]? = s.usage.flatMap { u in
            u["newDevices"]["pending"].isArray ? u["newDevices"]["pending"].array.compactMap(NewDevice.init) : nil
        }
        let previous = NotifyState.decode(defaults.data(forKey: Pref.notifyState))
        let (events, next) = Notify.diff(previous: previous, watching: alerts?.watching, newDevices: pending)
        if next != previous { defaults.set(next.encoded(), forKey: Pref.notifyState) }
        let watchOn = defaults.bool(forKey: Pref.notifyWatch)
        let devicesOn = defaults.bool(forKey: Pref.notifyNewDevices)
        // HOOK(new-ports): when GET /api/new-ports is on main, fetch it in refresh() and diff it here like newDevices
        let viewing = viewingPort?()
        for e in events where (e.kind == .newDevice ? devicesOn : watchOn) {
            // You are looking at that port's page: no banner (the state above is saved, so it doesn't come later)
            if Notify.suppressed(e, viewingPort: viewing) { Notifier.shared.withdraw(e) }
            else { Notifier.shared.post(e) }
        }
    }

    /// The Dock badge: watched (🔔) ports that are down, the one thing that waits on you. Kept when /api/alerts failed.
    private func updateBadge(_ s: Snapshot) {
        let n = Notify.badge(alerts: s.alerts.map(AlertsDoc.init), previous: badgeCount)
        guard n != badgeCount else { return }
        badgeCount = n
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    // MARK: actions

    /// tailnet 공개: POST /api/ports/<port>/expose (X-Portboard: 1), then refresh
    func expose(_ port: Int) {
        Task {
            let api = APIClient(base: base)
            do {
                let reply = try await api.post("/api/ports/\(port)/expose")
                if reply.ok {
                    show(flash: "✓ :\(port) tailnet 공개: \(reply.message)")
                } else {
                    showAlert("tailnet 공개 실패 (:\(port))", reply.message, link: reply.enableURL.map { ("Tailscale에서 Serve 켜기", $0) })
                }
            } catch let e as APIError {
                showAlert("tailnet 공개 실패 (:\(port))", e.message)
            } catch {
                showAlert("tailnet 공개 실패 (:\(port))", "\(error)")
            }
            await refresh()
        }
    }

    func whoami() async -> Result<WhoAmI, APIError> {
        await APIClient(base: base).fetch("/api/whoami").map(WhoAmI.init)
    }

    private func show(flash text: String) {
        flash = Fmt.menuText(text)
        flashClear?.cancel()
        flashClear = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            if !Task.isCancelled { self?.flash = nil }
        }
    }

    private func showAlert(_ title: String, _ message: String, link: (String, URL)? = nil) {
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "확인")
        if let link { alert.addButton(withTitle: link.0) }
        if alert.runModal() == .alertSecondButtonReturn, let link { NSWorkspace.shared.open(link.1) }
    }

    // MARK: opening things

    /// A dashboard page (relative path) in the app's window
    func open(_ path: String) {
        if let openMainWindow {
            openMainWindow()
            NSApp.activate()
            loadInWindow?(path)
        } else {
            openInBrowser(path)
        }
    }

    func openInBrowser(_ path: String = "") {
        NSWorkspace.shared.open(Server.url(base, path))
    }

    func openURL(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    /// The server URL changed in 설정
    func serverChanged() {
        snapshot = nil
        problem = nil
        lastAttempt = nil
        loadInWindow?("")
        refreshNow()
    }
}
