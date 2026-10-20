import Foundation
import PortboardCore

/// Version, User-Agent and the settings keys
enum AppInfo {
    /// CFBundleShortVersionString, which build.sh takes from package.json; "dev" when run outside Portboard.app
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    /// The dashboard's 설정 체크리스트 counts the menu bar as installed when it sees this (src/core/onboarding.ts)
    static var userAgent: String { "portboard-mac/\(version)" }

    /// The dashboard URL from 설정 (the default when unset or not a URL)
    static var serverBase: URL {
        Server.normalize(UserDefaults.standard.string(forKey: Pref.serverURL) ?? "") ?? URL(string: Server.defaultURL)!
    }

    /// Notifications and the login item need a real app bundle: `swift run` or the bare binary has none
    static var isBundled: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }
}

/// UserDefaults keys (also used with @AppStorage)
enum Pref {
    static let serverURL = "serverURL"
    static let pollActive = "pollActiveSeconds"
    static let pollBackground = "pollBackgroundSeconds"
    static let notifyWatch = "notifyWatch"
    static let notifyNewDevices = "notifyNewDevices"
    /// set once the notification default was decided from /api/alerts (off when ntfy already covers it)
    static let notifyDecided = "notifyDecided"
    /// whether ntfy was configured when that was decided, for the one-line explanation in 설정
    static let ntfyCovers = "ntfyCovers"
    /// NotifyState (JSON): what was last seen, so a restart does not notify again
    static let notifyState = "notifyState"
    /// 하루 한 번 새 버전 확인 (on by default; the menu's 업데이트 확인… works either way)
    static let updateCheck = "updateCheck"
    /// Date of the last update check, and whether it failed (then the next one is an hour later, not a day)
    static let updateLastCheck = "updateLastCheck"
    static let updateLastFailed = "updateLastFailed"
    /// The tag of the latest release last seen, e.g. "v1.2.0"
    static let updateLatest = "updateLatest"

    static func register() {
        UserDefaults.standard.register(defaults: [
            serverURL: Server.defaultURL,
            pollActive: 30.0,
            pollBackground: 120.0,
            notifyWatch: false,
            notifyNewDevices: false,
            notifyDecided: false,
            ntfyCovers: false,
            updateCheck: true,
        ])
    }
}
