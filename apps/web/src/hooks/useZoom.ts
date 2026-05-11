import { useEffect } from "react";
import { isDesktop } from "../lib/is-desktop";
import { zoomIn, zoomOut } from "../lib/zoom";

/**
 * Browser-mode keyboard shortcut handler for zoom.
 *
 * Registers Cmd+= (zoom in) and Cmd+- (zoom out). Cmd+0 is intentionally
 * NOT bound — that combo is owned by the dashboard's "All projects" label
 * filter (see DashboardShell). Reset is still reachable via the desktop
 * View menu's "Actual Size" item.
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
      if (!(e.metaKey || e.ctrlKey)) return;

      // Cmd+= or Cmd++ → zoom in
      // On US keyboards, Shift is needed for +, but = and + share a key.
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        e.stopPropagation();
        zoomIn();
        return;
      }

      // Cmd+- → zoom out
      if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        zoomOut();
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
