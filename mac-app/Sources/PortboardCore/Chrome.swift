import Foundation

/// The window has no title bar: the dashboard's header is the one bar, and these numbers are shared with
/// public/shell.css (`[data-app="mac"] .top`, `--bar-h`) and public/lib/macapp.js. test/macapp.test.ts checks the CSS against them.
public enum WindowChrome {
    /// Height of the bar (48 px, like the Claude desktop app's top bar); the traffic lights are centred in it
    public static let barHeight = 48.0
    /// Left edge of the close button
    public static let lightsX = 16.0
    /// Width the page keeps clear for the traffic lights (shell.css padding-left)
    public static let clearLeft = 78.0
    /// Close → minimize → zoom step and button width, when AppKit does not say (macOS 14/15 values)
    public static let defaultStep = 20.0
    public static let buttonWidth = 14.0

    /// Right edge of the zoom button
    public static func lightsRight(step: Double = defaultStep) -> Double { lightsX + 2 * step + buttonWidth }

    /// Origin y of a button of this height, centred in the bar (bottom-left origin, as AppKit's titlebar views use)
    public static func lightsY(containerHeight: Double, buttonHeight: Double) -> Double {
        ((containerHeight - buttonHeight) / 2).rounded()
    }

    /// A rectangle in CSS pixels, relative to the web view's top-left corner (getBoundingClientRect)
    public struct Rect: Equatable, Sendable {
        public var x, y, width, height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }

        init?(_ any: Any?) {
            guard let d = any as? [String: Any], let x = number(d["x"]), let y = number(d["y"]),
                  let w = number(d["width"]), let h = number(d["height"]), w > 0, h > 0 else { return nil }
            self.init(x: x, y: y, width: w, height: h)
        }

        public func contains(x px: Double, y py: Double) -> Bool {
            px >= x && px < x + width && py >= y && py < y + height
        }
    }

    /// What a mouse-down in the web view is for
    public enum Hit: Equatable, Sendable {
        /// empty bar space: the app moves (or on a double-click zooms) the window
        case drag
        /// a control, or outside the bar: the page gets the click
        case page
    }

    /// The page header's layout as lib/macapp.js reports it: `{type: 'bar', bar: rect, noDrag: [rect, …]}`. The app
    /// never asks the page at click time (script messages arrive later, over IPC); it hit-tests the last report.
    public struct BarRegions: Equatable, Sendable {
        public var bar: Rect
        public var noDrag: [Rect]

        public init(bar: Rect, noDrag: [Rect]) {
            self.bar = bar
            self.noDrag = noDrag
        }

        /// WKScriptMessage.body; nil for any other message or a malformed one
        public init?(body: Any) {
            guard let d = body as? [String: Any], d["type"] as? String == "bar", let bar = Rect(d["bar"]) else { return nil }
            self.bar = bar
            noDrag = (d["noDrag"] as? [Any] ?? []).compactMap { Rect($0) }
        }

        /// A point in CSS pixels (from `cssPoint`)
        public func hit(x: Double, y: Double) -> Hit {
            guard bar.contains(x: x, y: y) else { return .page }
            return noDrag.contains { $0.contains(x: x, y: y) } ? .page : .drag
        }
    }

    /// A point in the web view (AppKit points, `convert(_:from: nil)`) → CSS pixels from the top-left. A view that is
    /// not flipped counts y from the bottom; `scale` is magnification × pageZoom (CSS px are points / scale).
    public static func cssPoint(x: Double, y: Double, viewHeight: Double, flipped: Bool, scale: Double) -> (x: Double, y: Double) {
        let s = scale > 0 ? scale : 1
        let top = flipped ? y : viewHeight - y
        return (x / s, top / s)
    }

    /// What a double-click on the bar does, from the user's setting (시스템 설정 → 데스크탑 및 Dock →
    /// "윈도우 제목 막대를 이중 클릭하여": AppleActionOnDoubleClick; older systems: AppleMiniaturizeOnDoubleClick)
    public enum DoubleClick: Equatable, Sendable {
        case zoom, minimize, none

        public init(action: String?, legacyMinimize: Bool) {
            switch action?.lowercased() {
            case "minimize": self = .minimize
            case "none": self = .none
            case "maximize", "fill", "zoom": self = .zoom
            default: self = legacyMinimize ? .minimize : .zoom
            }
        }
    }

    /// JavaScript that tells the page what only the app knows: whether 뒤로 has somewhere to go (the app-only back
    /// button) and whether the window is full screen (no traffic lights, so no 78 px inset)
    public static func pageStateScript(canGoBack: Bool, fullScreen: Bool) -> String {
        "(() => { const d = document.documentElement; d.toggleAttribute('data-can-go-back', \(canGoBack)); d.toggleAttribute('data-fullscreen', \(fullScreen)); })()"
    }
}

/// JSON numbers arrive as NSNumber (Double or Int when bridged)
private func number(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}
