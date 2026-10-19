import XCTest
@testable import PortboardCore

// The same cases as test/menubar.test.ts (the SwiftBar plugin), on the same fixtures: the app's menu must agree.
final class SummaryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    func testLiveFixturesInUseAndTitle() {
        let s = Fixture.live()
        let used = Summary.inUse(ports: s.ports, usage: s.usage)
        XCTAssertEqual(used.map(\.port), [7721, 8790, 22000])
        // short service names from usage, not the long page titles
        XCTAssertEqual(used.map(\.name), ["compute-pool monitor", "Portboard", "Syncthing"])
        XCTAssertEqual(Summary.warnings(s), [])
        let status = MenuStatus(s)
        XCTAssertEqual(status.title, "⇄ 3")
        XCTAssertFalse(status.needsAttention)
        XCTAssertNil(status.detail)
    }

    func testDeviceTitles() {
        let s = Fixture.live()
        let titles = Summary.cards(usage: s.usage, devices: s.devices).map(Summary.deviceTitle)
        XCTAssertTrue(titles.contains("🟡 dev-mac · pool 사용 중 · load 5.3/10 · 서비스 2"), "\(titles)")
        XCTAssertTrue(titles.contains("🟢 devbox (이 서버) · pool 정상 · CPU 5% · 메모리 53%"))
        XCTAssertTrue(titles.contains("🟢 desktop-pc · pool 정상 · CPU 0% · 메모리 9% · 서비스 1"))
        XCTAssertTrue(titles.contains("⚪ docker-vm · 오프라인"))
        XCTAssertTrue(titles.contains("🟢 nas · 온라인 · 서비스 1"))
    }

    func testDeviceUses() {
        let s = Fixture.live()
        let cards = Summary.cards(usage: s.usage, devices: s.devices)
        let nas = cards.first { $0.id == "nas" }!
        XCTAssertEqual(nas.uses.map(Summary.useTitle), ["Syncthing :22000"])
        XCTAssertNil(nas.uses[0].url) // tcp:// is not clickable
        XCTAssertEqual(nas.anchor, "nas")
        let all = cards.flatMap(\.uses).map(Summary.useTitle)
        XCTAssertTrue(all.contains("Portboard :8790 ×2"))
    }

    func testInUseRows() {
        let s = Fixture.live()
        let rows = Summary.inUse(ports: s.ports, usage: s.usage)
        XCTAssertEqual(rows.map(\.title), [
            "compute-pool monitor :7721 · dev-mac",
            "Portboard :8790 · tailscale serve · 기기 미확인 ×2",
            "Syncthing :22000 · nas",
        ])
        XCTAssertEqual(rows[1].url?.absoluteString.hasPrefix("https://"), true)
        XCTAssertNil(rows[2].url) // tcp:// gets no link
    }

    func testPoolHostDownWarns() {
        var s = Fixture.live()
        s.usage = withPoolState(s.usage!, card: "desktop-pc", "host-down")
        let w = Summary.warnings(s)
        XCTAssertEqual(w.first, Warning(text: "⚠ compute-pool desktop-pc (pool desktop): 응답 없음", path: "devices.html#desktop-pc"))
        let status = MenuStatus(s)
        XCTAssertEqual(status.devicesOff, 1)
        XCTAssertEqual(status.title, "⇄ 3 ⚠1")
        XCTAssertTrue(Summary.cards(usage: s.usage, devices: nil).map(Summary.deviceTitle).contains { $0.hasPrefix("🔴 desktop-pc · pool 응답 없음") })
        for state in ["wsl-down", "auth", "degraded"] {
            s.usage = withPoolState(s.usage!, card: "desktop-pc", state)
            XCTAssertTrue(MenuStatus(s).needsAttention, state)
        }
        for state in ["ok", "agent-busy", "agent-away", "unknown"] {
            s.usage = withPoolState(s.usage!, card: "desktop-pc", state)
            XCTAssertFalse(MenuStatus(s).needsAttention, state)
        }
    }

    func testPinned() {
        var s = Fixture.live()
        XCTAssertEqual(Summary.pinned(s.ports), [])
        s.ports = withPort(s.ports, 8790) { $0.setting("pinned", .bool(true)) }
        s.ports = s.ports.appending("ports", json(#"{"port": 3001, "listening": false, "pinned": true, "visible": true, "name": "실험 | 서버", "urls": {"direct": null, "served": null}}"#))
        let pinned = Summary.pinned(s.ports)
        XCTAssertEqual(pinned.count, 2)
        XCTAssertTrue(Summary.pinnedTitle(pinned[0]).hasPrefix("📌 Portboard"))
        XCTAssertTrue(Summary.pinnedTitle(pinned[0]).hasSuffix(":8790 · tailnet HTTPS"))
        XCTAssertEqual(Summary.pinnedTitle(pinned[1]), "📌 실험 | 서버 :3001 · 리스닝 없음")
        XCTAssertTrue(Summary.warnings(s).contains(Warning(text: "⚠ 고정한 포트 :3001 실험 | 서버 리스닝 없음", path: "")))
        XCTAssertEqual(MenuStatus(s).title, "⇄ 3 ⚠")
    }

    func testLocalOnly() {
        var s = Fixture.live()
        XCTAssertEqual(Summary.localOnly(s.ports).map(\.port), [3080, 5281, 7720, 8080, 8384, 18080])
        let shop = Summary.localOnly(s.ports).first { $0.port == 5281 }!
        XCTAssertEqual(shop.displayName, "ShopSim")
        XCTAssertTrue(shop.canExpose)
        XCTAssertEqual(shop.sshCommand, "ssh -N -L 5281:127.0.0.1:5281 dev@devbox")
        s.ports = withPort(s.ports, 5281) { $0.setting("canExpose", .bool(false)).setting("exposeBlocker", .string("not an HTTP server")) }
        let after = Summary.localOnly(s.ports).first { $0.port == 5281 }!
        XCTAssertFalse(after.canExpose)
        XCTAssertEqual(after.exposeBlocker, "not an HTTP server")
    }

    func testTextIsOneLineAndCut() {
        XCTAssertEqual(Fmt.menuText("MCC 대기 | merge\n두 줄"), "MCC 대기 | merge 두 줄")
        XCTAssertEqual(Fmt.menuText(String(repeating: "가", count: 300)).count, 110)
        XCTAssertEqual(Fmt.shortName(String(repeating: "a", count: 50)), String(repeating: "a", count: 41) + "…")
        var s = Fixture.live()
        s.ports = withPort(s.ports, 8790) { $0.setting("label", .string("포트보드 | 대시보드")) }
        XCTAssertTrue(Summary.inUse(ports: s.ports, usage: s.usage).map(\.title).contains("포트보드 | 대시보드 :8790 · tailscale serve · 기기 미확인 ×2"))
    }

    func testPartialFailureUsageDown() {
        var s = Fixture.live()
        s.usage = nil
        s.errors = ["usage": "ECONNRESET"]
        let status = MenuStatus(s)
        XCTAssertNil(status.inUse)
        XCTAssertEqual(status.title, "⇄ ? ⚠")
        XCTAssertEqual(Summary.warnings(s).first, Warning(text: "⚠ /api/usage 읽기 실패: ECONNRESET", path: ""))
        let cards = Summary.cards(usage: nil, devices: s.devices)
        XCTAssertEqual(cards.count, 8)
        XCTAssertTrue(cards.map(Summary.deviceTitle).contains { $0.hasPrefix("🟢 devbox (이 서버) · pool 정상") })
    }

    func testOddDocumentsNeverFail() {
        let odd: [(String, String, String)] = [
            ("{}", "{}", "{}"),
            ("null", "null", "null"),
            (#"{"ports": [{"port": 1}, null, {"port": "x"}, {"port": 1.5}]}"#,
             #"{"byPort": {"1": [{"name": "a", "connections": 2}, null, "x"]}, "cards": [{"id": "z", "uses": [{"port": 1}], "pool": {"state": "new-state", "newField": 1}}]}"#,
             #"{"devices": "nope"}"#),
            (#"{"ports": [{"port": 9, "pinned": true, "listening": true, "futureFlag": {"alert": true}}]}"#, #"{"cards": null, "byPort": null}"#, "null"),
        ]
        for (p, u, d) in odd {
            let s = Snapshot(ports: json(p), usage: json(u), devices: json(d), alerts: json(u), owners: json(d))
            XCTAssertTrue(MenuStatus(s).title.hasPrefix("⇄"))
            _ = Summary.warnings(s)
            _ = Summary.cards(usage: s.usage, devices: s.devices).map(Summary.deviceTitle)
            _ = Summary.localOnly(s.ports)
        }
        let third = Snapshot(ports: json(odd[2].0), usage: json(odd[2].1), devices: json(odd[2].2))
        XCTAssertEqual(MenuStatus(third).title, "⇄ 1")
        XCTAssertEqual(Summary.ports(third.ports).map(\.port), [1])
        XCTAssertEqual(Summary.cards(usage: third.usage, devices: nil).map(Summary.deviceTitle), ["⚪ z · pool new-state · 서비스 1"])
    }

    func testDownWatchesAndCleanupInTheStatus() {
        var s = Fixture.live()
        s.alerts = json(#"""
        {"channel": {"configured": true, "kinds": ["ntfy"]}, "watching": [
          {"key": "port:3000", "kind": "port", "port": 3000, "name": "webapp", "down": true, "since": "2026-10-18T10:00:00Z"},
          {"key": "port:8790", "kind": "port", "port": 8790, "name": "Portboard", "down": false},
          {"key": "device:desktop-pc", "kind": "device", "id": "desktop-pc", "name": "desktop-pc", "down": true}
        ]}
        """#)
        s.owners = json(#"{"ports": [{"port": 5281, "name": "ShopSim", "reasons": ["branch-merged"], "reasonText": ["브랜치 머지됨"]}, {"port": 3000, "name": "next", "reasons": [], "reasonText": []}], "candidates": [5281]}"#)
        // the same device also in a bad pool state counts once
        s.usage = withPoolState(s.usage!, card: "desktop-pc", "host-down")
        let status = MenuStatus(s)
        XCTAssertEqual(status.down, 1)
        XCTAssertEqual(status.devicesOff, 1)
        XCTAssertEqual(status.cleanup, 1)
        XCTAssertEqual(status.title, "⇄ 3 ↓1 ⚠1 🧹1")
        XCTAssertEqual(status.detail, "감시 중인 포트 1개 응답 없음 · 확인할 기기 1대 · 정리할 서버 1개")
        let w = Summary.warnings(s)
        XCTAssertEqual(w[0], Warning(text: "🔔 webapp :3000 응답 없음", path: "service.html#3000"))
        XCTAssertEqual(w[1], Warning(text: "🔔 desktop-pc 오프라인", path: "devices.html#desktop-pc"))
        XCTAssertEqual(Summary.cleanup(s.owners).map(Summary.cleanupTitle), ["ShopSim :5281 — 브랜치 머지됨"])
    }
}
