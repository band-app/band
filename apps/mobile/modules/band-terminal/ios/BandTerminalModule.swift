import ExpoModulesCore

public final class BandTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BandTerminal")

    View(BandTerminalView.self) {
      Events("onInput", "onSize", "onTitle", "onBell", "onOpenLink")

      Prop("fontSize") { (view, size: Double) in
        view.setFontSize(CGFloat(size))
      }
      Prop("background") { (view, hex: String) in
        view.setBackground(hex)
      }
      Prop("foreground") { (view, hex: String) in
        view.setForeground(hex)
      }

      // Bytes arrive as base64 so a binary chunk survives the bridge untouched.
      AsyncFunction("write") { (view: BandTerminalView, base64: String) in
        view.write(base64: base64)
      }.runOnQueue(.main)

      AsyncFunction("reset") { (view: BandTerminalView) in
        view.reset()
      }.runOnQueue(.main)

      AsyncFunction("focus") { (view: BandTerminalView) in
        view.focusInput()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: BandTerminalView) in
        view.blurInput()
      }.runOnQueue(.main)
    }
  }
}
