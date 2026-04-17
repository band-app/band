import { useEffect } from "react";
import { isTauri } from "../lib/is-tauri";
import { zoomIn, zoomOut, zoomReset } from "../lib/zoom";

/**
 * Browser-mode keyboard shortcut handler for zoom.
 *
 * Registers Cmd+= (zoom in), Cmd+- (zoom out), and Cmd+0 (reset).
 * Only active outside Tauri — in Tauri mode the native View menu
 * accelerators intercept these keys before they reach the webview.
 */
export function useZoom(): void {
  useEffect(() => {
    // In Tauri, the View menu accelerators handle Cmd+=/Cmd+-/Cmd+0
    // before they reach the webview, so skip the JS listener.
    if (isTauri) return;

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
