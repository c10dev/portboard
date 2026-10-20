import Foundation

/// The dashboard's address and pages
public enum Server {
    /// Placeholder when the app was built without a server address (build.sh writes PortboardServerURL into
    /// Info.plist from PORTBOARD_SERVER_URL or mac-app/build.env). 설정 changes it either way.
    public static let placeholderURL = "https://portboard.example.ts.net:8443"

    /// The address a fresh install starts with: Info.plist's PortboardServerURL, else the placeholder
    public static let defaultURL = resolveDefaultURL(Bundle.main.object(forInfoDictionaryKey: "PortboardServerURL") as? String)

    /// A configured address when it is a valid one, else the placeholder
    public static func resolveDefaultURL(_ configured: String?) -> String {
        guard let c = configured, let u = normalize(c) else { return placeholderURL }
        return u.absoluteString
    }

    /// What the user typed in 설정 → a base URL without a trailing slash; `https://` when no scheme is given.
    /// nil for anything that is not an http(s) URL with a host.
    public static func normalize(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://\(s)" }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    /// base + "/" + path (path may hold a #fragment or ?query)
    public static func url(_ base: URL, _ path: String) -> URL {
        var b = base.absoluteString
        while b.hasSuffix("/") { b.removeLast() }
        var p = path
        while p.hasPrefix("/") { p.removeFirst() }
        return URL(string: "\(b)/\(p)") ?? base
    }

    static func effectivePort(_ u: URL) -> Int? {
        if let p = u.port { return p }
        switch u.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /// Does this URL belong to the dashboard (same scheme, host and port)? Everything else (an opened service, the
    /// docs on GitHub) goes to the default browser. Pages with no host (about:blank, blob:, data:) stay in the app.
    public static func isDashboard(_ url: URL, base: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return true }
        guard scheme == "http" || scheme == "https" else { return false }
        return scheme == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased()
            && effectivePort(url) == effectivePort(base)
    }

    /// May a link that leaves the dashboard go to another app? Only web pages and mail: a page can't make the app open
    /// a file:// path or another app's own scheme (x-apple.systempreferences:, vscode:, …).
    public static func opensExternally(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https" || scheme == "mailto"
    }

    /// The port of a service.html#<port> page; nil for any other page
    public static func servicePort(_ url: URL) -> Int? {
        guard url.lastPathComponent == "service.html", let f = url.fragment, let port = Int(f), port > 0 else { return nil }
        return port
    }

    /// The same for a dashboard path ("service.html#3000")
    public static func servicePort(path: String) -> Int? {
        let parts = path.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].split(separator: "/").last == "service.html",
              let port = Int(parts[1]), port > 0 else { return nil }
        return port
    }
}

/// The dashboard's tabs, for the 대시보드 menu (⌘1…⌘4)
public enum DashboardTab: String, CaseIterable, Sendable {
    case services, devices, dev, settings

    public var title: String {
        switch self {
        case .services: return L10n.t("shell.view.services")
        case .devices: return L10n.t("shell.view.devices")
        case .dev: return L10n.t("shell.view.dev")
        case .settings: return L10n.t("shell.view.settings")
        }
    }

    public var path: String {
        switch self {
        case .services: return ""
        case .devices: return "devices.html"
        case .dev: return "dev.html"
        case .settings: return "settings.html"
        }
    }

    /// Which tab a dashboard page belongs to (service.html is a 서비스 detail page); nil for other pages
    public static func of(_ url: URL?) -> DashboardTab? {
        guard let url else { return nil }
        switch url.lastPathComponent {
        case "", "/", "index.html", "service.html": return .services
        case "devices.html": return .devices
        case "dev.html": return .dev
        case "settings.html": return .settings
        default: return nil
        }
    }
}

/// Error text for the window and the menu when the server cannot be read: plain words, with the likely cause.
public enum Problem {
    /// NSURLErrorDomain codes (URLError.Code raw values). nil for a cancelled load, which is not an error.
    public static func text(urlErrorCode code: Int, timeout: Int = 8) -> String? {
        switch code {
        case -999: return nil
        case -1001: return L10n.t("mac.error.timeout", ["seconds": timeout])
        case -1003, -1006: return L10n.t("mac.error.hostNotFound")
        case -1004: return L10n.t("mac.error.cannotConnect")
        case -1005: return L10n.t("mac.error.connectionLost")
        case -1009: return L10n.t("mac.error.notConnected")
        case -1018, -1020: return L10n.t("mac.error.networkUnavailable")
        case -1022: return L10n.t("mac.error.insecureHTTP")
        case -1200, -1201, -1202, -1203, -1204, -1205, -1206: return L10n.t("mac.error.tls")
        case -1011: return L10n.t("mac.error.badResponse")
        default: return L10n.t("mac.error.other", ["code": code])
        }
    }

    /// An HTTP status that is not 2xx
    public static func text(httpStatus status: Int) -> String {
        switch status {
        case 502, 503, 504: return L10n.t("mac.error.serverDown", ["status": status])
        case 401, 403: return L10n.t("mac.error.denied", ["status": status])
        case 404: return L10n.t("mac.error.notFound")
        default: return L10n.t("mac.error.http", ["status": status])
        }
    }

    /// The second line under the error
    public static func hint(base: URL) -> String {
        L10n.t("mac.error.hint", ["url": base.absoluteString])
    }
}

/// How often to poll: the short interval while the app is in front or its menu is open, the long one otherwise.
public enum Poll {
    public static let activeDefault: TimeInterval = 30
    public static let backgroundDefault: TimeInterval = 120
    public static let choices: [TimeInterval] = [15, 30, 60, 120, 300, 600]

    public static func interval(appActive: Bool, menuOpen: Bool, active: TimeInterval, background: TimeInterval) -> TimeInterval {
        let a = max(10, active)
        return appActive || menuOpen ? a : max(a, background)
    }

    /// Refresh at once when the menu opens if what it shows is older than this
    public static func isStale(lastUpdate: Date?, now: Date, active: TimeInterval) -> Bool {
        guard let lastUpdate else { return true }
        return now.timeIntervalSince(lastUpdate) >= max(10, active)
    }

    /// "15초" / "2분"
    public static func label(_ t: TimeInterval) -> String {
        t < 60 ? L10n.t("mac.settings.seconds", ["n": Int(t)]) : L10n.t("mac.settings.minutes", ["n": Int(t / 60)])
    }
}
