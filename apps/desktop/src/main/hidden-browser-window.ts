/**
 * Hidden BrowserWindow used by `BrowserViewManager` to host
 * `WebContentsView`s the desktop UI hasn't currently mounted a panel for —
 * including tabs that the web/agent ensure'd through the
 * `browserHost.ensureView` bridge but the user hasn't opened on desktop
 * yet, and tabs that the desktop just hid because the user switched
 * workspace.
 *
 * Why this exists: chromium parks its compositor for `WebContentsView`s
 * whose parent isn't on screen — including views positioned outside the
 * parent's visible region. With the compositor parked, `Page.startScreencast`
 * emits no frames AND `Page.captureScreenshot` stalls. We confirmed this
 * empirically: screenshots against an offscreen-positioned view in the
 * main window timed out, breaking every web-side stream.
 *
 * To satisfy chromium without showing anything to the user we create a
 * real `BrowserWindow` and `showInactive()` it (so it counts as visible
 * from chromium's POV), then immediately push it offscreen, set opacity
 * to 0, ignore mouse events, and hide it from the dock / mission control.
 * The user never sees it; child `WebContentsView`s composite normally.
 */

import { BrowserWindow } from "electron";

export function createHiddenBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // showInactive() makes it "visible" to chromium without stealing focus
  // from the user's main window. Combined with opacity 0 and offscreen
  // position, the user never sees it.
  win.showInactive();
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setPosition(-99999, -99999);

  // Belt and suspenders: prevent the window from acquiring focus on its own
  // (e.g. if a child WebContentsView programmatically calls focus()).
  win.on("focus", () => {
    // Re-yield focus to the main window if anything tries to steal it.
    const mains = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
    mains[0]?.focus();
  });

  return win;
}
