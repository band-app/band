import { isDesktop } from "../lib/is-desktop";
import { ZOOM_SHORTCUTS } from "../lib/shortcuts";
import { zoomIn, zoomOut, zoomReset } from "../lib/zoom";
import { useAppShortcut } from "./useAppShortcut";

/**
 * Browser-mode keyboard shortcut handler for zoom.
 *
 * Registers Cmd+= (zoom in), Cmd+- (zoom out) and Cmd+Shift+0 (reset).
 * Plain Cmd+0 is intentionally NOT bound — that combo is owned by the
 * dashboard's "All projects" label filter (see DashboardShell), which is
 * also why reset uses the shifted variant (mirrored by the desktop View
 * menu's "Actual Size" accelerator in `apps/desktop/src/main/menu.ts`).
 *
 * Only active outside the desktop shell — when running inside Electron the
 * native View menu accelerators intercept these keys before they reach the
 * webview (see `apps/desktop/src/main/menu.ts`). `enabled: !isDesktop` is the
 * hook-friendly form of the early `return` this replaces: the bindings are
 * declared unconditionally (hooks must be) but stay inert in a desktop shell.
 */
export function useZoom(): void {
  const enabled = !isDesktop;

  useAppShortcut(ZOOM_SHORTCUTS.zoomIn, () => zoomIn(), { enabled });
  useAppShortcut(ZOOM_SHORTCUTS.zoomOut, () => zoomOut(), { enabled });
  useAppShortcut(ZOOM_SHORTCUTS.resetZoom, () => zoomReset(), { enabled });
}
