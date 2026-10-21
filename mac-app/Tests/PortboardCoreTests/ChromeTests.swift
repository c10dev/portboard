import XCTest
@testable import PortboardCore

final class ChromeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Strings.useKorean()
    }

    func testTrafficLightsFitTheClearedStrip() {
        // the zoom button ends left of where the page's controls start, with room to spare
        XCTAssertEqual(WindowChrome.lightsRight(), 70)
        XCTAssertLessThanOrEqual(WindowChrome.lightsRight() + 6, WindowChrome.clearLeft)
        // centred in the 48 px bar: a 16 px button sits 16 px from either edge
        XCTAssertEqual(WindowChrome.barHeight, 48)
        XCTAssertEqual(WindowChrome.lightsY(containerHeight: 48, buttonHeight: 16), 16)
        XCTAssertEqual(WindowChrome.lightsY(containerHeight: 48, buttonHeight: 14), 17)
    }

    /// The 1440 px header: bar across the top, two controls
    let report: [String: Any] = [
        "type": "bar",
        "bar": ["x": 0, "y": 0, "width": 1440, "height": 48] as [String: Any],
        "noDrag": [
            ["x": 78.0, "y": 12.0, "width": 28.0, "height": 28.0],   // ‹ 뒤로
            ["x": 228.5, "y": 9.5, "width": 196.25, "height": 33.0], // tabs
            ["x": 0, "y": 0, "width": 0, "height": 0],              // hidden: dropped
            "junk",
        ] as [Any],
    ]

    func testBarRegionsParse() {
        let r = WindowChrome.BarRegions(body: report)!
        XCTAssertEqual(r.bar, .init(x: 0, y: 0, width: 1440, height: 48))
        XCTAssertEqual(r.noDrag.count, 2)
        XCTAssertNil(WindowChrome.BarRegions(body: ["type": "drag"] as [String: Any]))
        XCTAssertNil(WindowChrome.BarRegions(body: ["type": "bar"] as [String: Any]))
        XCTAssertNil(WindowChrome.BarRegions(body: "bar"))
    }

    func testHitTesting() {
        let r = WindowChrome.BarRegions(body: report)!
        // empty bar space → drag (right of the tabs, and the gap between back and tabs)
        XCTAssertEqual(r.hit(x: 700, y: 26), .drag)
        XCTAssertEqual(r.hit(x: 150, y: 26), .drag)
        // on a control → the page
        XCTAssertEqual(r.hit(x: 90, y: 26), .page)
        XCTAssertEqual(r.hit(x: 300, y: 20), .page)
        // outside the bar → the page
        XCTAssertEqual(r.hit(x: 700, y: 48), .page)
        XCTAssertEqual(r.hit(x: 700, y: 400), .page)
        XCTAssertEqual(r.hit(x: -1, y: 10), .page)
    }

    func testCSSPointFlipsAndScales() {
        // a flipped view (WKWebView): y already from the top
        XCTAssertTrue(WindowChrome.cssPoint(x: 700, y: 20, viewHeight: 800, flipped: true, scale: 1) == (700, 20))
        // not flipped: y from the bottom
        XCTAssertTrue(WindowChrome.cssPoint(x: 700, y: 780, viewHeight: 800, flipped: false, scale: 1) == (700, 20))
        // page zoomed to 125%: 1 CSS px is 1.25 points
        let p = WindowChrome.cssPoint(x: 500, y: 25, viewHeight: 800, flipped: true, scale: 1.25)
        XCTAssertEqual(p.x, 400, accuracy: 1e-9)
        XCTAssertEqual(p.y, 20, accuracy: 1e-9)
        let r = WindowChrome.BarRegions(body: report)!
        XCTAssertEqual(r.hit(x: p.x, y: p.y), .page) // 400 CSS px is on the tabs (228.5…424.75)…
        XCTAssertEqual(r.hit(x: 500, y: 25), .drag)   // …though 500 points unscaled would have been empty space
        // y counted from the bottom of an unflipped view, then scaled
        let q = WindowChrome.cssPoint(x: 750, y: 775, viewHeight: 800, flipped: false, scale: 1.25)
        XCTAssertEqual(r.hit(x: q.x, y: q.y), .drag)
        XCTAssertEqual(q.y, 20, accuracy: 1e-9)
        // a bad scale counts as 1
        XCTAssertTrue(WindowChrome.cssPoint(x: 10, y: 10, viewHeight: 100, flipped: true, scale: 0) == (10, 10))
    }

    func testDoubleClickFollowsTheSystemSetting() {
        XCTAssertEqual(WindowChrome.DoubleClick(action: nil, legacyMinimize: false), .zoom)
        XCTAssertEqual(WindowChrome.DoubleClick(action: "Maximize", legacyMinimize: false), .zoom)
        XCTAssertEqual(WindowChrome.DoubleClick(action: "Fill", legacyMinimize: false), .zoom)
        XCTAssertEqual(WindowChrome.DoubleClick(action: "Minimize", legacyMinimize: false), .minimize)
        XCTAssertEqual(WindowChrome.DoubleClick(action: "None", legacyMinimize: true), .none)
        XCTAssertEqual(WindowChrome.DoubleClick(action: nil, legacyMinimize: true), .minimize)
    }

    func testPageStateScript() {
        let js = WindowChrome.pageStateScript(canGoBack: true, fullScreen: false)
        XCTAssertTrue(js.contains("toggleAttribute('data-can-go-back', true)"))
        XCTAssertTrue(js.contains("toggleAttribute('data-fullscreen', false)"))
    }

    func testPageTheme() {
        XCTAssertEqual(PageTheme(body: ["type": "theme", "theme": "dark"] as [String: Any]), .dark)
        XCTAssertEqual(PageTheme(body: ["type": "theme", "theme": "light"] as [String: Any]), .light)
        XCTAssertEqual(PageTheme(body: ["type": "theme", "theme": "system"] as [String: Any]), .system)
        XCTAssertNil(PageTheme(body: ["type": "theme", "theme": "purple"] as [String: Any]))
        XCTAssertNil(PageTheme(body: ["type": "bar", "theme": "dark"] as [String: Any]))
        XCTAssertNil(PageTheme(body: "dark"))
    }
}
