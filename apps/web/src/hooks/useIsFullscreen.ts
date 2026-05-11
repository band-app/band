import { useEffect, useState } from "react";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Tracks the Electron BrowserWindow's macOS native fullscreen state.
 * Returns false outside the desktop shell. The main process forwards
 * enter-/leave-full-screen events; this hook also runs an initial query.
 */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    desktopInvoke<boolean>("get_window_fullscreen")
      .then((fs) => {
        if (!cancelled) setIsFullscreen(fs);
      })
      .catch(() => {});
    desktopListen<boolean>("window-fullscreen-changed", ({ payload }) => {
      setIsFullscreen(payload);
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return isFullscreen;
}
