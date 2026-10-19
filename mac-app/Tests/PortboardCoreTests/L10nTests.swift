import XCTest
@testable import PortboardCore

final class L10nTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    override func tearDown() {
        Strings.useKorean()
        super.tearDown()
    }

    func testParseEscapesAndComments() {
        let t = L10n.parse(#"""
        /* a block comment
           "skipped" = "no"; */
        // a line comment "also" = "no";
        "plain" = "Plain";
        "quote" = "say \"hi\"";   // trailing comment
        "slash"="a\\b";
        "lines" = "one\ntwo";
        "url" = "https://example.com/* not a comment */";
        "korean" = "새로고침";
        garbage line
        "last" = "no semicolon"
        """#)
        XCTAssertEqual(t, [
            "plain": "Plain",
            "quote": #"say "hi""#,
            "slash": #"a\b"#,
            "lines": "one\ntwo",
            "url": "https://example.com/* not a comment */",
            "korean": "새로고침",
            "last": "no semicolon",
        ])
        XCTAssertEqual(L10n.parse("\u{FEFF}\"a\" = \"b\";\r\n\"c\" = \"d\";\r\n"), ["a": "b", "c": "d"])
        XCTAssertEqual(L10n.parse(""), [:])
        XCTAssertEqual(L10n.parse(#""open" = "never closed"#), [:])
    }

    func testPlaceholders() {
        L10n.table = ["x": ":{port}이(가) 응답하지 않아요", "two": "{a} and {b}, {a}", "brace": "{missing} {", "plain": "no {n} here"]
        XCTAssertEqual(L10n.t("x", ["port": 3000]), ":3000이(가) 응답하지 않아요")
        XCTAssertEqual(L10n.t("two", ["a": "A", "b": 2.5]), "A and 2.5, A")
        // a value is not filled in again, an unknown placeholder and a lone brace stay
        XCTAssertEqual(L10n.t("two", ["a": "{b}", "b": "B"]), "{b} and B, {b}")
        XCTAssertEqual(L10n.t("brace", ["n": 1]), "{missing} {")
        XCTAssertEqual(L10n.t("plain"), "no {n} here")
    }

    func testMissingKeyFallsBackToTheKey() {
        L10n.table = [:]
        XCTAssertEqual(L10n.t("mac.nothing.here"), "mac.nothing.here")
        XCTAssertEqual(DashboardTab.services.title, "shell.view.services")
    }

    func testBundledTablesMatch() {
        XCTAssertEqual(L10n.t("shell.view.services"), "서비스", "the Korean table is the one tests load")
        XCTAssertGreaterThan(Strings.korean.count, 100)
        XCTAssertEqual(Set(Strings.korean.keys), Set(Strings.english.keys))
        XCTAssertEqual(Strings.english["shell.view.services"], "Services")
        func placeholders(_ s: String) -> Set<String> {
            var out = Set<String>()
            var rest = Substring(s)
            while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
                out.insert(String(rest[open...close]))
                rest = rest[rest.index(after: close)...]
            }
            return out
        }
        for (key, ko) in Strings.korean {
            XCTAssertEqual(placeholders(ko), placeholders(Strings.english[key] ?? ""), key)
        }
    }

    func testEnglishTable() {
        L10n.table = Strings.english
        XCTAssertEqual(Problem.text(urlErrorCode: -1001), "No response within 8 seconds")
        XCTAssertEqual(Poll.label(120), "2 min")
        XCTAssertEqual(DashboardTab.allCases.map(\.title), ["Services", "Devices", "Dev", "Settings"])
    }
}
