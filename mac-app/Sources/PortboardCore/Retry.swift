import Foundation

/// When the window tries the dashboard again after it failed to load, like the Claude desktop app: at once, then
/// after 15 s, then every 30 s, each ±20 %, for 3 minutes from the first failure. Window focus, wake from sleep,
/// screen unlock and 다시 시도 try at once and start a new 3 minutes. A value type with `now` and the random number
/// passed in, so it is tested without a clock.
public struct LoadRetry: Equatable, Sendable {
    public static let delays: [TimeInterval] = [0, 15, 30]
    public static let jitter = 0.2
    public static let window: TimeInterval = 180
    /// Focus can flap (a dialog, the menu bar): early tries are at least this far apart
    public static let nudgeGap: TimeInterval = 10

    /// Start of the current 3 minutes; nil while the page loads fine
    public private(set) var since: Date?
    /// Automatic tries scheduled in the current 3 minutes
    public private(set) var attempts = 0
    /// The last try of any kind (automatic, early or by hand)
    public private(set) var lastAttempt: Date?

    public init() {}

    /// `delays[n]`, then the last one again; ±`jitter` from `random` in 0…1 (0.5 is no jitter). 0 stays 0.
    public static func delay(attempt n: Int, random: Double) -> TimeInterval {
        let base = delays[min(max(n, 0), delays.count - 1)]
        let r = min(max(random, 0), 1)
        return base * (1 + jitter * (2 * r - 1))
    }

    /// A load failed: when to try again, or nil once the 3 minutes are over (then only 다시 시도, focus, wake and
    /// unlock try again).
    public mutating func failed(at now: Date, random: Double) -> Date? {
        let start = since ?? now
        since = start
        let next = now.addingTimeInterval(Self.delay(attempt: attempts, random: random))
        guard next.timeIntervalSince(start) <= Self.window else { return nil }
        attempts += 1
        return next
    }

    /// An automatic try starts now
    public mutating func attempted(at now: Date) {
        lastAttempt = now
    }

    /// Window focus, wake or unlock while the error shows: true when it should try now. A try counts as the 0 s
    /// one of a new 3 minutes, so the next failure waits 15 s. `byHand` (다시 시도) ignores the 10 s gap.
    public mutating func nudge(at now: Date, byHand: Bool = false) -> Bool {
        if !byHand, let lastAttempt, now.timeIntervalSince(lastAttempt) < Self.nudgeGap { return false }
        since = now
        attempts = 1
        lastAttempt = now
        return true
    }

    /// The page loaded: forget the outage
    public mutating func succeeded() {
        self = LoadRetry()
    }

    /// The line under the error. `next` nil: the automatic tries are over.
    public static func status(next: Date?, now: Date, timeZone: TimeZone = .current) -> String {
        guard let next else { return L10n.t("mac.retry.stopped") }
        let left = Int(next.timeIntervalSince(now).rounded(.up))
        guard left > 0 else { return L10n.t("mac.retry.trying") }
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm:ss"
        return L10n.t("mac.retry.next", ["time": f.string(from: next), "seconds": left])
    }
}

/// Reloads after the web content process died (WKWebView leaves a white page): at most 3 in 5 minutes, so a page
/// that keeps crashing doesn't loop.
public struct CrashReloads: Equatable, Sendable {
    public static let limit = 3
    public static let period: TimeInterval = 300
    public private(set) var times: [Date] = []

    public init() {}

    /// true (and counted) when another reload is allowed now
    public mutating func allow(at now: Date) -> Bool {
        times = times.filter { now.timeIntervalSince($0) < Self.period }
        guard times.count < Self.limit else { return false }
        times.append(now)
        return true
    }

    /// Shown instead of reloading once the limit is reached
    public static var text: String { L10n.t("mac.retry.crashed") }
}
