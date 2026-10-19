import Foundation

/// Any JSON value. The API is read defensively, like menubar/format.mjs: older or newer servers may lack fields, add
/// fields or change a type, and none of that may fail the whole document. So responses decode into `JSON` and the
/// models below read what they need from it; a missing key or a wrong type reads as `.null`.
public enum JSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public static func parse(_ data: Data) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: data)
    }

    public subscript(key: String) -> JSON {
        if case .object(let o) = self { return o[key] ?? .null }
        return .null
    }

    public subscript(index: Int) -> JSON {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return .null
    }

    public var isNull: Bool { self == .null }

    public var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// A non-empty string, the way `p?.label || …` falls through in JavaScript
    public var text: String? {
        guard let s = string, !s.isEmpty else { return nil }
        return s
    }

    public var double: Double? {
        if case .number(let n) = self, n.isFinite { return n }
        return nil
    }

    /// Only whole numbers (`Number.isInteger`)
    public var int: Int? {
        guard let n = double, n == n.rounded(), abs(n) < 9e15 else { return nil }
        return Int(n)
    }

    public var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// Elements of an array; anything else is empty
    public var array: [JSON] {
        if case .array(let a) = self { return a }
        return []
    }

    public var isArray: Bool {
        if case .array = self { return true }
        return false
    }

    public var object: [String: JSON]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// JavaScript truthiness, for flags like `pinned` and `served`
    public var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }
}

extension JSON: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            // Bool before Double: the older Foundation decoder would read `true` as 1.0
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSON].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSON].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON")
        }
    }
}
