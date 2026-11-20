import { useEffect } from "react";
import { isDesktop } from "../lib/is-desktop";
import { matchesCommandWithEitherModifier } from "../lib/shortcuts";
import { zoomIn, zoomOut, zoomReset } from "../lib/zoom";

/**
 * Browser-mode keyboard shortcut handler for zoom.
 *
 * Registers Cmd+= (zoom in), Cmd+- (zoom out) and Cmd+Shift+0 (reset).
 * Plain Cmd+0 is intentionally NOT bound — that combo is owned by the
 * dashboard's "All repos" group filter (see DashboardShell), which is
 * also why reset uses the shifted variant (mirrored by the desktop View
 * menu's "Actual Size" accelerator in `apps/desktop/src/main/menu.ts`).
 *
 * Only active outside the desktop shell — when running inside Electron the
 * native View menu accelerators intercept these keys before they reach the
 * webview (see `apps/desktop/src/main/menu.ts`).
 */
export function useZoom(): void {
  useEffect(() => {
    // In a desktop shell, the View menu accelerators handle Cmd+= / Cmd+-
    // before they reach the webview, so skip the JS listener.
    if (isDesktop) return;

    const handler = (e: KeyboardEvent) => {
      const action = matchesCommandWithEitherModifier(e, "zoom-in")
        ? zoomIn
        : matchesCommandWithEitherModifier(e, "zoom-out")
          ? zoomOut
          : matchesCommandWithEitherModifier(e, "zoom-reset")
            ? zoomReset
            : null;
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
