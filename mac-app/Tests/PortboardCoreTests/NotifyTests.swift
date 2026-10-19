import XCTest
@testable import PortboardCore

final class NotifyTests: XCTestCase {
    func watch(_ key: String, port: Int, down: Bool) -> WatchItem {
        WatchItem(json(#"{"key": "\#(key)", "kind": "port", "port": \#(port), "name": "svc\#(port)", "down": \#(down)}"#))!
    }

    func device(_ key: String, port: Int? = nil) -> NewDevice {
        let service = port.map { #", "service": {"port": \#($0), "name": "Syncthing"}"# } ?? ""
        return NewDevice(json(#"{"key": "\#(key)", "name": "기기 \#(key)", "kind": "lan", "scope": "connection", "cardId": "lan:\#(key)"\#(service)}"#))!
    }

    func testFirstLookOnlyRecords() {
        let (events, next) = Notify.diff(previous: NotifyState(), watching: [watch("port:1", port: 1, down: true)], newDevices: [device("a")])
        XCTAssertEqual(events, [])
        XCTAssertEqual(next, NotifyState(down: ["port:1"], newDevices: ["a"]))
    }

    func testDownThenBackThenNothingTwice() {
        var state = NotifyState(down: [], newDevices: [])
        var r = Notify.diff(previous: state, watching: [watch("port:1", port: 1, down: true), watch("port:2", port: 2, down: false)], newDevices: [])
        XCTAssertEqual(r.events.map(\.kind), [.down])
        XCTAssertEqual(r.events[0].title, "🔔 svc1 응답 없음")
        XCTAssertEqual(r.events[0].path, "service.html#1")
        state = r.next
        // still down: nothing new
        r = Notify.diff(previous: state, watching: [watch("port:1", port: 1, down: true)], newDevices: [])
        XCTAssertEqual(r.events, [])
        state = r.next
        r = Notify.diff(previous: state, watching: [watch("port:1", port: 1, down: false)], newDevices: [])
        XCTAssertEqual(r.events.map(\.kind), [.recovered])
        XCTAssertEqual(r.events[0].title, "✅ svc1 복구")
        XCTAssertEqual(r.events[0].id, "watch-port:1") // replaces the down banner
        XCTAssertEqual(r.next.down, [])
    }

    func testRestartDoesNotNotifyAgain() {
        let first = Notify.diff(previous: NotifyState(down: [], newDevices: []), watching: [watch("port:1", port: 1, down: true)], newDevices: [device("a")])
        XCTAssertEqual(first.events.count, 2)
        // the app restarts: state comes back from UserDefaults
        let saved = NotifyState.decode(first.next.encoded())
        XCTAssertEqual(saved, first.next)
        let again = Notify.diff(previous: saved, watching: [watch("port:1", port: 1, down: true)], newDevices: [device("a")])
        XCTAssertEqual(again.events, [])
    }

    func testFailedPollKeepsState() {
        let state = NotifyState(down: ["port:1"], newDevices: ["a"])
        let r = Notify.diff(previous: state, watching: nil, newDevices: nil)
        XCTAssertEqual(r.events, [])
        XCTAssertEqual(r.next, state)
        // it comes back still down: no repeat
        XCTAssertEqual(Notify.diff(previous: r.next, watching: [watch("port:1", port: 1, down: true)], newDevices: ["a"].map { device($0) }).events, [])
    }

    func testUnwatchedPortDropsOutQuietly() {
        let r = Notify.diff(previous: NotifyState(down: ["port:1"], newDevices: []), watching: [], newDevices: [])
        XCTAssertEqual(r.events, [])
        XCTAssertEqual(r.next.down, [])
    }

    func testNewDevice() {
        let r = Notify.diff(previous: NotifyState(down: [], newDevices: ["a"]), watching: [], newDevices: [device("a"), device("b", port: 22000)])
        XCTAssertEqual(r.events.count, 1)
        XCTAssertEqual(r.events[0].kind, .newDevice)
        XCTAssertEqual(r.events[0].title, "새 기기: 기기 b")
        XCTAssertEqual(r.events[0].body, "Syncthing :22000에 처음 연결했어요")
        XCTAssertEqual(r.events[0].path, "devices.html#lan%3Ab")
        XCTAssertEqual(r.next.newDevices, ["a", "b"])
    }

    func testWatchedDeviceOffline() {
        let w = WatchItem(json(#"{"key": "device:mac", "kind": "device", "id": "dev-mac", "name": "Mac", "down": true}"#))!
        let r = Notify.diff(previous: NotifyState(down: [], newDevices: []), watching: [w], newDevices: nil)
        XCTAssertEqual(r.events.map(\.title), ["🔔 Mac 오프라인"])
        XCTAssertEqual(r.events[0].path, "devices.html#dev-mac")
        XCTAssertEqual(r.next.newDevices, []) // kept: usage was not read
    }

    func testDefaultIsOffWhenNtfyCoversIt() {
        XCTAssertFalse(Notify.defaultEnabled(AlertsDoc(json(#"{"channel": {"configured": true, "kinds": ["ntfy"]}, "watching": []}"#))))
        XCTAssertTrue(Notify.defaultEnabled(AlertsDoc(json(#"{"channel": {"configured": true, "kinds": ["webhook"]}, "watching": []}"#))))
        XCTAssertTrue(Notify.defaultEnabled(AlertsDoc(json(#"{"channel": {"configured": false, "kinds": []}}"#))))
        XCTAssertNil(AlertsDoc(json("{}")).watching)
    }

    func testLevelAndThread() {
        let r = Notify.diff(previous: NotifyState(down: [], newDevices: []), watching: [watch("port:3000", port: 3000, down: true)], newDevices: [device("a")])
        let down = r.events[0], new = r.events[1]
        XCTAssertEqual(down.level, .timeSensitive)
        XCTAssertEqual(down.thread, "watch-port:3000")
        XCTAssertEqual(down.port, 3000)
        XCTAssertEqual(new.level, .active)
        XCTAssertEqual(new.thread, "new-devices")
        XCTAssertNil(new.port)
        let back = Notify.diff(previous: r.next, watching: [watch("port:3000", port: 3000, down: false)], newDevices: nil).events[0]
        XCTAssertEqual(back.level, .passive)
        XCTAssertEqual(back.thread, down.thread) // one thread per port
        let other = Notify.diff(previous: NotifyState(down: [], newDevices: []), watching: [watch("port:8790", port: 8790, down: true)], newDevices: nil).events[0]
        XCTAssertNotEqual(other.thread, down.thread)
        let dev = WatchItem(json(#"{"key": "device:mac", "kind": "device", "id": "mac", "name": "Mac", "down": true}"#))!
        let off = Notify.diff(previous: NotifyState(down: []), watching: [dev], newDevices: nil).events[0]
        XCTAssertEqual(off.level, .timeSensitive)
        XCTAssertNil(off.port)
    }

    func testNoBannerForThePortInFront() {
        let base = URL(string: Server.defaultURL)!
        let page = URL(string: "\(Server.defaultURL)/service.html#3000")!
        XCTAssertEqual(Notify.viewingPort(page: page, base: base, keyWindow: true), 3000)
        XCTAssertNil(Notify.viewingPort(page: page, base: base, keyWindow: false)) // window not key, app behind
        XCTAssertNil(Notify.viewingPort(page: URL(string: "\(Server.defaultURL)/")!, base: base, keyWindow: true))
        XCTAssertNil(Notify.viewingPort(page: URL(string: "https://elsewhere.ts.net:8443/service.html#3000")!, base: base, keyWindow: true))
        XCTAssertNil(Notify.viewingPort(page: nil, base: base, keyWindow: true))

        let down = Notify.diff(previous: NotifyState(down: [], newDevices: []), watching: [watch("port:3000", port: 3000, down: true)], newDevices: [device("a")])
        XCTAssertTrue(Notify.suppressed(down.events[0], viewingPort: 3000))
        XCTAssertFalse(Notify.suppressed(down.events[0], viewingPort: 3001))
        XCTAssertFalse(Notify.suppressed(down.events[0], viewingPort: nil))
        XCTAssertFalse(Notify.suppressed(down.events[1], viewingPort: 3000)) // a new device is not a port page
        // suppressed or not, the state moves on: nothing comes later when you leave the page
        XCTAssertEqual(Notify.diff(previous: down.next, watching: [watch("port:3000", port: 3000, down: true)], newDevices: [device("a")]).events, [])
    }

    func testBadgeCountsWatchedPortsDown() {
        let alerts = AlertsDoc(json(#"{"watching": [{"key": "port:1", "kind": "port", "port": 1, "down": true}, {"key": "port:2", "kind": "port", "port": 2, "down": false}, {"key": "device:mac", "kind": "device", "id": "mac", "down": true}]}"#))
        XCTAssertEqual(Notify.badge(alerts: alerts, previous: 0), 1) // the offline device is not counted
        XCTAssertEqual(Notify.badge(alerts: AlertsDoc(json(#"{"watching": []}"#)), previous: 4), 0)
        // /api/alerts failed or had no list: keep the last count
        XCTAssertEqual(Notify.badge(alerts: nil, previous: 2), 2)
        XCTAssertEqual(Notify.badge(alerts: AlertsDoc(json("{}")), previous: 2), 2)
    }
}
