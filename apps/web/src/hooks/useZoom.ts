import { useEffect } from "react";
import { isDesktop } from "../lib/is-desktop";
import { zoomIn, zoomOut, zoomReset } from "../lib/zoom";

/**
 * Browser-mode keyboard shortcut handler for zoom.
 *
 * Registers Cmd+= (zoom in), Cmd+- (zoom out), and Cmd+0 (reset).
 * Only active outside the desktop shell — when running inside Electron the
 * native View menu accelerators intercept these keys before they reach the
 * webview (see `apps/desktop/src/main/menu.ts`).
 */
export function useZoom(): void {
  useEffect(() => {
    // In a desktop shell, the View menu accelerators handle Cmd+=/Cmd+-/Cmd+0
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
        return;
      }

      // Cmd+0 → reset zoom
      if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        zoomReset();
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
