import Foundation

// Typed views of the API documents (docs/api.md), each read from `JSON` so a missing or odd field is just nil.
// Field rules follow menubar/format.mjs: `listening` and `visible` are true unless they are literally false,
// flags like `pinned` and `served` use JavaScript truthiness, ports must be whole numbers.

/// One entry of GET /api/ports `ports[]`
public struct PortEntry: Equatable, Sendable {
    public let port: Int
    public let listening: Bool
    public let visible: Bool
    public let pinned: Bool
    public let served: Bool
    public let alert: Bool
    public let scope: String?
    public let label: String?
    public let name: String?
    public let detectedName: String?
    public let servedURL: String?
    public let directURL: String?
    public let sshCommand: String?
    public let canExpose: Bool
    public let exposeBlocker: String?

    public init?(_ j: JSON) {
        guard let port = j["port"].int else { return nil }
        self.port = port
        listening = j["listening"] != .bool(false)
        visible = j["visible"] != .bool(false)
        pinned = j["pinned"].truthy
        served = j["served"].truthy
        alert = j["alert"].truthy
        scope = j["scope"].string
        label = j["label"].text
        name = j["name"].text
        detectedName = j["detectedName"].text
        servedURL = j["urls"]["served"].string
        directURL = j["urls"]["direct"].string
        sshCommand = j["urls"]["ssh"].text
        canExpose = j["canExpose"].truthy
        exposeBlocker = j["exposeBlocker"].string
    }

    /// label, else name, else the detected name, else `:port`; cut to fit a menu
    public var displayName: String { Fmt.shortName(label ?? name ?? detectedName ?? ":\(port)") }

    /// The served (tailnet HTTPS) URL, else the direct one; only http(s), since tcp:// opens nothing in a browser
    public var url: URL? { Fmt.webURL(servedURL) ?? Fmt.webURL(directURL) }

    public var isLocalOnly: Bool { listening && scope == "loopback" && !served && visible }
}

/// A device using a port right now: /api/usage `byPort[port][]`
public struct PortUser: Equatable, Sendable {
    public let id: String?
    public let name: String?
    public let connections: Int

    init(_ j: JSON) {
        id = j["id"].string
        name = j["name"].string
        connections = j["connections"].int ?? Int(j["connections"].double ?? 0)
    }

    public var displayName: String { name ?? id ?? "?" }
}

/// compute-pool's view of a host (`pool` on a device card)
public struct PoolStatus: Equatable, Sendable {
    public let name: String?
    public let state: String?
    public let detail: String?
    public let cpuPct: Double?
    public let load1: Double?
    public let cores: Double?
    public let memTotalMb: Double?
    public let memAvailMb: Double?

    init?(_ j: JSON) {
        guard j.truthy, j.object != nil else { return nil }
        name = j["name"].text
        state = j["state"].string
        detail = j["detail"].text
        cpuPct = j["cpuPct"].double
        load1 = j["load1"].double
        cores = j["cores"].double
        memTotalMb = j["memTotalMb"].double
        memAvailMb = j["memAvailMb"].double
    }
}

/// A service a device uses (`uses[]` on a usage card)
public struct DeviceUse: Equatable, Sendable {
    public let port: Int
    public let service: String?
    public let fullName: String?
    public let url: URL?
    public let connections: Int

    init?(_ j: JSON) {
        guard let port = j["port"].int else { return nil }
        self.port = port
        service = j["service"].string
        fullName = j["fullName"].string
        url = Fmt.webURL(j["url"].string)
        connections = j["connections"].int ?? 0
    }
}

/// A device card: /api/usage `cards[]`, or /api/devices `devices[]` when usage failed
public struct DeviceCard: Equatable, Sendable {
    public let id: String?
    public let name: String?
    public let isSelf: Bool
    public let online: Bool
    public let pool: PoolStatus?
    public let uses: [DeviceUse]

    init?(_ j: JSON, fromDevices: Bool = false) {
        guard j.object != nil, j["id"].truthy || j["name"].truthy else { return nil }
        id = j["id"].string
        name = j["name"].string
        isSelf = fromDevices ? j["self"].truthy : (j["kind"].string == "self" || j["self"].truthy)
        online = j["online"].truthy
        pool = PoolStatus(j["pool"])
        uses = fromDevices ? [] : j["uses"].array.compactMap(DeviceUse.init)
    }

    public var displayName: String { name ?? id ?? "?" }
    /// The id the 기기 tab anchors to (devices.html#<id>)
    public var anchor: String { id ?? name ?? "" }
}

/// A watched (🔔) port or device: /api/alerts `watching[]`
public struct WatchItem: Equatable, Sendable {
    public let key: String
    public let kind: String
    public let port: Int?
    public let id: String?
    public let name: String
    public let down: Bool
    public let since: String?

    public init?(_ j: JSON) {
        guard let key = j["key"].text else { return nil }
        self.key = key
        kind = j["kind"].string ?? "port"
        port = j["port"].int
        id = j["id"].string
        name = j["name"].text ?? (j["port"].int.map { ":\($0)" } ?? key)
        down = j["down"].truthy
        since = j["since"].string
    }

    public var isPort: Bool { kind == "port" }
}

/// GET /api/alerts
public struct AlertsDoc: Equatable, Sendable {
    public let channelConfigured: Bool
    public let channelKinds: [String]
    /// nil when the document had no `watching` array (an older or broken answer): nothing is known then
    public let watching: [WatchItem]?

    public init(_ j: JSON) {
        channelConfigured = j["channel"]["configured"].truthy
        channelKinds = j["channel"]["kinds"].array.compactMap(\.string)
        watching = j["watching"].isArray ? j["watching"].array.compactMap(WatchItem.init) : nil
    }
}

/// A plain-process server and why it is a cleanup candidate: /api/owners `ports[]`
public struct OwnedPort: Equatable, Sendable {
    public let port: Int
    public let name: String
    public let reasonText: [String]
    public let branch: String?

    init?(_ j: JSON) {
        guard let port = j["port"].int else { return nil }
        self.port = port
        name = Fmt.shortName(j["name"].text ?? ":\(port)")
        let texts = j["reasonText"].array.compactMap(\.text)
        reasonText = texts.isEmpty ? j["reasons"].array.compactMap(\.text) : texts
        branch = j["owner"]["worktree"]["branch"].text
    }
}

/// GET /api/owners → the cleanup candidates, in port order
public struct OwnersDoc: Equatable, Sendable {
    public let candidates: [OwnedPort]

    public init(_ j: JSON) {
        let listed = Set(j["candidates"].array.compactMap(\.int))
        let ports = j["ports"].array.compactMap(OwnedPort.init)
        // `candidates` is authoritative; an answer without it falls back to ports with reasons
        candidates = (j["candidates"].isArray ? ports.filter { listed.contains($0.port) } : ports.filter { !$0.reasonText.isEmpty })
            .sorted { $0.port < $1.port }
    }
}

/// A pending new device: /api/usage `newDevices.pending[]` (the same list as /api/known-devices)
public struct NewDevice: Equatable, Sendable {
    public let key: String
    public let name: String
    public let kind: String?
    public let scope: String?
    public let cardId: String?
    public let servicePort: Int?
    public let serviceName: String?

    public init?(_ j: JSON) {
        guard let key = j["key"].text else { return nil }
        self.key = key
        name = j["name"].text ?? key
        kind = j["kind"].string
        scope = j["scope"].string
        cardId = j["cardId"].text
        servicePort = j["service"]["port"].int
        serviceName = j["service"]["name"].text
    }
}

/// GET /api/whoami
public struct WhoAmI: Equatable, Sendable {
    public let login: String?
    public let source: String?
    public let owner: Bool
    public let canWrite: Bool
    public let reason: String?
    public let deviceName: String?
    public let deviceAddr: String?

    public init(_ j: JSON) {
        login = j["login"].text
        source = j["source"].string
        owner = j["owner"].truthy
        canWrite = j["canWrite"].truthy
        reason = j["reason"].text
        deviceName = j["device"]["name"].text
        deviceAddr = j["device"]["addr"].text
    }

    /// Lines for the 연결 확인 result in the settings window
    public var lines: [String] {
        var out = ["로그인: \(login ?? "없음")\(source.map { " (\($0))" } ?? "")"]
        if let deviceName { out.append("기기: \(deviceName)\(deviceAddr.map { " · \($0)" } ?? "")") }
        else if let deviceAddr { out.append("기기: \(deviceAddr)") }
        else { out.append("기기: 확인 못 함") }
        out.append(canWrite ? "쓰기: 가능 (서비스 멈춤·공개 같은 동작을 할 수 있어요)" : "쓰기: 불가 — 읽기 전용\(reason.map { " (\($0))" } ?? "")")
        return out
    }
}

/// Result of a POST action (expose): `{ok, message, enableUrl?}`, or `{error, reason}` when refused
public struct ActionReply: Equatable, Sendable {
    public let ok: Bool
    public let message: String
    public let enableURL: URL?

    public init(status: Int, body: JSON) {
        ok = (200..<300).contains(status) && body["ok"] != .bool(false)
        let msg = body["message"].text ?? body["error"].text ?? "HTTP \(status)"
        message = body["reason"].text.map { "\(msg) — \($0)" } ?? msg
        enableURL = Fmt.webURL(body["enableUrl"].string)
    }
}
