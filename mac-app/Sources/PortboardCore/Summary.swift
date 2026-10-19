import Foundation

/// The documents one poll read. `ports` is required; the rest only add detail, and a failed one is listed in
/// `errors` (endpoint name → reason) and shown as a ⚠ line, like the SwiftBar plugin.
public struct Snapshot: Equatable, Sendable {
    public var ports: JSON
    public var usage: JSON?
    public var devices: JSON?
    public var alerts: JSON?
    public var owners: JSON?
    public var errors: [String: String]

    public init(ports: JSON, usage: JSON? = nil, devices: JSON? = nil, alerts: JSON? = nil, owners: JSON? = nil, errors: [String: String] = [:]) {
        self.ports = ports
        self.usage = usage
        self.devices = devices
        self.alerts = alerts
        self.owners = owners
        self.errors = errors
    }
}

/// A service someone is connected to right now
public struct InUseService: Equatable, Sendable {
    public let port: Int
    public let name: String
    public let url: URL?
    public let users: [PortUser]
    public var connections: Int { users.reduce(0) { $0 + $1.connections } }

    /// `name :port · who ×n, …`
    public var title: String {
        let who = users.map { "\($0.displayName)\($0.connections > 1 ? " ×\($0.connections)" : "")" }.joined(separator: ", ")
        return Fmt.menuText("\(name) :\(port) · \(who)")
    }
}

/// A ⚠ line: what is wrong and the dashboard page that shows it (relative to the server URL)
public struct Warning: Equatable, Sendable {
    public let text: String
    public let path: String
}

public enum Tone: String, Sendable { case ok, warn, bad, off }

/// The dashboard's compute-pool state table (public/devices.js POOL_STATE): label (an L10n key) and tone. Only
/// degraded and the bad states warn; agent-busy means the Mac is in use, which is normal.
public enum Pool {
    public static let states: [String: (key: String, tone: Tone)] = [
        "ok": ("mac.pool.ok", .ok),
        "degraded": ("mac.pool.degraded", .warn),
        "wsl-down": ("mac.pool.wslDown", .bad),
        "host-down": ("mac.pool.hostDown", .bad),
        "auth": ("mac.pool.auth", .bad),
        "agent-away": ("mac.pool.agentAway", .off),
        "agent-busy": ("mac.pool.agentBusy", .warn),
        "unknown": ("mac.pool.unknown", .off),
    ]
    static let warnStates: Set<String> = ["degraded", "wsl-down", "host-down", "auth"]

    public static func warns(_ p: PoolStatus?) -> Bool { p?.state.map(warnStates.contains) ?? false }
    /// The state's text; a state the table doesn't know is shown as it is
    public static func label(_ p: PoolStatus?) -> String {
        guard let state = p?.state else { return L10n.t("mac.pool.unknown") }
        return states[state].map { L10n.t($0.key) } ?? state
    }
}

public enum Summary {
    public static let dot: [Tone: String] = [.ok: "🟢", .warn: "🟡", .bad: "🔴", .off: "⚪"]

    public static func ports(_ doc: JSON) -> [PortEntry] { doc["ports"].array.compactMap(PortEntry.init) }

    /// Services in use: ports in the dashboard's default view (`visible`) that someone is connected to now
    /// (usage.byPort). usage has the short service name ("Syncthing"); a label still wins over it.
    public static func inUse(ports doc: JSON, usage: JSON?) -> [InUseService] {
        let usage = usage ?? .null
        let byPort = usage["byPort"].object ?? [:]
        var service: [Int: String] = [:]
        for u in usage["cards"].array.flatMap({ $0["uses"].array }) + usage["local"]["uses"].array {
            if let port = u["port"].int, let s = u["service"].text { service[port] = s }
        }
        return ports(doc).filter { $0.visible && $0.listening }.compactMap { p in
            let users = (byPort[String(p.port)] ?? .null).array
                .filter { $0.object != nil }
                .map(PortUser.init)
                .filter { $0.connections > 0 }
            guard !users.isEmpty else { return nil }
            let name = p.label != nil ? p.displayName : Fmt.shortName(service[p.port] ?? p.displayName)
            return InUseService(port: p.port, name: name, url: p.url, users: users)
        }
    }

    /// Pinned ports (what the API returns with pinned=true)
    public static func pinned(_ doc: JSON) -> [PortEntry] { ports(doc).filter(\.pinned) }

    /// Listening on loopback only, not served, in the default view: what "tailnet 공개" is for
    public static func localOnly(_ doc: JSON) -> [PortEntry] { ports(doc).filter(\.isLocalOnly) }

    /// Device cards from /api/usage (with uses[]) when it has them, else from /api/devices
    public static func cards(usage: JSON?, devices: JSON?) -> [DeviceCard] {
        if let usage, usage["cards"].isArray { return usage["cards"].array.compactMap { DeviceCard($0) } }
        return (devices ?? .null)["devices"].array.compactMap { DeviceCard($0, fromDevices: true) }
    }

    public static func tone(_ c: DeviceCard) -> Tone {
        if let p = c.pool { return p.state.flatMap { Pool.states[$0]?.tone } ?? .off }
        return c.online ? .ok : .off
    }

    static func cpuMem(_ p: PoolStatus) -> [String] {
        var bits: [String] = []
        if let cpu = p.cpuPct { bits.append("CPU \(Fmt.jsRound(cpu))%") }
        else if let load = p.load1, let cores = p.cores, cores != 0 { bits.append("load \(String(format: "%.1f", load))/\(Fmt.jsNumber(cores))") }
        if let total = p.memTotalMb, total != 0, let avail = p.memAvailMb { bits.append(L10n.t("mac.summary.memory", ["pct": Fmt.jsRound((1 - avail / total) * 100)])) }
        return bits
    }

    /// `🟢 name · status [· CPU · 메모리] [· 서비스 n]`
    public static func deviceTitle(_ c: DeviceCard) -> String {
        var bits = [c.isSelf ? "\(c.displayName) (\(L10n.t("common.thisServer")))" : c.displayName]
        if let p = c.pool { bits.append("pool \(Pool.label(p))"); bits += cpuMem(p) }
        else { bits.append(L10n.t(c.online ? "mac.summary.online" : "mac.summary.offline")) }
        if !c.uses.isEmpty { bits.append(L10n.t("mac.summary.services", ["n": c.uses.count])) }
        return Fmt.menuText("\(dot[tone(c)] ?? "⚪") \(bits.joined(separator: " · "))")
    }

    /// A service a device uses: `name :port [×n]`
    public static func useTitle(_ u: DeviceUse) -> String {
        Fmt.menuText("\(Fmt.shortName(u.service ?? u.fullName ?? "?")) :\(u.port)\(u.connections > 1 ? " ×\(u.connections)" : "")")
    }

    /// `📌 name :port · tailnet HTTPS | local only | 리스닝 | 리스닝 없음`
    public static func pinnedTitle(_ p: PortEntry) -> String {
        let state = !p.listening ? L10n.t("mac.summary.notListening") : p.served ? "tailnet HTTPS" : p.scope == "loopback" ? "local only" : L10n.t("mac.summary.listening")
        return Fmt.menuText("📌 \(p.displayName) :\(p.port) · \(state)")
    }

    /// Watched (🔔) ports and devices that are down now
    public static func down(_ alerts: JSON?) -> [WatchItem] {
        guard let alerts else { return [] }
        return (AlertsDoc(alerts).watching ?? []).filter(\.down)
    }

    public static func cleanup(_ owners: JSON?) -> [OwnedPort] {
        guard let owners else { return [] }
        return OwnersDoc(owners).candidates
    }

    /// `name :port — reason, reason`
    public static func cleanupTitle(_ o: OwnedPort) -> String {
        Fmt.menuText("\(o.name) :\(o.port)\(o.reasonText.isEmpty ? "" : " — \(o.reasonText.joined(separator: ", "))")")
    }

    /// The ⚠ lines: watched ports/devices down, compute-pool hosts in a bad state, pinned ports not listening, and
    /// endpoints that failed. The last three are format.mjs's warningsOf, in its order.
    public static func warnings(_ s: Snapshot) -> [Warning] {
        var bells: [Warning] = []
        for w in down(s.alerts) {
            if w.isPort, let port = w.port { bells.append(Warning(text: L10n.t("mac.summary.portDown", ["name": Fmt.shortName(w.name), "port": port]), path: "service.html#\(port)")) }
            else { bells.append(Warning(text: L10n.t("mac.summary.deviceOffline", ["name": Fmt.shortName(w.name)]), path: "devices.html#\(pathEscape(w.id ?? w.name))")) }
        }
        var out: [Warning] = []
        for c in cards(usage: s.usage, devices: s.devices) where Pool.warns(c.pool) {
            let who = c.pool?.name.flatMap { $0 != (c.name ?? c.id) ? "\(c.displayName) (pool \($0))" : nil } ?? c.displayName
            out.append(Warning(text: "compute-pool \(who): \(Pool.label(c.pool))", path: "devices.html#\(pathEscape(c.anchor))"))
        }
        for p in pinned(s.ports) where !p.listening {
            out.append(Warning(text: L10n.t("mac.summary.pinnedDown", ["port": p.port, "name": p.displayName]), path: ""))
        }
        for (what, err) in s.errors.sorted(by: { $0.key < $1.key }) where !err.isEmpty {
            out.append(Warning(text: L10n.t("mac.summary.readFailed", ["what": what, "error": err]), path: ""))
        }
        return bells.map { Warning(text: Fmt.menuText($0.text), path: $0.path) }
            + out.map { Warning(text: Fmt.menuText("⚠ \($0.text)"), path: $0.path) }
    }

    /// encodeURIComponent, for #anchors
    public static func pathEscape(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

/// What the menu bar item shows: the number of services in use, then counts for what needs a look.
public struct MenuStatus: Equatable, Sendable {
    /// nil while /api/usage is missing (`?`)
    public let inUse: Int?
    /// watched (🔔) ports that are down
    public let down: Int
    /// devices that need a look: compute-pool hosts in a bad state and watched devices that are offline
    public let devicesOff: Int
    /// leftover dev servers (/api/owners candidates)
    public let cleanup: Int
    /// any ⚠ line at all (also pinned ports not listening, failed endpoints)
    public let hasWarnings: Bool

    public init(_ s: Snapshot) {
        inUse = s.usage != nil && s.errors["usage"] == nil ? Summary.inUse(ports: s.ports, usage: s.usage).count : nil
        let downItems = Summary.down(s.alerts)
        down = downItems.filter(\.isPort).count
        var off = Set(downItems.filter { !$0.isPort }.map { ($0.id ?? $0.name).lowercased() })
        for c in Summary.cards(usage: s.usage, devices: s.devices) where Pool.warns(c.pool) { off.insert(c.anchor.lowercased()) }
        devicesOff = off.count
        cleanup = Summary.cleanup(s.owners).count
        hasWarnings = !Summary.warnings(s).isEmpty
    }

    /// `⇄ 3`, then `↓1` (watched ports down), `⚠2` (devices), `🧹1` (cleanup candidates)
    public var title: String {
        var parts = ["⇄ \(inUse.map(String.init) ?? "?")"]
        if down > 0 { parts.append("↓\(down)") }
        if devicesOff > 0 { parts.append("⚠\(devicesOff)") }
        if cleanup > 0 { parts.append("🧹\(cleanup)") }
        if hasWarnings && down == 0 && devicesOff == 0 { parts.append("⚠") }
        return parts.joined(separator: " ")
    }

    /// One-line explanation for the top of the menu, nil when all is well
    public var detail: String? {
        var bits: [String] = []
        if down > 0 { bits.append(L10n.t("mac.summary.watchedDown", ["n": down])) }
        if devicesOff > 0 { bits.append(L10n.t("mac.summary.devicesToCheck", ["n": devicesOff])) }
        if cleanup > 0 { bits.append(L10n.t("mac.summary.serversToClean", ["n": cleanup])) }
        return bits.isEmpty ? nil : bits.joined(separator: " · ")
    }

    public var needsAttention: Bool { down > 0 || devicesOff > 0 || hasWarnings }
}
