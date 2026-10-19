import XCTest
@testable import PortboardCore

final class RetryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    func testDelaysAndJitter() {
        XCTAssertEqual(LoadRetry.delay(attempt: 0, random: 0), 0)
        XCTAssertEqual(LoadRetry.delay(attempt: 0, random: 1), 0)
        XCTAssertEqual(LoadRetry.delay(attempt: 1, random: 0.5), 15)
        XCTAssertEqual(LoadRetry.delay(attempt: 1, random: 0), 12, accuracy: 0.001)
        XCTAssertEqual(LoadRetry.delay(attempt: 1, random: 1), 18, accuracy: 0.001)
        XCTAssertEqual(LoadRetry.delay(attempt: 2, random: 0.5), 30)
        XCTAssertEqual(LoadRetry.delay(attempt: 7, random: 0.5), 30) // the last delay repeats
        XCTAssertEqual(LoadRetry.delay(attempt: 7, random: 0), 24, accuracy: 0.001)
        XCTAssertEqual(LoadRetry.delay(attempt: 7, random: 5), 36, accuracy: 0.001) // clamped
        for r in stride(from: 0.0, through: 1.0, by: 0.1) {
            let d = LoadRetry.delay(attempt: 2, random: r)
            XCTAssertTrue(d >= 24 && d <= 36)
        }
    }

    /// Each try fails the moment it starts: at once, 15 s, then every 30 s until 3 minutes after the first failure
    func testScheduleStopsAfterThreeMinutes() {
        var r = LoadRetry()
        var now = at(0)
        var tries: [TimeInterval] = []
        while let next = r.failed(at: now, random: 0.5) {
            tries.append(next.timeIntervalSince(t0))
            r.attempted(at: next)
            now = next
        }
        XCTAssertEqual(tries, [0, 15, 45, 75, 105, 135, 165])
        XCTAssertNil(r.failed(at: at(200), random: 0.5))
    }

    func testJitterKeepsInsideTheWindow() {
        var r = LoadRetry()
        var now = at(0)
        var count = 0
        while let next = r.failed(at: now, random: 1) {
            XCTAssertLessThanOrEqual(next.timeIntervalSince(t0), LoadRetry.window)
            now = next
            count += 1
        }
        XCTAssertEqual(count, 6) // 0, 18, 54, 90, 126, 162
    }

    func testSuccessForgets() {
        var r = LoadRetry()
        _ = r.failed(at: at(0), random: 0.5)
        _ = r.failed(at: at(1), random: 0.5)
        r.succeeded()
        XCTAssertEqual(r, LoadRetry())
        // a new outage starts at once again
        XCTAssertEqual(r.failed(at: at(500), random: 0.5), at(500))
    }

    func testNudgeStartsANewWindowAtMostEvery10s() {
        var r = LoadRetry()
        var now = at(0)
        while let next = r.failed(at: now, random: 0.5) { r.attempted(at: next); now = next }
        XCTAssertNil(r.failed(at: at(200), random: 0.5)) // the automatic tries are over
        // wake from sleep: try now, then 15 s, 30 s… for another 3 minutes
        XCTAssertTrue(r.nudge(at: at(1000)))
        XCTAssertFalse(r.nudge(at: at(1005))) // focus right after: too soon
        XCTAssertEqual(r.failed(at: at(1001), random: 0.5), at(1016))
        r.attempted(at: at(1016))
        XCTAssertFalse(r.nudge(at: at(1020)))
        XCTAssertTrue(r.nudge(at: at(1027)))
        // 다시 시도 always goes
        XCTAssertTrue(r.nudge(at: at(1028), byHand: true))
        XCTAssertEqual(r.since, at(1028))
    }

    func testStatusText() {
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(LoadRetry.status(next: at(12), now: at(0), timeZone: utc), "자동으로 다시 시도하는 중… 다음 시도 \(clock(at(12), utc)) (12초 후)")
        XCTAssertEqual(LoadRetry.status(next: at(0.4), now: at(0), timeZone: utc).hasSuffix("(1초 후)"), true)
        XCTAssertEqual(LoadRetry.status(next: at(0), now: at(0)), "자동으로 다시 시도하는 중…")
        XCTAssertEqual(LoadRetry.status(next: at(-3), now: at(0)), "자동으로 다시 시도하는 중…")
        XCTAssertTrue(LoadRetry.status(next: nil, now: at(0)).contains("다시 시도를 눌러"))
    }

    func clock(_ d: Date, _ tz: TimeZone) -> String {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        let p = c.dateComponents([.hour, .minute, .second], from: d)
        return String(format: "%02d:%02d:%02d", p.hour!, p.minute!, p.second!)
    }

    func testCrashReloadsThreeInFiveMinutes() {
        var c = CrashReloads()
        XCTAssertTrue(c.allow(at: at(0)))
        XCTAssertTrue(c.allow(at: at(60)))
        XCTAssertTrue(c.allow(at: at(120)))
        XCTAssertFalse(c.allow(at: at(200)))
        XCTAssertFalse(c.allow(at: at(299)))
        // the first one is 5 minutes old: one more is allowed
        XCTAssertTrue(c.allow(at: at(300)))
        XCTAssertFalse(c.allow(at: at(301)))
        XCTAssertEqual(c.times.count, 3)
    }
}
