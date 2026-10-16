SwiftTerm v1.20.0 (https://github.com/migueldeicaza/SwiftTerm, MIT, see LICENSE), copied from
`Sources/SwiftTerm` with three changes:

- `Mac/` is left out (AppKit) except `MacAccessibilityService.swift`, which the iOS view uses too.
- `Apple/Metal/Shaders.metal` is left out. Xcode 26 needs the separate Metal Toolchain download to
  compile it, and the view draws with Core Graphics unless Metal is switched on, which Band never does.
- `SwiftTermBuildInfo.swift` is a fixed stand-in for the file the package's build plugin generates.

It is vendored because SwiftTerm is not on CocoaPods trunk, and the Swift package route needs
package plugin validation turned off in every build (CI and EAS) plus the Metal Toolchain. To
update, replace the files from a newer tag and re-run `tests/terminal-replay.test.ts`.
