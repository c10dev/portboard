import XCTest
@testable import PortboardCore

final class ServerTests: XCTestCase {
    let base = URL(string: "https://devbox.example.ts.net:8443")!

    func testDefaultURL() {
        // Info.plist's PortboardServerURL (build.sh), normalized; the placeholder when missing or not a URL
        XCTAssertEqual(Server.resolveDefaultURL("devbox.example.ts.net:8443/"), "https://devbox.example.ts.net:8443")
        XCTAssertEqual(Server.resolveDefaultURL(nil), Server.placeholderURL)
        XCTAssertEqual(Server.resolveDefaultURL(""), Server.placeholderURL)
        XCTAssertEqual(Server.resolveDefaultURL("ftp://x"), Server.placeholderURL)
        // the test bundle has no PortboardServerURL
        XCTAssertEqual(Server.defaultURL, Server.placeholderURL)
    }

    func testNormalize() {
        XCTAssertEqual(Server.normalize(" https://devbox.example.ts.net:8443/ ")?.absoluteString, "https://devbox.example.ts.net:8443")
        XCTAssertEqual(Server.normalize("devbox.example.ts.net:8443")?.absoluteString, "https://devbox.example.ts.net:8443")
        XCTAssertEqual(Server.normalize("http://127.0.0.1:8790")?.absoluteString, "http://127.0.0.1:8790")
        XCTAssertNil(Server.normalize(""))
        XCTAssertNil(Server.normalize("ftp://x"))
        XCTAssertNil(Server.normalize("https://"))
    }

    func testURLJoin() {
        XCTAssertEqual(Server.url(base, "devices.html#desktop-pc").absoluteString, "https://devbox.example.ts.net:8443/devices.html#desktop-pc")
        XCTAssertEqual(Server.url(base, "").absoluteString, "https://devbox.example.ts.net:8443/")
        XCTAssertEqual(Server.url(base, "/api/ports/3080/expose").absoluteString, "https://devbox.example.ts.net:8443/api/ports/3080/expose")
    }

    func testIsDashboard() {
        XCTAssertTrue(Server.isDashboard(URL(string: "https://devbox.example.ts.net:8443/dev.html")!, base: base))
        XCTAssertTrue(Server.isDashboard(URL(string: "https://Devbox.example.ts.net:8443/")!, base: base))
        XCTAssertTrue(Server.isDashboard(URL(string: "about:blank")!, base: base))
        // an opened service (another serve port), the public connector on 443, GitHub docs: the browser
        XCTAssertFalse(Server.isDashboard(URL(string: "https://devbox.example.ts.net:5281/")!, base: base))
        XCTAssertFalse(Server.isDashboard(URL(string: "https://devbox.example.ts.net/mcp")!, base: base))
        XCTAssertFalse(Server.isDashboard(URL(string: "https://github.com/c10dev/portboard")!, base: base))
        XCTAssertFalse(Server.isDashboard(URL(string: "http://devbox.example.ts.net:8443/")!, base: base))
        XCTAssertFalse(Server.isDashboard(URL(string: "mailto:a@b.c")!, base: base))
        let plain = URL(string: "https://example.com")!
        XCTAssertTrue(Server.isDashboard(URL(string: "https://example.com:443/x")!, base: plain))
    }

    func testTabs() {
        XCTAssertEqual(DashboardTab.allCases.map(\.title), ["서비스", "기기", "개발", "설정"])
        XCTAssertEqual(DashboardTab.of(URL(string: "https://h:8443/")), .services)
        XCTAssertEqual(DashboardTab.of(URL(string: "https://h:8443")), .services)
        XCTAssertEqual(DashboardTab.of(URL(string: "https://h:8443/service.html#3000")), .services)
        XCTAssertEqual(DashboardTab.of(URL(string: "https://h:8443/devices.html#mac")), .devices)
        XCTAssertEqual(DashboardTab.of(URL(string: "https://h:8443/settings.html")), .settings)
        XCTAssertNil(DashboardTab.of(URL(string: "https://h:8443/other.html")))
    }

    func testProblemText() {
        XCTAssertNil(Problem.text(urlErrorCode: -999))
        XCTAssertEqual(Problem.text(urlErrorCode: -1001), "8초 안에 응답이 없어요")
        XCTAssertTrue(Problem.text(urlErrorCode: -1003)!.contains("Tailscale"))
        XCTAssertTrue(Problem.text(urlErrorCode: -1004)!.contains("Tailscale"))
        XCTAssertEqual(Problem.text(urlErrorCode: -42), "연결하지 못했어요 (오류 -42)")
        XCTAssertTrue(Problem.text(httpStatus: 502).hasPrefix("Portboard 서버가 응답하지 않아요 (HTTP 502)"))
        XCTAssertTrue(Problem.hint(base: base).contains("https://devbox.example.ts.net:8443"))
    }

    func testPollInterval() {
        XCTAssertEqual(Poll.interval(appActive: true, menuOpen: false, active: 30, background: 120), 30)
        XCTAssertEqual(Poll.interval(appActive: false, menuOpen: true, active: 30, background: 120), 30)
        XCTAssertEqual(Poll.interval(appActive: false, menuOpen: false, active: 30, background: 120), 120)
        // never faster in the background than in front, never under 10 s
        XCTAssertEqual(Poll.interval(appActive: false, menuOpen: false, active: 60, background: 15), 60)
        XCTAssertEqual(Poll.interval(appActive: true, menuOpen: false, active: 1, background: 120), 10)
        let now = Date()
        XCTAssertTrue(Poll.isStale(lastUpdate: nil, now: now, active: 30))
        XCTAssertTrue(Poll.isStale(lastUpdate: now.addingTimeInterval(-31), now: now, active: 30))
        XCTAssertFalse(Poll.isStale(lastUpdate: now.addingTimeInterval(-5), now: now, active: 30))
        XCTAssertEqual(Poll.label(30), "30초")
        XCTAssertEqual(Poll.label(120), "2분")
    }

    func testServicePort() {
        XCTAssertEqual(Server.servicePort(URL(string: "https://h:8443/service.html#3000")!), 3000)
        XCTAssertNil(Server.servicePort(URL(string: "https://h:8443/service.html")!))
        XCTAssertNil(Server.servicePort(URL(string: "https://h:8443/service.html#abc")!))
        XCTAssertNil(Server.servicePort(URL(string: "https://h:8443/devices.html#3000")!))
        XCTAssertEqual(Server.servicePort(path: "service.html#8790"), 8790)
        XCTAssertNil(Server.servicePort(path: "devices.html#mac"))
        XCTAssertNil(Server.servicePort(path: "service.html"))
    }
}
