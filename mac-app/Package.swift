// swift-tools-version:5.9
// Portboard for macOS: a SwiftUI app (dashboard window + menu bar + notifications) over Portboard's REST API.
//
//   PortboardCore       pure logic, Foundation only: JSON reading, menu summaries, notification dedupe, error text.
//                       Builds and tests on Linux too (`swift test` in the swift docker image).
//   PortboardCoreTests  XCTest against menubar/fixtures (the SwiftBar plugin's fixtures)
//   Portboard           the app (AppKit/SwiftUI/WebKit), macOS only; ./build.sh wraps it into Portboard.app
import PackageDescription

var products: [Product] = [.library(name: "PortboardCore", targets: ["PortboardCore"])]
var targets: [Target] = [
    .target(name: "PortboardCore"),
    .testTarget(name: "PortboardCoreTests", dependencies: ["PortboardCore"]),
]

#if os(macOS)
products.append(.executable(name: "Portboard", targets: ["Portboard"]))
targets.append(.executableTarget(name: "Portboard", dependencies: ["PortboardCore"]))
#endif

let package = Package(
    name: "Portboard",
    platforms: [.macOS(.v14)],
    products: products,
    targets: targets
)
