import Foundation

/// Small text helpers shared by the menu and the notifications (format.mjs's esc/shortName/webUrl).
public enum Fmt {
    public static let maxText = 110
    public static let maxName = 42

    /// Whitespace runs (newlines too) become one space, trimmed
    public static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    static func cut(_ s: String, _ max: Int) -> String {
        s.count > max ? String(s.prefix(max - 1)) + "…" : s
    }

    /// One menu line: one line of text, cut at 110 characters
    public static func menuText(_ s: String) -> String { cut(oneLine(s), maxText) }

    /// A service or device name, cut at 42 characters
    public static func shortName(_ s: String) -> String { cut(oneLine(s), maxName) }

    /// Only http(s) URLs open in a browser; tcp:// (SSH, Syncthing sync) would do nothing
    public static func webURL(_ s: String?) -> URL? {
        guard let s, s.hasPrefix("http://") || s.hasPrefix("https://"), let u = URL(string: s), u.host != nil else { return nil }
        return u
    }

    /// JavaScript's Math.round (half up) for the percentages the dashboard shows
    public static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    /// A number as JavaScript prints it: 10 → "10", 10.5 → "10.5"
    public static func jsNumber(_ x: Double) -> String {
        x == x.rounded() && abs(x) < 1e15 ? String(Int(x)) : String(x)
    }
}
