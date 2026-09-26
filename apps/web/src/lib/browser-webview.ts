// ---------------------------------------------------------------------------
// Desktop browser tabs are Electron `<webview>` elements mounted in the pane's
// DOM (see `BrowserPaneComponent`). Because they are ordinary elements, Band's
// menus, dialogs and tooltips stack over them with CSS; nothing has to be
// hidden, frozen or snapshotted while an overlay is open.
//
// This module holds what several call sites share: the element type (the web
// app does not depend on Electron's typings), the session partition the main
// process admits, and a registry of live webviews by Band browser id, so the
// menu globals (`__bandReload`, `__bandZoom`) and forwarded shortcuts can
// reach the tab's element.
// ---------------------------------------------------------------------------

import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from "./zoom";

/**
 * Session partition of every browser tab. Must match `BROWSER_PARTITION` in
 * `apps/desktop/src/browser/guest-policy.ts`: the main process refuses to
 * attach a webview in any other partition. A dedicated partition keeps tab
 * cookies, storage and per-origin zoom away from the dashboard's session.
 */
export const BROWSER_PARTITION = "persist:band-browser";

/**
 * Session partition of a Band browser profile (`null` is Default). Must match
 * `partitionForProfile` in `apps/desktop/src/browser/profiles.ts`; the main
 * process admits only `persist:band-browser-profile-<id>` besides Default.
 */
export function partitionForProfile(profileId: string | null): string {
  return profileId === null ? BROWSER_PARTITION : `persist:band-browser-profile-${profileId}`;
}

/** The subset of Electron's `WebviewTag` API the panes use. */
export interface BrowserWebview extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  isLoading(): boolean;
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
}

/** Payload of the webview's `found-in-page` DOM event (`event.result`). */
export interface WebviewFoundInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

const webviewsByBrowserId = new Map<string, BrowserWebview>();

export function registerBrowserWebview(browserId: string, webview: BrowserWebview): () => void {
  webviewsByBrowserId.set(browserId, webview);
  return () => {
    if (webviewsByBrowserId.get(browserId) === webview) webviewsByBrowserId.delete(browserId);
  };
}

export function getBrowserWebview(browserId: string): BrowserWebview | null {
  const webview = webviewsByBrowserId.get(browserId);
  return webview?.isConnected ? webview : null;
}

/**
 * Step a tab's zoom (Cmd+= / Cmd+- / Actual Size inside a browser pane).
 * Same range and step as the dashboard zoom (`lib/zoom.ts`), so holding
 * Cmd+= moves the page and the app chrome by the same increments. Chromium
 * keeps the factor per origin in the browser partition, as in Chrome.
 */
export function zoomBrowserWebview(webview: BrowserWebview, action: "in" | "out" | "reset"): void {
  try {
    let next = 1;
    if (action !== "reset") {
      const current = webview.getZoomFactor();
      next = action === "in" ? current + ZOOM_STEP : current - ZOOM_STEP;
    }
    // Round to 0.01 so repeated steps don't drift (0.1 * 7 = 0.7000000000000001).
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    webview.setZoomFactor(Math.round(clamped * 100) / 100);
  } catch {
    // The guest methods throw until the page has attached; nothing to zoom.
  }
}
