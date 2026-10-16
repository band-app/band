// swift-tools-version:5.9
import PackageDescription

// Feeds a recorded terminal session to SwiftTerm's headless terminal and prints the final screen
// as JSON, for tests/terminal-replay.test.ts to compare with xterm.js.
let package = Package(
    name: "band-term-dump",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.20.0")
    ],
    targets: [
        .executableTarget(
            name: "dump",
            dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")],
            path: "Sources/dump")
    ]
)
