// Stands in for the file SwiftTerm's build plugin generates. The plugin needs Xcode's package
// plugin validation, which a CI or EAS build would have to switch off.

/// Source-control information for this SwiftTerm build.
public enum SwiftTermBuildInfo {
    public static let branch: String? = nil
    public static let tag: String? = "v1.20.0"
    public static let commit: String? = nil
    public static let hasUncommittedChanges: Bool? = false
    public static let version: String = "v1.20.0"
}
