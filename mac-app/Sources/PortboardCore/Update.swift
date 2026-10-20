import Foundation

/// A release version: `1.2.3` or `v1.2.3`, with an optional `-beta.1` after it. A pre-release sorts before its
/// release; two pre-releases of the same version are equal (the update check never offers one).
public struct AppVersion: Comparable, Sendable, CustomStringConvertible {
    public let parts: [Int]
    public let prerelease: Bool

    public init?(_ text: String) {
        var s = Substring(text.trimmingCharacters(in: .whitespaces))
        if s.first == "v" || s.first == "V" { s = s.dropFirst() }
        let core = s.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard let head = core.first, !head.isEmpty else { return nil }
        let nums = head.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard (1...3).contains(nums.count), nums.allSatisfy({ ($0 ?? -1) >= 0 }) else { return nil }
        parts = nums.compactMap { $0 } + Array(repeating: 0, count: 3 - nums.count)
        prerelease = core.count > 1
    }

    public var description: String { parts.map(String.init).joined(separator: ".") }

    public static func < (a: AppVersion, b: AppVersion) -> Bool {
        if a.parts != b.parts { return a.parts.lexicographicallyPrecedes(b.parts) }
        return a.prerelease && !b.prerelease
    }

    public static func == (a: AppVersion, b: AppVersion) -> Bool {
        a.parts == b.parts && a.prerelease == b.prerelease
    }
}

/// One GitHub release, read from `GET /repos/c10dev/portboard/releases/latest`
public struct LatestRelease: Equatable, Sendable {
    public let version: AppVersion
    public let tag: String
    /// The release page, always under UpdateCheck.releasesPage
    public let page: URL

    /// nil for a draft, a pre-release, a tag that isn't a version, or anything that isn't a release document
    public init?(_ j: JSON) {
        guard let tag = j["tag_name"].text, let version = AppVersion(tag), !version.prerelease,
              j["draft"] != .bool(true), j["prerelease"] != .bool(true) else { return nil }
        self.init(version: version, tag: tag, htmlURL: j["html_url"].string)
    }

    init(version: AppVersion, tag: String, htmlURL: String?) {
        self.version = version
        self.tag = tag
        page = UpdateCheck.releasePage(htmlURL: htmlURL, tag: tag)
    }

    /// What `UpdateCheck` keeps in the defaults between launches
    public var stored: String { tag }

    public init?(stored: String?) {
        guard let stored, let version = AppVersion(stored), !version.prerelease else { return nil }
        self.init(version: version, tag: stored, htmlURL: nil)
    }
}

/// The once-a-day check for a newer Portboard.app. No Sparkle: it reads GitHub's latest release and, when that is
/// newer than this app, the menu offers its release page (the signed zip is downloaded and replaced by hand).
public enum UpdateCheck {
    public static let latestURL = URL(string: "https://api.github.com/repos/c10dev/portboard/releases/latest")!
    public static let releasesPage = URL(string: "https://github.com/c10dev/portboard/releases")!
    public static let interval: TimeInterval = 24 * 60 * 60
    /// After a failed check, try again sooner than a day (the Mac was offline at the time, for instance)
    public static let retryAfterFailure: TimeInterval = 60 * 60

    /// Whether the automatic check should run now. A clock set back (last check in the future) checks too.
    public static func isDue(lastCheck: Date?, lastFailed: Bool, now: Date) -> Bool {
        guard let lastCheck else { return true }
        let elapsed = now.timeIntervalSince(lastCheck)
        return elapsed < 0 || elapsed >= (lastFailed ? retryAfterFailure : interval)
    }

    /// The release when it is newer than `current` (CFBundleShortVersionString). A build outside Portboard.app
    /// ("dev") or with an unreadable version is never offered one.
    public static func newer(current: String, latest: LatestRelease?) -> LatestRelease? {
        guard let latest, let mine = AppVersion(current), mine < latest.version else { return nil }
        return latest
    }

    /// The page to open: GitHub's `html_url` when it is this repository's release page, else one built from the tag,
    /// so the app never opens an address it didn't expect.
    public static func releasePage(htmlURL: String?, tag: String) -> URL {
        let prefix = releasesPage.absoluteString + "/"
        if let htmlURL, htmlURL.hasPrefix(prefix), let url = URL(string: htmlURL), url.scheme == "https",
           url.host == "github.com" {
            return url
        }
        let escaped = tag.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? ""
        return URL(string: prefix + "tag/" + escaped) ?? releasesPage
    }

    /// The menu line when a newer version is out
    public static func menuTitle(_ r: LatestRelease) -> String {
        L10n.t("mac.update.available", ["version": r.version.description])
    }

    /// The result of 업데이트 확인… by hand: title and text for the alert
    public static func manualResult(current: String, latest: LatestRelease) -> (title: String, message: String, newer: Bool) {
        if let r = newer(current: current, latest: latest) {
            return (L10n.t("mac.update.newTitle", ["version": r.version.description]),
                    L10n.t("mac.update.newMessage", ["current": current]), true)
        }
        if AppVersion(current) == nil {
            return (L10n.t("mac.update.devTitle"), L10n.t("mac.update.devMessage", ["latest": latest.version.description]), false)
        }
        return (L10n.t("mac.update.upToDateTitle"), L10n.t("mac.update.upToDateMessage", ["current": current]), false)
    }

    /// Why the check failed (a network error), for the alert after 업데이트 확인…. Not Problem.text: its texts are
    /// about Tailscale and the Portboard server, and this request goes to GitHub.
    public static func failure(urlErrorCode code: Int, timeout: Int) -> String {
        switch code {
        case -1001: return L10n.t("mac.error.timeout", ["seconds": timeout])
        case -1009: return L10n.t("mac.error.notConnected")
        default: return L10n.t("mac.update.unreachable", ["code": code])
        }
    }

    /// Why the check failed (an HTTP status)
    public static func failure(httpStatus: Int) -> String {
        switch httpStatus {
        case 403, 429: return L10n.t("mac.update.rateLimited")
        case 404: return L10n.t("mac.update.noRelease")
        default: return L10n.t("mac.update.httpError", ["status": httpStatus])
        }
    }
}
