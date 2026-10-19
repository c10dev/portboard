import Foundation

/// The app's text in the system language: Korean on a Korean Mac, English otherwise. The strings live in
/// mac-app/Resources/{en,ko}.lproj/Localizable.strings (dotted keys like the dashboard's public/i18n catalogs, `{name}`
/// placeholders), which build.sh copies into Portboard.app/Contents/Resources. `load()` reads the one Bundle.main
/// picks for the user's preferred languages; no SwiftPM resources, so a missing file only shows keys, it never crashes.
public enum L10n {
    /// key → text, filled by `load()` (tests set it from the repository file)
    public static var table: [String: String] = [:]

    /// The text for `key` (the key itself when it is missing), with each `{name}` replaced by `params[name]`.
    /// One pass from left to right, so a value that itself contains `{…}` is left as it is.
    public static func t(_ key: String, _ params: [String: Any] = [:]) -> String {
        let text = table[key] ?? key
        guard !params.isEmpty, text.contains("{") else { return text }
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            let after = rest.index(after: open)
            guard let close = rest[after...].firstIndex(of: "}") else { break }
            out += rest[..<open]
            let name = String(rest[after..<close])
            if let value = params[name] { out += String(describing: value) } else { out += rest[open...close] }
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return out
    }

    /// Reads .strings text: `"key" = "value";` lines with `\"`, `\\`, `\n` (and `\t`, `\r`) escapes, `//` and
    /// `/* */` comments. Anything else on a line is skipped.
    public static func parse(_ text: String) -> [String: String] {
        let s = Array(text.unicodeScalars)
        var i = 0
        var out: [String: String] = [:]

        func skipSpaceAndComments() {
            while i < s.count {
                let c = s[i]
                if c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{FEFF}" {
                    i += 1
                } else if c == "/", i + 1 < s.count, s[i + 1] == "/" {
                    while i < s.count, s[i] != "\n" { i += 1 }
                } else if c == "/", i + 1 < s.count, s[i + 1] == "*" {
                    i += 2
                    while i < s.count, !(s[i] == "*" && i + 1 < s.count && s[i + 1] == "/") { i += 1 }
                    i = min(i + 2, s.count)
                } else {
                    return
                }
            }
        }

        func quoted() -> String? {
            guard i < s.count, s[i] == "\"" else { return nil }
            i += 1
            var v = ""
            while i < s.count {
                let c = s[i]
                i += 1
                if c == "\"" { return v }
                if c == "\\", i < s.count {
                    let e = s[i]
                    i += 1
                    switch e {
                    case "n": v.unicodeScalars.append("\n")
                    case "t": v.unicodeScalars.append("\t")
                    case "r": v.unicodeScalars.append("\r")
                    default: v.unicodeScalars.append(e)
                    }
                } else {
                    v.unicodeScalars.append(c)
                }
            }
            return nil
        }

        func skipLine() {
            while i < s.count, s[i] != "\n" { i += 1 }
        }

        while true {
            skipSpaceAndComments()
            guard i < s.count else { break }
            guard let key = quoted() else { skipLine(); continue }
            skipSpaceAndComments()
            guard i < s.count, s[i] == "=" else { skipLine(); continue }
            i += 1
            skipSpaceAndComments()
            guard let value = quoted() else { skipLine(); continue }
            skipSpaceAndComments()
            if i < s.count, s[i] == ";" { i += 1 }
            out[key] = value
        }
        return out
    }

    /// Fills `table` from the bundle's Localizable.strings. Bundle.main resolves the .lproj for the system's
    /// preferred language (falling back to the development region, en). Call once at app start, before any text.
    public static func load(bundle: Bundle = .main) {
        guard let path = bundle.path(forResource: "Localizable", ofType: "strings"),
              let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        table = parse(text)
    }
}
