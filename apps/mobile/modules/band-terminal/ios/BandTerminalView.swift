import ExpoModulesCore
import UIKit

/// SwiftTerm's `TerminalView` inside an Expo view. JavaScript owns the connection: it writes the
/// hub's bytes in, and gets keystrokes (`onInput`) and the grid size (`onSize`) back.
public final class BandTerminalView: ExpoView, TerminalViewDelegate {
  /// Lines kept above the screen. 10,000 lines is a few MB at 80 columns.
  static let scrollbackLines = 10_000

  let onInput = EventDispatcher()
  let onSize = EventDispatcher()
  let onTitle = EventDispatcher()
  let onBell = EventDispatcher()
  let onOpenLink = EventDispatcher()

  private let terminalView: TerminalView
  private var fontSize: CGFloat = 13
  private var accessibilityPending = false

  public required init(appContext: AppContext? = nil) {
    var options = TerminalOptions.default
    options.scrollback = BandTerminalView.scrollbackLines
    terminalView = TerminalView(frame: .zero, font: nil, options: options)
    super.init(appContext: appContext)
    terminalView.terminalDelegate = self
    terminalView.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    // The app draws its own key bar, so SwiftTerm's accessory row stays off.
    terminalView.inputAccessoryView = nil
    terminalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    terminalView.isAccessibilityElement = true
    terminalView.accessibilityLabel = "Terminal"
    addSubview(terminalView)
  }

  /// Keeps the screen's text in the view's accessibility value, so VoiceOver and UI tests read
  /// it. It runs at most every 200 ms, however fast output arrives.
  private func scheduleAccessibilityUpdate() {
    if accessibilityPending { return }
    // Nothing reads the value of a view that is off screen; didMoveToWindow refreshes it.
    if window == nil { return }
    accessibilityPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      guard let self else { return }
      self.accessibilityPending = false
      self.terminalView.accessibilityValue = self.terminalView.accessibilityPageContent()
    }
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { scheduleAccessibilityUpdate() }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if terminalView.frame != bounds {
      terminalView.frame = bounds
    }
  }

  // MARK: props

  func setFontSize(_ size: CGFloat) {
    guard size != fontSize, size >= 6, size <= 40 else { return }
    fontSize = size
    terminalView.font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
  }

  func setBackground(_ hex: String) {
    if let color = UIColor(hex: hex) {
      terminalView.nativeBackgroundColor = color
      backgroundColor = color
    }
  }

  func setForeground(_ hex: String) {
    if let color = UIColor(hex: hex) {
      terminalView.nativeForegroundColor = color
    }
  }

  // MARK: commands

  func write(base64: String) {
    guard let data = Data(base64Encoded: base64) else { return }
    terminalView.feed(byteArray: [UInt8](data)[...])
    scheduleAccessibilityUpdate()
  }

  func reset() {
    // RIS (full reset) plus clearing the scrollback: a reconnect replays the whole screen.
    terminalView.feed(byteArray: [0x1b, 0x63][...])
    terminalView.getTerminal().resetToInitialState()
    scheduleAccessibilityUpdate()
  }

  func focusInput() {
    _ = terminalView.becomeFirstResponder()
  }

  func blurInput() {
    _ = terminalView.resignFirstResponder()
  }

  // MARK: TerminalViewDelegate

  public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    onSize(["cols": newCols, "rows": newRows])
  }

  public func setTerminalTitle(source: TerminalView, title: String) {
    onTitle(["title": title])
  }

  public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  public func send(source: TerminalView, data: ArraySlice<UInt8>) {
    onInput(["data": String(decoding: data, as: UTF8.self)])
  }

  public func scrolled(source: TerminalView, position: Double) {}

  public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    onOpenLink(["url": link])
  }

  public func bell(source: TerminalView) {
    onBell([:])
  }

  public func clipboardCopy(source: TerminalView, content: Data) {
    // OSC 52 from the program: ignored, so remote output cannot overwrite the clipboard with no
    // user gesture. Long-press Copy goes through SwiftTerm's own edit menu, not this delegate.
  }

  public func clipboardRead(source: TerminalView) -> Data? { nil }

  public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

  public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

extension UIColor {
  convenience init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
    self.init(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1)
  }
}
