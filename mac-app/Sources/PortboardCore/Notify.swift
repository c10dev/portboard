import Foundation

/// A native notification to show
public struct NotifyEvent: Equatable, Sendable {
    // HOOK(new-ports): GET /api/new-ports (the port-rules branch) is not on main yet. When it lands, add a kind here,
    // its event in Notify.diff (like newDevices), and its level and thread below.
    public enum Kind: String, Sendable { case down, recovered, newDevice }
    /// How loudly macOS shows it (UNNotificationInterruptionLevel, mapped in Notifier.swift)
    public enum Level: String, Sendable { case passive, active, timeSensitive }
    public let kind: Kind
    /// Stable per subject, so a repeat replaces the earlier banner instead of stacking
    public let id: String
    public let title: String
    public let body: String
    /// The dashboard page to open when it is clicked (relative to the server URL)
    public let path: String

    /// 다운 breaks through Focus (time-sensitive), 복구 goes quietly to the list (passive), a new device is normal
    public var level: Level {
        switch kind {
        case .down: return .timeSensitive
        case .recovered: return .passive
        case .newDevice: return .active
        }
    }

    /// One Notification Center group per watched port or device (the same as `id`), one for all new devices
    public var thread: String { kind == .newDevice ? "new-devices" : id }

    /// The port it is about (from its service.html#<port> page); nil for devices
    public var port: Int? { kind == .newDevice ? nil : Server.servicePort(path: path) }
}

/// What was last seen, persisted (UserDefaults) so a restart of the app does not notify again for the same state.
/// nil means "never seen": the first look only records, it never notifies.
public struct NotifyState: Codable, Equatable, Sendable {
    /// keys of watched ports/devices that were down
    public var down: [String]?
    /// keys of new devices already announced
    public var newDevices: [String]?

    public init(down: [String]? = nil, newDevices: [String]? = nil) {
        self.down = down
        self.newDevices = newDevices
    }

    public func encoded() -> Data? { try? JSONEncoder().encode(self) }
    public static func decode(_ data: Data?) -> NotifyState {
        data.flatMap { try? JSONDecoder().decode(NotifyState.self, from: $0) } ?? NotifyState()
    }
}

public enum Notify {
    /// Compare the last seen state with this poll's. `watching` / `newDevices` are nil when that endpoint failed or
    /// had no list: that part of the state is kept as it was, so a failed poll neither notifies nor forgets.
    /// Events come back even when a toggle is off; the caller filters, and always saves `next`, so turning a toggle
    /// on later does not replay old changes.
    public static func diff(previous: NotifyState, watching: [WatchItem]?, newDevices: [NewDevice]?) -> (events: [NotifyEvent], next: NotifyState) {
        var events: [NotifyEvent] = []
        var next = previous

        if let watching {
            let nowDown = watching.filter(\.down)
            if let before = previous.down.map(Set.init) {
                for w in nowDown where !before.contains(w.key) { events.append(downEvent(w)) }
                // came back: was down, still watched, not down now (an item no longer watched just drops out)
                for w in watching where !w.down && before.contains(w.key) { events.append(recoveredEvent(w)) }
            }
            next.down = nowDown.map(\.key).sorted()
        }

        if let newDevices {
            if let seen = previous.newDevices.map(Set.init) {
                for d in newDevices where !seen.contains(d.key) { events.append(newDeviceEvent(d)) }
            }
            // The pending list itself: once a device is acknowledged in the dashboard it is known and never pending again
            next.newDevices = Array(Set(newDevices.map(\.key))).sorted()
        }
        return (events, next)
    }

    static func downEvent(_ w: WatchItem) -> NotifyEvent {
        if w.isPort, let port = w.port {
            return NotifyEvent(kind: .down, id: "watch-\(w.key)", title: "🔔 \(Fmt.shortName(w.name)) 응답 없음", body: ":\(port)이(가) 응답하지 않아요", path: "service.html#\(port)")
        }
        return NotifyEvent(kind: .down, id: "watch-\(w.key)", title: "🔔 \(Fmt.shortName(w.name)) 오프라인", body: "감시 중인 기기가 tailnet에서 사라졌어요", path: "devices.html#\(Summary.pathEscape(w.id ?? w.name))")
    }

    static func recoveredEvent(_ w: WatchItem) -> NotifyEvent {
        if w.isPort, let port = w.port {
            return NotifyEvent(kind: .recovered, id: "watch-\(w.key)", title: "✅ \(Fmt.shortName(w.name)) 복구", body: ":\(port)이(가) 다시 응답해요", path: "service.html#\(port)")
        }
        return NotifyEvent(kind: .recovered, id: "watch-\(w.key)", title: "✅ \(Fmt.shortName(w.name)) 온라인", body: "감시 중인 기기가 다시 연결됐어요", path: "devices.html#\(Summary.pathEscape(w.id ?? w.name))")
    }

    static func newDeviceEvent(_ d: NewDevice) -> NotifyEvent {
        let body: String
        if let port = d.servicePort { body = "\(d.serviceName.map { "\(Fmt.shortName($0)) " } ?? ""):\(port)에 처음 연결했어요" }
        else if d.scope == "neighbor" { body = "LAN에서 처음 보였어요" }
        else { body = "처음 보는 기기예요" }
        let anchor = d.cardId.map { "#\(Summary.pathEscape($0))" } ?? ""
        return NotifyEvent(kind: .newDevice, id: "new-\(d.key)", title: "새 기기: \(Fmt.shortName(d.name))", body: body, path: "devices.html\(anchor)")
    }

    /// The port whose page is in front: the window is key in the active app and shows the dashboard's
    /// service.html#<port>. nil otherwise.
    public static func viewingPort(page: URL?, base: URL, keyWindow: Bool) -> Int? {
        guard keyWindow, let page, Server.isDashboard(page, base: base) else { return nil }
        return Server.servicePort(page)
    }

    /// No banner for a port whose page you are looking at. The state is still saved, so it does not come later.
    public static func suppressed(_ e: NotifyEvent, viewingPort: Int?) -> Bool {
        guard let viewingPort, let port = e.port else { return false }
        return port == viewingPort
    }

    /// The Dock badge: only what waits on you, the watched (🔔) ports that are down. When /api/alerts could not be
    /// read the last count stays.
    public static func badge(alerts: AlertsDoc?, previous: Int) -> Int {
        guard let watching = alerts?.watching else { return previous }
        return watching.filter { $0.isPort && $0.down }.count
    }

    /// The default for native notifications, decided once from /api/alerts: off when ntfy already sends the same
    /// down and new-device alerts (to the phone too), on otherwise.
    public static func defaultEnabled(_ alerts: AlertsDoc) -> Bool {
        !(alerts.channelConfigured && alerts.channelKinds.contains("ntfy"))
    }
}
