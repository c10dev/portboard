import XCTest
@testable import PortboardCore

final class UpdateTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func release(_ tag: String, html: String? = nil, draft: Bool = false, prerelease: Bool = false) -> JSON {
        var o: [String: JSON] = ["tag_name": .string(tag), "draft": .bool(draft), "prerelease": .bool(prerelease)]
        if let html { o["html_url"] = .string(html) }
        return .object(o)
    }

    func testVersionParsingAndOrder() {
        XCTAssertEqual(AppVersion("v1.2.3")?.parts, [1, 2, 3])
        XCTAssertEqual(AppVersion("1.2")?.parts, [1, 2, 0])
        XCTAssertEqual(AppVersion(" 2 ")?.description, "2.0.0")
        XCTAssertEqual(AppVersion("1.2.0-beta.1")?.prerelease, true)
        for bad in ["dev", "", "v", "1..2", "1.2.3.4", "a.b.c", "1.-2.0"] {
            XCTAssertNil(AppVersion(bad), bad)
        }
        XCTAssertLessThan(AppVersion("1.1.0")!, AppVersion("1.1.1")!)
        XCTAssertLessThan(AppVersion("1.9.0")!, AppVersion("1.10.0")!) // numbers, not text
        XCTAssertLessThan(AppVersion("1.2.0-rc.1")!, AppVersion("1.2.0")!)
        XCTAssertEqual(AppVersion("v1.2")!, AppVersion("1.2.0")!)
    }

    func testReleaseDocument() {
        let r = LatestRelease(release("v1.2.0", html: "https://github.com/c10dev/portboard/releases/tag/v1.2.0"))
        XCTAssertEqual(r?.version.description, "1.2.0")
        XCTAssertEqual(r?.page.absoluteString, "https://github.com/c10dev/portboard/releases/tag/v1.2.0")
        XCTAssertNil(LatestRelease(release("v1.2.0", draft: true)))
        XCTAssertNil(LatestRelease(release("v1.2.0", prerelease: true)))
        XCTAssertNil(LatestRelease(release("v1.2.0-beta.1")))
        XCTAssertNil(LatestRelease(release("nightly")))
        XCTAssertNil(LatestRelease(json(#"{"message":"Not Found"}"#)))
        XCTAssertNil(LatestRelease(.null))
    }

    /// The page opened is always this repository's release page, whatever html_url says
    func testReleasePageStaysOnTheRepository() {
        let built = "https://github.com/c10dev/portboard/releases/tag/v1.2.0"
        XCTAssertEqual(LatestRelease(release("v1.2.0"))?.page.absoluteString, built)
        for odd in ["https://evil.example/c10dev/portboard/releases/tag/v1.2.0",
                    "http://github.com/c10dev/portboard/releases/tag/v1.2.0",
                    "https://github.com/someone/portboard/releases/tag/v1.2.0",
                    "https://github.com/c10dev/portboard/releasesX",
                    "javascript:alert(1)"] {
            XCTAssertEqual(LatestRelease(release("v1.2.0", html: odd))?.page.absoluteString, built, odd)
        }
    }

    func testNewer() {
        let latest = LatestRelease(release("v1.2.0"))
        XCTAssertEqual(UpdateCheck.newer(current: "1.1.0", latest: latest)?.tag, "v1.2.0")
        XCTAssertNil(UpdateCheck.newer(current: "1.2.0", latest: latest))
        XCTAssertNil(UpdateCheck.newer(current: "1.3.0", latest: latest)) // a local build ahead of the release
        XCTAssertNil(UpdateCheck.newer(current: "dev", latest: latest))
        XCTAssertNil(UpdateCheck.newer(current: "1.1.0", latest: nil))
    }

    func testStoredRoundTrip() {
        let r = LatestRelease(release("v1.2.0"))!
        XCTAssertEqual(LatestRelease(stored: r.stored), r)
        XCTAssertNil(LatestRelease(stored: nil))
        XCTAssertNil(LatestRelease(stored: "garbage"))
    }

    func testDue() {
        let day = UpdateCheck.interval
        XCTAssertTrue(UpdateCheck.isDue(lastCheck: nil, lastFailed: false, now: t0))
        XCTAssertFalse(UpdateCheck.isDue(lastCheck: t0, lastFailed: false, now: t0.addingTimeInterval(day - 1)))
        XCTAssertTrue(UpdateCheck.isDue(lastCheck: t0, lastFailed: false, now: t0.addingTimeInterval(day)))
        // a failed check is tried again after an hour
        XCTAssertFalse(UpdateCheck.isDue(lastCheck: t0, lastFailed: true, now: t0.addingTimeInterval(59 * 60)))
        XCTAssertTrue(UpdateCheck.isDue(lastCheck: t0, lastFailed: true, now: t0.addingTimeInterval(60 * 60)))
        // the clock went back
        XCTAssertTrue(UpdateCheck.isDue(lastCheck: t0, lastFailed: false, now: t0.addingTimeInterval(-60)))
    }

    func testTexts() {
        let latest = LatestRelease(release("v1.2.0"))!
        XCTAssertEqual(UpdateCheck.menuTitle(latest), "새 버전 1.2.0 있음 — 다운로드 페이지 열기")
        let newer = UpdateCheck.manualResult(current: "1.1.0", latest: latest)
        XCTAssertTrue(newer.newer)
        XCTAssertEqual(newer.title, "Portboard 1.2.0이 나왔습니다")
        XCTAssertTrue(newer.message.contains("1.1.0"))
        let current = UpdateCheck.manualResult(current: "1.2.0", latest: latest)
        XCTAssertFalse(current.newer)
        XCTAssertEqual(current.title, "최신 버전입니다")
        let dev = UpdateCheck.manualResult(current: "dev", latest: latest)
        XCTAssertFalse(dev.newer)
        XCTAssertTrue(dev.message.contains("1.2.0"))
        XCTAssertEqual(UpdateCheck.failure(httpStatus: 404), "GitHub에 릴리스가 없습니다")
        XCTAssertTrue(UpdateCheck.failure(httpStatus: 403).contains("요청이 너무 많음"))
        XCTAssertEqual(UpdateCheck.failure(httpStatus: 500), "GitHub 응답 HTTP 500")
        XCTAssertEqual(UpdateCheck.failure(urlErrorCode: -1003, timeout: 15), "GitHub에 연결하지 못했습니다 (오류 -1003)")
    }
}
