import { useEffect } from "react";
import { getElectronBridge } from "./desktop-ipc";

/**
 * Steps worktree history with the mouse side buttons (button 3 = back, 4 =
 * forward) and, in the desktop app, the macOS swipe gesture (right = back).
 *
 * The side buttons are handled on `mouseup` only, so one press steps once.
 * `mousedown` and `auxclick` are cancelled too, so a plain browser does not
 * also navigate its own page history. Wheel and mouse events over a browser
 * pane's `<webview>` go to that page, so the buttons do nothing there.
 */
export function useWorktreeMouseNav(goBack: () => void, goForward: () => void): void {
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) goBack();
      else goForward();
    };
    window.addEventListener("mousedown", swallow, true);
    window.addEventListener("auxclick", swallow, true);
    window.addEventListener("mouseup", onMouseUp, true);

    let unlisten: (() => void) | undefined;
    try {
      unlisten = getElectronBridge()?.on("window-swipe", (direction) => {
        if (direction === "right") goBack();
        else if (direction === "left") goForward();
      });
    } catch {
      // An older desktop shell without the event.
    }
    return () => {
      window.removeEventListener("mousedown", swallow, true);
      window.removeEventListener("auxclick", swallow, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      unlisten?.();
    };
  }, [goBack, goForward]);
}
