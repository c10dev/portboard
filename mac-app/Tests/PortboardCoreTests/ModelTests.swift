import XCTest
@testable import PortboardCore

final class ModelTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    func testJSONKeepsBoolsAndNumbersApart() {
        let j = json(#"{"a": true, "b": 1, "c": 1.5, "d": "x", "e": null, "f": [1, "2"], "g": {"h": false}}"#)
        XCTAssertEqual(j["a"], .bool(true))
        XCTAssertEqual(j["b"].int, 1)
        XCTAssertNil(j["a"].int)
        XCTAssertNil(j["c"].int)
        XCTAssertEqual(j["c"].double, 1.5)
        XCTAssertEqual(j["d"].string, "x")
        XCTAssertTrue(j["e"].isNull)
        XCTAssertTrue(j["missing"]["deeper"].isNull)
        XCTAssertEqual(j["f"].array.count, 2)
        XCTAssertEqual(j["g"]["h"].bool, false)
        XCTAssertFalse(json(#""""#).truthy)
        XCTAssertTrue(json("0.5").truthy)
    }

    func testWhoAmI() {
        let w = WhoAmI(json(#"{"login": "owner@example.com", "source": "serve", "owner": true, "canWrite": true, "device": {"addr": "100.64.10.3", "name": "dev-mac"}}"#))
        XCTAssertEqual(w.lines, [
            "로그인: owner@example.com (serve)",
            "기기: dev-mac · 100.64.10.3",
            "쓰기: 가능 (서비스 멈춤·공개 같은 동작을 할 수 있어요)",
        ])
        let ro = WhoAmI(json(#"{"login": null, "source": "direct", "owner": false, "canWrite": false, "reason": "http 주소는 읽기 전용이에요"}"#))
        XCTAssertEqual(ro.lines, ["로그인: 없음 (direct)", "기기: 확인 못 함", "쓰기: 불가 — 읽기 전용 (http 주소는 읽기 전용이에요)"])
    }

    func testActionReply() {
        XCTAssertEqual(ActionReply(status: 200, body: json(#"{"ok": true, "message": "published"}"#)), ActionReply(status: 200, body: json(#"{"ok": true, "message": "published"}"#)))
        let ok = ActionReply(status: 200, body: json(#"{"ok": true, "message": "https://devbox.example.ts.net:5281/ 에 공개했어요"}"#))
        XCTAssertTrue(ok.ok)
        let conflict = ActionReply(status: 409, body: json(#"{"ok": false, "message": "nothing is listening on 1"}"#))
        XCTAssertFalse(conflict.ok)
        XCTAssertEqual(conflict.message, "nothing is listening on 1")
        let denied = ActionReply(status: 403, body: json(#"{"error": "owner only", "reason": "쓰기 허용 기기가 아니에요"}"#))
        XCTAssertEqual(denied.message, "owner only — 쓰기 허용 기기가 아니에요")
        let enable = ActionReply(status: 409, body: json(#"{"ok": false, "message": "Serve is off", "enableUrl": "https://login.tailscale.com/f/serve?node=x"}"#))
        XCTAssertEqual(enable.enableURL?.host, "login.tailscale.com")
        XCTAssertEqual(ActionReply(status: 500, body: .null).message, "HTTP 500")
    }

    func testOwnersWithoutCandidatesFallsBackToReasons() {
        let o = OwnersDoc(json(#"{"ports": [{"port": 9, "name": "x", "reasonText": ["작업 폴더 없음"]}, {"port": 8, "name": "y", "reasonText": []}]}"#))
        XCTAssertEqual(o.candidates.map(\.port), [9])
    }

    func testPortEntryRules() {
        let p = PortEntry(json(#"{"port": 5281, "scope": "loopback", "served": null, "urls": {"direct": "tcp://h:5281", "served": null}}"#))!
        XCTAssertTrue(p.listening)
        XCTAssertTrue(p.visible)
        XCTAssertTrue(p.isLocalOnly)
        XCTAssertNil(p.url)
        XCTAssertEqual(p.displayName, ":5281")
        XCTAssertNil(PortEntry(json(#"{"port": "5281"}"#)))
        XCTAssertFalse(PortEntry(json(#"{"port": 1, "listening": false}"#))!.listening)
    }
}
