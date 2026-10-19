import Foundation
@testable import PortboardCore

/// The SwiftBar plugin's fixtures (menubar/fixtures), captured from the live API. Found relative to this file, so no
/// resource bundle is needed and the tests run the same on macOS and in the Linux swift image.
enum Fixture {
    static let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // PortboardCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // mac-app
        .deletingLastPathComponent() // repository
        .appendingPathComponent("menubar/fixtures")

    static func load(_ name: String) -> JSON {
        let data = try! Data(contentsOf: dir.appendingPathComponent("\(name).json"))
        return try! JSON.parse(data)
    }

    static func live() -> Snapshot {
        Snapshot(ports: load("ports"), usage: load("usage"), devices: load("devices"))
    }
}

func json(_ s: String) -> JSON { try! JSON.parse(Data(s.utf8)) }

extension JSON {
    func setting(_ key: String, _ v: JSON) -> JSON {
        guard case .object(var o) = self else { return self }
        o[key] = v
        return .object(o)
    }

    func mapArray(_ key: String, _ f: (JSON) -> JSON) -> JSON {
        setting(key, .array(self[key].array.map(f)))
    }

    func appending(_ key: String, _ v: JSON) -> JSON {
        setting(key, .array(self[key].array + [v]))
    }
}

/// usage with one card's pool state changed
func withPoolState(_ usage: JSON, card id: String, _ state: String) -> JSON {
    usage.mapArray("cards") { c in
        c["id"] == .string(id) ? c.setting("pool", c["pool"].setting("state", .string(state))) : c
    }
}

/// ports with one entry changed
func withPort(_ ports: JSON, _ port: Int, _ f: (JSON) -> JSON) -> JSON {
    ports.mapArray("ports") { $0["port"].int == port ? f($0) : $0 }
}

/// The app's text tables, read from mac-app/Resources like the fixtures (no resource bundle). The assertions are in
/// Korean, so every test class loads the Korean table in setUp.
enum Strings {
    static func file(_ lang: String) -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // PortboardCoreTests
            .appendingPathComponent("../../Resources/\(lang).lproj/Localizable.strings")
        return try! String(contentsOf: url, encoding: .utf8)
    }

    static let korean = L10n.parse(file("ko"))
    static let english = L10n.parse(file("en"))

    static func useKorean() { L10n.table = korean }
}
