/**
 * `WebContentsView`-backed LRU manager for the renderer's browser panels.
 *
 * Direct port of `apps/dashboard/src-tauri/src/commands/browser.rs`:
 *   - Each browser tab gets a child `WebContentsView` of the main window.
 *   - LRU cap (10 — matches `MAX_BROWSER_WEBVIEWS` in the Rust impl); when
 *     creating a new one past the cap, the oldest is closed.
 *   - `setBounds`, `show`, `hide`, `navigate`, `goBack`, `goForward`, `reload`,
 *     `eval`, `destroy`, `hideAll`, `showAll`.
 *   - Emits `browser-url-changed` (start + stop loading) and
 *     `browser-title-changed` events. The Tauri impl reads WKWebView's
 *     `title` property via objc message-send on macOS only; Electron's
 *     `page-title-updated` works cross-platform out of the box.
 *
 * The renderer's TWO-mode keying (workspaceId vs browserId) is handled at
 * the IPC arg layer (`browserKey()` picks whichever is sent). Internally
 * the manager uses one opaque string key per view. Events emit BOTH
 * `browser_id` and `workspace_id` set to the same key so the existing
 * renderer code that destructures either name keeps working.
 */

import { type BrowserWindow, WebContentsView } from "electron";
import { dashLog } from "../main/services/log.js";
import { Events } from "../shared/ipc-channels.js";
import {
  type BrowserBoundsArgs,
  type BrowserCreateArgs,
  type BrowserEnsureArgs,
  type BrowserEvalArgs,
  type BrowserFindInPageArgs,
  type BrowserFindShortcutPayload,
  type BrowserFoundInPagePayload,
  type BrowserKeyArg,
  type BrowserNavigateArgs,
  type BrowserNewTabShortcutPayload,
  type BrowserStopFindInPageArgs,
  type BrowserTitleChangedPayload,
  type BrowserUrlChangedPayload,
  type BrowserViewDestroyedPayload,
  type BrowserZoomArgs,
  browserKey,
} from "../shared/types.js";
import { type BrowserCertErrorPayload, buildCertErrorPayload } from "./cert-error.js";
import { type CertExceptionStore, partitionForSession } from "./cert-exceptions.js";
import {
  type BandAction,
  buildCertErrorHtml,
  buildLoadErrorHtml,
  htmlToDataUrl,
  parseBandAction,
} from "./error-html.js";
import { splitTabBounds } from "./layout.js";
import {
  type BrowserLoadErrorPayload,
  buildLoadErrorPayload,
  isMainFrameFailure,
} from "./load-error.js";

const MAX_BROWSER_VIEWS = 10;

// Zoom range + step, intentionally aligned with the dashboard's zoom
// settings (`apps/web/src/lib/zoom.ts`). Keeping them in sync avoids
// the dashboard chrome and the tab content drifting to different
// scale-step sizes when the user holds down Cmd+=.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1.0;

// DevTools docking: when the DevTools-host sibling view is attached,
// the tab's bounds are split — the page view gets the top portion and
// DevTools gets the bottom `DEVTOOLS_SPLIT_RATIO`, clamped to
// `DEVTOOLS_MIN_HEIGHT` so the panel stays usable when the tab area is
// short.
const DEVTOOLS_SPLIT_RATIO = 0.4;
const DEVTOOLS_MIN_HEIGHT = 160;
// Page view never collapses below this on tall enough windows. On
// windows shorter than `PAGE_MIN_HEIGHT`, the page view shrinks to
// `bounds.height` (DevTools is sacrificed to keep page visible).
const PAGE_MIN_HEIGHT = 40;

export interface ViewManagerOptions {
  /** User-visible window that hosts the React UI; renders WebContentsViews
   *  on top when the desktop's Browser pane has them positioned. */
  mainWindow: BrowserWindow;
  /**
   * Never-user-visible window that hosts WebContentsViews when no
   * desktop UI panel is currently displaying them. Chromium parks the
   * compositor (breaking screencast and captureScreenshot) when a
   * WebContentsView's parent isn't on screen — the hidden window keeps
   * views composit-able while invisible to the user.
   *
   * Optional: when the CDP screencast experiment is disabled
   * (`settings.webBrowserCdpEnabled === false`), the desktop doesn't
   * create a hidden window and `BrowserViewManager` falls back to the
   * original simple lifecycle (hide() = setVisible(false), no
   * cross-window migration). Saves the constant overhead of a second
   * BrowserWindow + the per-tab compositor cost while inactive.
   */
  hiddenWindow?: BrowserWindow;
  /**
   * Session-scoped TLS exception store for the in-view cert
   * interstitial (issue #444). Owned by the bootstrap so the manager
   * can be re-created without losing accepted exceptions during the
   * session. The per-`webContents` `certificate-error` listener
   * reads from this store to decide whether to silently trust a cert
   * (matched triple) or paint the interstitial.
   */
  certExceptions: CertExceptionStore;
}

type Parent = "main" | "hidden";

export class BrowserViewManager {
  private readonly views = new Map<string, WebContentsView>();
  /** Tracks which window each view is parented to so we can migrate
   *  on show / hide / ensure transitions. */
  private readonly parentByKey = new Map<string, Parent>();
  /** LRU order, oldest first. */
  private readonly order: string[] = [];
  /**
   * Optional DevTools-host sibling view per tab. Created lazily by
   * `toggleDevTools`. When present, the tab's bounds are split between
   * the page view (top) and this DevTools view (bottom) — see
   * `applyTabLayout`. The DevTools view is migrated alongside the page
   * view on every `moveTo`, and destroyed when the page view goes
   * away (LRU eviction, explicit destroy, app quit).
   */
  private readonly devToolsViews = new Map<string, WebContentsView>();
  /**
   * Latest bounds the renderer reported for each tab. Cached so
   * `toggleDevTools` can re-layout (split / un-split) without
   * round-tripping through the renderer.
   */
  private readonly lastBoundsByKey = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  /**
   * Tracks the latest `setVisible` argument we passed for each tab so
   * `toggleDevTools` can mirror the page view's current visibility on
   * the new DevTools sibling. `WebContentsView` has a setter but no
   * cross-version-stable getter (Electron's `WebContents.isVisible`
   * isn't on the public typings of this version).
   */
  private readonly visibleByKey = new Map<string, boolean>();
  /**
   * Per-tab snapshot of the audio-muted flag taken at the start of a
   * freeze cycle. `pauseMedia` records the current value here before
   * forcing the tab to mute; `resumeMedia` reads it back and only
   * clears the mute if the tab was unmuted before the freeze. Without
   * this, a tab the user had explicitly muted (right-click → Mute Tab,
   * or a script call) would be silently un-muted by every freeze
   * cycle.
   */
  private readonly preFreezeMutedByKey = new Map<string, boolean>();
  /**
   * Pending cert-error per tab, captured when Chromium fires the
   * per-webContents `certificate-error` event. Lives until either the
   * user clicks "Proceed" (which records an exception, reloads the
   * tab, and clears this entry) or "Back to safety" (which clears
   * without proceeding). Exposed to the renderer via the
   * `browser_get_cert_error_for_view` IPC so a renderer that mounts
   * after the event already fired (e.g. layout restore right after
   * an invalid-cert load) can still draw the interstitial.
   */
  private readonly pendingCertErrors = new Map<string, BrowserCertErrorPayload>();
  /**
   * Pending generic navigation error per tab (DNS, refused, timeout,
   * …), captured from Chromium's `did-fail-load` event. Parallel to
   * `pendingCertErrors`; the cert variant takes precedence so the
   * two never coexist (the `did-fail-load` listener filters codes in
   * the cert-error range).
   */
  private readonly pendingLoadErrors = new Map<string, BrowserLoadErrorPayload>();
  /**
   * Lowercased hostnames the user has clicked Proceed on this
   * session. Distinct from the `CertExceptionStore` (which is keyed
   * by `(partition, host, fingerprint)` and is the source of truth
   * for the `app.on("certificate-error")` override): this set is the
   * host-only projection exposed to the renderer via the
   * `getOverriddenHosts` IPC + the `browser-host-overridden` event,
   * so the dashboard chrome can paint a "Not Secure" badge while
   * the user is browsing a site with an overridden cert.
   */
  private readonly overriddenHosts = new Set<string>();

  constructor(private readonly opts: ViewManagerOptions) {}

  /**
   * Create-or-reuse the view. If a view with this key already exists, bump
   * its LRU position, migrate it to the main window if it isn't there, and
   * reposition. Otherwise enforce the cap and spawn.
   *
   * Called from the desktop's `BrowserPaneComponent` when its placeholder
   * div has real bounds.
   */
  create(args: BrowserCreateArgs): void {
    const key = browserKey(args);
    if (!key) return;
    const existing = this.views.get(key);
    if (existing) {
      this.touch(key);
      this.moveTo(key, existing, "main");
      this.lastBoundsByKey.set(key, args);
      this.applyTabLayout(key, args);
      this.setTabVisibility(key, true);
      return;
    }

    this.enforceLru();

    // Capture `spawn`'s return value directly. The previous form
    // (`spawn(...); this.views.get(key) as WebContentsView`) papered
    // over the failure mode where `spawn` is unable to insert into the
    // map — `moveTo` would then be handed `undefined`, and
    // `addChildView(undefined)` takes down the window.
    const view = this.spawn(args.url, key);
    this.moveTo(key, view, "main");
    this.lastBoundsByKey.set(key, args);
    this.applyTabLayout(key, args);
    this.setTabVisibility(key, true);
  }

  /**
   * Create-or-return-existing for the web/agent path
   * (`browserHost.ensureView` IPC). Called when the desktop's dockview
   * hasn't yet mounted a panel for this tab — so we don't have a
   * placeholder div with real bounds.
   *
   * Important: `Page.startScreencast` only produces frames when the
   * chromium compositor is actually painting. A `WebContentsView` with
   * zero bounds, OR with `setVisible(false)`, has its compositor parked
   * → screencast emits nothing. Two cases to handle:
   *
   *   - **New view**: `spawn()` already gives it an offscreen 1280×720
   *     bounding box and `setVisible(true)`, so the compositor runs out
   *     of the gate.
   *   - **Existing hidden view**: the desktop UI may have called
   *     `browser_hide` (e.g. user switched workspace) — flip
   *     `setVisible(true)` so the compositor wakes up. Bounds are left
   *     untouched. Side effect: the previously-positioned tab may
   *     briefly reappear over the desktop UI; the desktop UI's next
   *     `browser_set_bounds` / `browser_hide` call repositions it.
   */
  ensure(args: BrowserEnsureArgs): void {
    const key = browserKey(args);
    if (!key) return;
    const existing = this.views.get(key);
    if (existing) {
      // Leave the parent alone. `show()` and `hide()` keep the
      // invariant that every alive view has `setVisible(true)` and a
      // compositing parent (main or hidden), so any existing view is
      // already producing frames — no migration needed. Yanking a
      // main-parented view to hidden here would blank the desktop
      // user's Browser pane the first time the web ensures a tab they
      // are actively viewing.
      this.touch(key);
      // Belt-and-suspenders against ever leaving a view at
      // setVisible(false): no current code path does, but if a future
      // change introduces one, this keeps `ensure` robust.
      this.setTabVisibility(key, true);
      return;
    }
    this.enforceLru();
    this.spawn(args.url, key);
  }

  /**
   * Return the chromium CDP targetId for the given view. The web server's
   * `browser-host.ts` uses this to address the right `/devtools/page/<id>`
   * endpoint when proxying CDP traffic. The targetId is queried via the
   * per-`webContents` debugger API, then the debugger is detached so the
   * shared `--remote-debugging-port=9223` channel stays usable.
   *
   * Throws if no view exists for this key.
   */
  async getCdpTargetId(args: BrowserKeyArg): Promise<string> {
    const key = browserKey(args);
    const view = this.requireView(key);
    const dbg = view.webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach("1.3");
    }
    try {
      const result = (await dbg.sendCommand("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const targetId = result.targetInfo?.targetId;
      if (typeof targetId !== "string" || !targetId) {
        throw new Error(`Target.getTargetInfo returned no targetId for ${key}`);
      }
      return targetId;
    } finally {
      try {
        dbg.detach();
      } catch {
        // best-effort: detach may have happened already
      }
    }
  }

  navigate(args: BrowserNavigateArgs): void {
    const key = browserKey(args);
    const view = this.requireView(key);
    void view.webContents.loadURL(args.url);
  }

  setBounds(args: BrowserBoundsArgs): void {
    const key = browserKey(args);
    if (!this.views.get(key)) return;
    this.lastBoundsByKey.set(key, args);
    this.applyTabLayout(key, args);
  }

  show(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    // Migrate back to the main window so the user can see the tab.
    if (this.opts.hiddenWindow) this.moveTo(key, view, "main");
    this.setTabVisibility(key, true);
  }

  hide(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    if (this.opts.hiddenWindow) {
      // Migrate to the hidden window instead of `setVisible(false)` so the
      // chromium compositor keeps producing frames for the screencast pane
      // on web. The hidden window is invisible to the user but counts as a
      // visible parent from chromium's POV.
      this.moveTo(key, view, "hidden");
      this.setTabVisibility(key, true);
    } else {
      // CDP screencast disabled: original behavior. setVisible(false)
      // parks the compositor, which is exactly what we want for a tab
      // the user isn't currently viewing.
      this.setTabVisibility(key, false);
    }
  }

  reload(args: BrowserKeyArg): void {
    this.views.get(browserKey(args))?.webContents.reload();
  }

  goBack(args: BrowserKeyArg): void {
    const wc = this.views.get(browserKey(args))?.webContents;
    if (wc?.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  goForward(args: BrowserKeyArg): void {
    const wc = this.views.get(browserKey(args))?.webContents;
    if (wc?.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  /**
   * Evaluate JS in the browser webview. Returns the resolved value just like
   * Tauri's `webview.eval` (Tauri actually returns void, but Electron returns
   * a promise — we keep it `void` here so the IPC handler's contract matches).
   */
  async evalJs(args: BrowserEvalArgs): Promise<void> {
    const view = this.views.get(browserKey(args));
    if (!view) return;
    await view.webContents.executeJavaScript(args.js, true);
  }

  /**
   * Forward the renderer's find-bar query to Chromium's native
   * `findInPage`. Match highlighting is painted by the WebContentsView
   * itself; the only thing the renderer needs back is the running match
   * counter, which arrives via the `browser-found-in-page` event wired
   * up in `wireEvents`.
   *
   * Returns the chromium request id so the renderer can correlate
   * streamed updates (Chromium may emit several `found-in-page` events
   * per request as it scans large pages — only the one with
   * `final_update: true` is authoritative).
   */
  findInPage(args: BrowserFindInPageArgs): number | undefined {
    const view = this.views.get(browserKey(args));
    if (!view) return undefined;
    // Empty queries are a UX no-op (no highlight, no counter); Chromium
    // would reject the call anyway, so short-circuit before bothering
    // the webContents.
    if (!args.text) {
      view.webContents.stopFindInPage("clearSelection");
      return undefined;
    }
    return view.webContents.findInPage(args.text, args.options);
  }

  /**
   * End an active findInPage session. The default `clearSelection` action
   * removes both the highlight and the selection so closing the find bar
   * leaves the page visually untouched. Safe to call when no search is
   * active — Chromium silently no-ops.
   */
  stopFindInPage(args: BrowserStopFindInPageArgs): void {
    const view = this.views.get(browserKey(args));
    if (!view) return;
    view.webContents.stopFindInPage(args.action ?? "clearSelection");
  }

  /**
   * Pause / resume media (video + audio) on a tab and toggle the
   * tab's audio mute. Used by the freeze-on-overlay path: when the
   * page is about to be swapped for a static snapshot, we want media
   * to stop — `setVisible(false)` alone is not enough; Chromium
   * keeps playing the audio track of `<video>` / `<audio>` elements
   * while their parent view is hidden (the visual frame stops being
   * composited, but the audio thread carries on). VS Code exhibits
   * the same "video paused while command palette is open" behaviour
   * we're matching here.
   *
   * Implementation:
   *
   *   - `setAudioMuted(true)` is the immediate, robust silence
   *     primitive. Works for everything — native `<video>`, iframe
   *     embeds (YouTube etc.), WebAudio, MediaSource streams.
   *   - `executeJavaScript` then pauses every `<video>` / `<audio>`
   *     element in the top frame, tagging each with a sentinel
   *     dataset attribute so the resume path knows which elements
   *     to restart (vs. ones the page itself had paused). Top-frame
   *     only — cross-origin iframes (YouTube etc.) can't be
   *     reached from here, but the mute above already silences them
   *     so the user-perceived effect is the same.
   *   - We run the JS even when no media exists; it's a few
   *     microseconds per tab and avoids a roundtrip to check first.
   */
  async pauseMedia(args: BrowserKeyArg): Promise<void> {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    try {
      // Capture the user's pre-freeze mute intent so `resumeMedia`
      // can restore it. A tab the user manually muted should stay
      // muted after the overlay closes.
      this.preFreezeMutedByKey.set(key, view.webContents.isAudioMuted());
      view.webContents.setAudioMuted(true);
      await view.webContents.executeJavaScript(
        `(() => {
           for (const el of document.querySelectorAll("video, audio")) {
             if (!el.paused) {
               el.dataset.__bandFreezeResume = "1";
               el.pause();
             }
           }
         })();`,
        true,
      );
    } catch {
      // Best-effort — view may have been destroyed mid-flight.
    }
  }

  async resumeMedia(args: BrowserKeyArg): Promise<void> {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    try {
      await view.webContents.executeJavaScript(
        `(() => {
           for (const el of document.querySelectorAll("video, audio")) {
             if (el.dataset.__bandFreezeResume === "1") {
               delete el.dataset.__bandFreezeResume;
               // play() returns a Promise that may reject if the page
               // never had user-gesture grant; swallow so a single
               // bad element doesn't block the rest.
               el.play().catch(() => {});
             }
           }
         })();`,
        true,
      );
    } catch {
      // Best-effort — JS sweep may fail on a crashed renderer.
    }
    // Restore the pre-freeze mute state. We only flip it back to
    // unmuted if the tab was unmuted before the freeze; if the user
    // had explicitly muted it (or never went through `pauseMedia`,
    // i.e. no entry in the map), leave it alone. This runs
    // regardless of whether the JS sweep above threw, so a crashed
    // renderer can't leave the tab stuck in our forced-mute state.
    try {
      const wasMuted = this.preFreezeMutedByKey.get(key) ?? false;
      this.preFreezeMutedByKey.delete(key);
      if (!wasMuted) view.webContents.setAudioMuted(false);
    } catch {
      // View may have been destroyed between the JS call and here.
    }
  }

  /**
   * Capture the current rendered frame of a tab as a JPEG data URL.
   *
   * Used by the "freeze-on-overlay" mechanism: when any popover, dialog,
   * dropdown or command palette opens, the renderer captures a snapshot
   * of every visible browser pane, paints it as an `<img>` inside the
   * placeholder, and hides the native `WebContentsView`. Without this
   * the overlay would render *behind* the WebContentsView because it's
   * an OS-level compositor layer above the renderer DOM. Same trick VS
   * Code uses for its command palette / quick-open over webview panels
   * — and confirmed empirically: the captured raster freezes media
   * playback and doesn't reflow on resize, which matches the observed
   * VS Code behaviour.
   *
   * Returns a JPEG (quality 75) rather than the PNG default because
   * the image is a transient overlay backdrop; quality 75 is visually
   * indistinguishable at the typical 1×-2× DPR scales and the base64
   * payload is roughly 5-10× smaller — cheap enough to ship over IPC
   * at popover-open frequency without flooding the channel.
   */
  async capturePage(args: BrowserKeyArg): Promise<string | null> {
    const view = this.views.get(browserKey(args));
    if (!view) return null;
    try {
      const image = await view.webContents.capturePage();
      // Empty image (zero-size view or compositor still warming up).
      if (image.isEmpty()) return null;
      const jpeg = image.toJPEG(75);
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    } catch {
      // Capture can fail if the view was destroyed mid-flight (LRU
      // eviction, explicit close). Treat as "no snapshot available"
      // — the renderer falls back to a blank placeholder.
      return null;
    }
  }

  /**
   * Per-tab zoom. Adjusts `webContents.zoomFactor` on the targeted view
   * by ±`ZOOM_STEP`, or sets it back to `ZOOM_DEFAULT`. The zoom is
   * stored on the WebContents (Electron preserves it across reloads on
   * the same origin, same as Chrome), and is independent of every
   * other tab and of the dashboard's `document.documentElement.style.zoom`.
   *
   * The `direct` overload, taking a view rather than an args bag, lets
   * the menu handler reuse this logic for the
   * "WebContentsView has focus" path without re-resolving the key.
   */
  zoom(args: BrowserZoomArgs): void {
    const view = this.views.get(browserKey(args));
    if (!view) return;
    this.applyZoomAction(view, args.action);
  }

  zoomFocused(action: BrowserZoomArgs["action"]): boolean {
    const view = this.findFocused();
    if (!view) return false;
    this.applyZoomAction(view, action);
    return true;
  }

  /**
   * Return the lowercased hostnames the user has accepted a cert
   * exception for in this session. Renderer-facing catch-up so a
   * dashboard panel restored mid-session can immediately paint the
   * "Not Secure" badge for hosts the user already proceeded to.
   *
   * The full exception store is keyed by `(partition, host,
   * fingerprint)`, but the renderer only needs the host slice to
   * decide whether to flag an address. Dropping partition and
   * fingerprint from the projection keeps the IPC payload tight
   * and avoids exposing the cert fingerprint to the renderer
   * surface.
   */
  getOverriddenHosts(): string[] {
    return Array.from(this.overriddenHosts);
  }

  /**
   * Handle a `band-action://…` link click captured by the per-tab
   * `will-navigate` interceptor. The error pages painted inside the
   * WebContentsView encode all of their buttons as navigations to
   * these URLs (see `browser/error-html.ts`); we never let the
   * "navigation" actually happen — we read the action and dispatch
   * to the matching internal method instead.
   */
  private handleBandAction(key: string, action: BandAction): void {
    const view = this.views.get(key);
    if (!view) {
      dashLog(`handleBandAction: no view for key=${key}`);
      return;
    }
    if (view.webContents.isDestroyed()) {
      dashLog(`handleBandAction: webContents destroyed for key=${key}`);
      return;
    }
    switch (action.kind) {
      case "cert-proceed": {
        const partition = partitionForSession(view.webContents.session);
        this.opts.certExceptions.add({
          partition,
          host: action.host,
          fingerprint: action.fingerprint,
        });
        this.overriddenHosts.add(action.host.toLowerCase());
        // Tell the renderer so its address bar can paint the
        // "Not Secure" badge for this host.
        this.emit(Events.browserHostOverridden, { host: action.host.toLowerCase() });
        const pending = this.pendingCertErrors.get(key);
        this.pendingCertErrors.delete(key);
        dashLog(
          `cert-proceed: host=${action.host} fp=${action.fingerprint} pendingUrl=${pending?.url ?? "(none)"} partition=${partition}`,
        );
        if (pending?.url) {
          void view.webContents.loadURL(pending.url);
        } else {
          // Defensive fallback: lost the pending entry. `reload()`
          // would reload the data: URI we're sitting on, which
          // isn't useful — at least navigate to about:blank so the
          // user is in a clean state.
          void view.webContents.loadURL("about:blank");
        }
        return;
      }
      case "cert-back": {
        this.pendingCertErrors.delete(key);
        void view.webContents.loadURL("about:blank");
        return;
      }
      case "load-retry": {
        const pending = this.pendingLoadErrors.get(key);
        this.pendingLoadErrors.delete(key);
        if (pending?.url) {
          void view.webContents.loadURL(pending.url);
        } else {
          void view.webContents.loadURL("about:blank");
        }
        return;
      }
      case "load-back": {
        this.pendingLoadErrors.delete(key);
        void view.webContents.loadURL("about:blank");
        return;
      }
    }
  }

  /**
   * Toggle Chromium DevTools for the matching tab, docked **inside the
   * tab area** (bottom split) — not as a detached OS window.
   *
   * Approach:
   *
   *   1. Create a sibling `WebContentsView` parented to the same window
   *      as the page view. This sibling will host the DevTools UI.
   *   2. Call `setDevToolsWebContents(devToolsView.webContents)` on the
   *      page view's webContents so Chromium renders its DevTools panel
   *      inside the sibling instead of opening its own window.
   *   3. `openDevTools({ mode: "detach" })` triggers DevTools.
   *      `detach` here just tells Chromium "don't try to embed in a
   *      host window" — the *visual* docking is achieved by our
   *      `applyTabLayout` splitting the bounds between the two views.
   *
   * Toggling again destroys the sibling view and restores the page
   * view to the full bounds.
   */
  toggleDevTools(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    const wc = view.webContents;
    if (wc.isDestroyed()) return;

    const existing = this.devToolsViews.get(key);
    if (existing) {
      // Close the DevTools session, tear down the sibling view, then
      // give the page view the full bounds back.
      try {
        wc.closeDevTools();
      } catch (err) {
        // best-effort: closing on an already-detached state may throw.
        // Log so a real failure in the field is observable, but don't
        // re-throw — the sibling view cleanup below still has to run.
        console.error("toggleDevTools: closeDevTools threw:", err);
      }
      this.removeChildFromParent(key, existing);
      if (!existing.webContents.isDestroyed()) {
        existing.webContents.close();
      }
      this.devToolsViews.delete(key);
      const last = this.lastBoundsByKey.get(key);
      if (last) this.applyTabLayout(key, last);
      return;
    }

    // Create the DevTools-host sibling. Same security flags as the
    // page view — DevTools is just a webpage from Chromium's POV.
    const dt = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const parent = this.parentByKey.get(key) ?? "main";
    const parentWin = this.windowFor(parent);
    parentWin.contentView.addChildView(dt);
    this.devToolsViews.set(key, dt);

    try {
      wc.setDevToolsWebContents(dt.webContents);
      wc.openDevTools({ mode: "detach" });
    } catch (err) {
      // If wiring the sibling fails for any reason, fall back to
      // detached-window DevTools so the user still gets something.
      this.removeChildFromParent(key, dt);
      if (!dt.webContents.isDestroyed()) dt.webContents.close();
      this.devToolsViews.delete(key);
      console.error("setDevToolsWebContents failed, falling back to detached:", err);
      try {
        wc.openDevTools({ mode: "detach" });
      } catch {}
      return;
    }

    // Match page-view visibility (the tab may currently be hidden —
    // e.g. parked while another workspace is active). Showing the
    // DevTools sibling while its page view is hidden would paint the
    // panel over the workspace. We track visibility in `visibleByKey`
    // because `WebContentsView` has a setter but no public getter.
    const pageVisible = this.visibleByKey.get(key) ?? true;
    dt.setVisible(pageVisible);
    const last = this.lastBoundsByKey.get(key);
    if (last) this.applyTabLayout(key, last);
  }

  private applyZoomAction(view: WebContentsView, action: BrowserZoomArgs["action"]): void {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    let next: number;
    if (action === "reset") {
      next = ZOOM_DEFAULT;
    } else {
      const current = wc.zoomFactor;
      next = action === "in" ? current + ZOOM_STEP : current - ZOOM_STEP;
    }
    // Clamp + round to 0.01 to avoid floating-point drift across many
    // steps (0.1 * 7 = 0.7000000000000001 etc.).
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    wc.zoomFactor = Math.round(clamped * 100) / 100;
  }

  destroy(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    // If DevTools is docked for this tab, tear down the sibling view
    // first so we don't leak a WebContentsView whose page view is
    // gone. Close the DevTools session on the page webContents first
    // (mirrors `toggleDevTools`'s close path) — the page view is
    // destroyed seconds later anyway so the call is best-effort, but
    // keeping the two paths symmetric avoids surprises.
    const dt = this.devToolsViews.get(key);
    if (dt) {
      if (!view.webContents.isDestroyed()) {
        try {
          view.webContents.closeDevTools();
        } catch (err) {
          console.error("destroy: closeDevTools threw:", err);
        }
      }
      this.removeChildFromParent(key, dt);
      if (!dt.webContents.isDestroyed()) dt.webContents.close();
      this.devToolsViews.delete(key);
    }
    const parent = this.parentByKey.get(key) ?? "main";
    const win =
      parent === "hidden" && this.opts.hiddenWindow ? this.opts.hiddenWindow : this.opts.mainWindow;
    win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.views.delete(key);
    this.parentByKey.delete(key);
    this.lastBoundsByKey.delete(key);
    this.visibleByKey.delete(key);
    this.pendingCertErrors.delete(key);
    this.pendingLoadErrors.delete(key);
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    // Notify the renderer (which forwards to the web server's
    // `browserHost.viewDestroyed` mutation) so the cached
    // bandTabId→cdpTargetId mapping can be cleared. Without this, the
    // next stream attempt would resolve a stale targetId and then close
    // immediately on the upstream WS error path.
    const payload: BrowserViewDestroyedPayload = {
      browser_id: key,
      workspace_id: key,
    };
    this.emit(Events.browserViewDestroyed, payload);
  }

  /**
   * Return the live `WebContentsView` that currently has keyboard focus,
   * or `null` if none does. Used by the main-process menu handler to
   * route Cmd+R to "reload the page the user is in" instead of "reload
   * the dashboard". `isDestroyed()` is checked defensively because a
   * tab can be torn down between the menu firing and this lookup.
   */
  findFocused(): WebContentsView | null {
    // Iterating `this.views.values()` (Map insertion order) is fine
    // here — keyboard focus is exclusive, so at most one view can
    // match, and the order doesn't affect the result. Do NOT switch
    // to `this.order` (LRU order); that's only used for eviction.
    for (const view of this.views.values()) {
      if (view.webContents.isDestroyed()) continue;
      if (view.webContents.isFocused()) return view;
    }
    return null;
  }

  /**
   * Hide every tracked view. The Rust impl ignores `workspace_id`.
   *
   * Docked DevTools siblings must be hidden in lockstep — otherwise an
   * open DevTools panel stays painted over the workspace when the user
   * switches away (the page view goes invisible but its sibling
   * doesn't).
   */
  hideAll(): void {
    for (const id of this.order) this.setTabVisibility(id, false);
  }

  /** Show every tracked view. The Rust impl ignores `workspace_id`. */
  showAll(): void {
    for (const id of this.order) this.setTabVisibility(id, true);
  }

  /**
   * Tear everything down (called on app quit). Mirrors the Tauri close
   * handler that walks `browser-` labelled webviews.
   */
  destroyAll(): void {
    for (const id of [...this.order]) {
      this.destroy({ browserId: id });
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private touch(key: string): void {
    const idx = this.order.indexOf(key);
    if (idx >= 0) {
      this.order.splice(idx, 1);
      this.order.push(key);
    }
  }

  private enforceLru(): void {
    while (this.order.length >= MAX_BROWSER_VIEWS) {
      const oldest = this.order[0];
      if (oldest === undefined) break;
      this.destroy({ browserId: oldest });
    }
  }

  private applyBounds(
    view: WebContentsView,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  private requireView(key: string): WebContentsView {
    const view = this.views.get(key);
    if (!view) throw new Error(`Browser webview not found: ${key}`);
    return view;
  }

  /**
   * Construct + register a `WebContentsView` for the given key, load the URL,
   * and place it in the **hidden window** at full bounds with
   * `setVisible(true)`. Shared by `create()` (which then migrates to the
   * main window via `moveTo()` and applies UI-driven bounds) and
   * `ensure()` (which leaves the view in the hidden window where the
   * compositor runs out of sight).
   */
  private spawn(url: string, key: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.wireEvents(key, view);
    if (this.opts.hiddenWindow) {
      // CDP screencast enabled — host fresh views in the hidden window
      // with full bounds so the compositor runs even before the desktop
      // UI positions them.
      this.opts.hiddenWindow.contentView.addChildView(view);
      this.parentByKey.set(key, "hidden");
      view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
      view.setVisible(true);
      this.visibleByKey.set(key, true);
    } else {
      // CDP screencast disabled — original behavior. create() will
      // immediately call applyBounds + setVisible to position the view
      // inside the main window.
      this.opts.mainWindow.contentView.addChildView(view);
      this.parentByKey.set(key, "main");
    }
    void view.webContents.loadURL(url);

    this.views.set(key, view);
    this.order.push(key);
    return view;
  }

  /**
   * Migrate a view between the main and hidden windows. No-op if the view
   * is already parented to the requested target, or if the hidden window
   * isn't configured (CDP screencast disabled — every view stays in the
   * main window). Bounds are preserved across the migration; callers
   * reposition via `applyBounds` if they want different bounds in the
   * new parent.
   */
  private moveTo(key: string, view: WebContentsView, target: Parent): void {
    if (!this.opts.hiddenWindow) return;
    const current = this.parentByKey.get(key);
    if (current === target) return;
    const fromWin = current === "main" ? this.opts.mainWindow : this.opts.hiddenWindow;
    const toWin = target === "main" ? this.opts.mainWindow : this.opts.hiddenWindow;
    fromWin.contentView.removeChildView(view);
    toWin.contentView.addChildView(view);
    // The docked DevTools sibling has to follow — its `webContents`
    // hosts the DevTools UI for `view`, and Chromium requires that
    // sibling to be attached to a compositing window (else the
    // DevTools panel goes blank).
    const dt = this.devToolsViews.get(key);
    if (dt) {
      fromWin.contentView.removeChildView(dt);
      toWin.contentView.addChildView(dt);
    }
    this.parentByKey.set(key, target);
  }

  /**
   * Single funnel for setting a tab's visibility. Mirrors `setVisible`
   * on the page view AND its docked DevTools sibling (if any), and
   * caches the state in `visibleByKey` so other code paths (e.g.
   * `toggleDevTools` opening DevTools on an already-hidden tab) can
   * read the current visibility without a getter on `WebContentsView`.
   */
  private setTabVisibility(key: string, visible: boolean): void {
    this.views.get(key)?.setVisible(visible);
    this.devToolsViews.get(key)?.setVisible(visible);
    this.visibleByKey.set(key, visible);
  }

  /** Resolve the BrowserWindow for a `Parent` enum value. */
  private windowFor(parent: Parent): BrowserWindow {
    return parent === "hidden" && this.opts.hiddenWindow
      ? this.opts.hiddenWindow
      : this.opts.mainWindow;
  }

  /** Detach a child view from whichever window currently parents the
   *  matching tab. Used when tearing down the DevTools sibling. */
  private removeChildFromParent(key: string, child: WebContentsView): void {
    const parent = this.parentByKey.get(key) ?? "main";
    this.windowFor(parent).contentView.removeChildView(child);
  }

  /**
   * Apply the renderer-reported bounds to the tab. When DevTools is
   * docked, the bounds are split: page view gets the top portion, the
   * DevTools sibling gets the bottom `DEVTOOLS_SPLIT_RATIO` (clamped to
   * a minimum height so the panel stays usable on short windows).
   */
  private applyTabLayout(
    key: string,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    const view = this.views.get(key);
    if (!view) return;
    const dt = this.devToolsViews.get(key);
    if (!dt) {
      this.applyBounds(view, bounds);
      return;
    }
    // Delegate the geometry to the pure helper in `./layout.ts` so the
    // splitting logic can be exercised in tests without an Electron
    // import. The helper guarantees `page.height + dev.height ===
    // bounds.height`, even on short windows where the natural clamps
    // would otherwise overlap.
    const { page, dev } = splitTabBounds(bounds, {
      splitRatio: DEVTOOLS_SPLIT_RATIO,
      devMinHeight: DEVTOOLS_MIN_HEIGHT,
      pageMinHeight: PAGE_MIN_HEIGHT,
    });
    this.applyBounds(view, page);
    this.applyBounds(dt, dev);
  }

  private wireEvents(key: string, view: WebContentsView): void {
    // The renderer's two modes (workspace-keyed vs browser-keyed)
    // destructure different field names. We populate both with the same
    // value so either filter matches. The opposite key matches because
    // the renderer compares `event.payload.workspace_id !== workspaceIdRef`
    // (and similarly for browser_id), and the local ref equals the key
    // we used at creation time.
    const emitUrl = (url: string, loading: boolean): void => {
      const payload: BrowserUrlChangedPayload = {
        url,
        browser_id: key,
        workspace_id: key,
        loading,
      };
      this.emit(Events.browserUrlChanged, payload);
    };

    // ---- URL & loading state ----
    // `did-start-navigation` carries the *target* URL of a pending
    // navigation, so we can update the address bar the moment the user
    // clicks a link (or types and submits one). Using
    // `did-start-loading` here was wrong: that event fires before the
    // navigation is committed, and `webContents.getURL()` at that point
    // still returns the OLD document's URL — so the renderer would
    // overwrite the user's freshly-typed URL with the previous one and
    // only "snap back" when `did-stop-loading` arrived.
    //
    // Notes:
    //   - We only react to *main-frame* navigations. Iframe and
    //     subresource loads must not touch the address bar.
    //   - Same-document transitions (hash changes, History API
    //     pushState) don't trigger a network load, so we set
    //     `loading: false` for them. They still need an emit because
    //     the URL itself changes and the address bar should reflect it.
    //   - Redirect chains fire `did-start-navigation` for each hop, so
    //     the address bar follows the redirect — matches Chrome's UX.
    view.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      // ---- band-action:… interceptor (issue #444 cast follow-up) ----
      // The in-view error pages encode button clicks as navigations
      // to a sentinel `band-action://` URL. Chromium has no idea
      // what that scheme is, so without intercepting it would commit
      // the navigation, fail to load, and leave the tab on the
      // unknown-scheme URL.
      //
      // Lenient prefix match: Chromium normalises non-standard
      // schemes inconsistently — sometimes drops the authority
      // slashes (so `band-action:cert-proceed?…`), sometimes adds
      // a trailing slash. The check + parser tolerate both.
      //
      // CRITICAL: we DEFER the new loadURL via setImmediate.
      // Calling `webContents.loadURL()` synchronously from inside
      // `did-start-navigation` re-enters Chromium's navigation
      // pipeline while it's still processing the start of the
      // current navigation — that reentrancy crashes the main
      // process with `EXC_BREAKPOINT` deep inside V8. setImmediate
      // lets the event handler return first.
      //
      // We deliberately do NOT call `webContents.stop()` here.
      // Chromium fires `did-fail-load` for `band-action://` almost
      // immediately (unknown scheme → ERR_UNKNOWN_URL_SCHEME), so
      // by the time setImmediate fires the navigation has already
      // aborted on its own. Calling stop() risked cancelling the
      // brand-new loadURL we're about to issue and was observed to
      // leave the WebContentsView blank after Proceed.
      //
      // Why not `will-navigate`? On Electron 35 it doesn't fire for
      // unknown URL schemes (Chromium's external-protocol handling
      // short-circuits it). `did-start-navigation` always fires.
      if (details.url.startsWith("band-action:")) {
        const action = parseBandAction(details.url);
        dashLog(
          `band-action did-start-navigation url=${details.url} parsed=${action ? action.kind : "null"}`,
        );
        setImmediate(() => {
          if (view.webContents.isDestroyed()) return;
          if (action) this.handleBandAction(key, action);
        });
        return;
      }
      // Skip URL emissions for the in-view error pages we load via
      // `data:` URIs. The renderer's address bar should keep showing
      // the failing target URL, not the data URI we use to paint
      // the interstitial.
      if (details.url.startsWith("data:")) return;
      // Clear any pending error as soon as a real main-frame
      // navigation starts. Covers Back-to-safety navigating away
      // and Proceed triggering a reload. The data: URI loads we do
      // ourselves are filtered above, so they don't accidentally
      // wipe the pending entries before the user has acted.
      if (!details.isSameDocument) {
        this.pendingCertErrors.delete(key);
        this.pendingLoadErrors.delete(key);
      }
      emitUrl(details.url, !details.isSameDocument);
    });
    // `did-stop-loading` is still the right signal for "the load
    // finished" — flips the loading indicator off and re-emits the
    // (now-committed) URL, which corrects any drift if the final URL
    // differs from what `did-start-navigation` reported (e.g. a 3xx
    // chain that resolved server-side). `data:` and `band-action`
    // are filtered for the same reasons as above so error-page
    // loads / action clicks don't clobber the address bar.
    view.webContents.on("did-stop-loading", () => {
      const url = view.webContents.getURL();
      if (url.startsWith("data:")) return;
      // Lenient `band-action:` match — see did-start-navigation block.
      if (url.startsWith("band-action:")) return;
      emitUrl(url, false);
    });

    // Primary `band-action://` interceptor — fires before the
    // navigation commits when Electron honours it. The `did-start-
    // navigation` block above is the safety net for the cases where
    // it doesn't (e.g. unknown URL schemes on some Electron versions).
    view.webContents.on("will-navigate", (event, navUrl) => {
      const action = parseBandAction(navUrl);
      if (!action) return;
      event.preventDefault();
      this.handleBandAction(key, action);
    });
    view.webContents.on("page-title-updated", (_e, title) => {
      const payload: BrowserTitleChangedPayload = {
        browser_id: key,
        workspace_id: key,
        title,
      };
      this.emit(Events.browserTitleChanged, payload);
    });

    // ---- TLS interstitial (issue #444) ----
    // The session-wide `setCertificateVerifyProc` registered in
    // `main/index.ts` is the single source of truth for cert
    // override decisions. It returns `callback(0)` (trust) for
    // hosts the user has accepted in this session, so by the time
    // THIS event fires, we know the cert was NOT in the exception
    // store and the user needs to see the interstitial.
    //
    // Our job here is purely UI: capture the metadata, stash it
    // so the band-action://cert-proceed link can read host +
    // fingerprint, emit a URL change so the address bar shows the
    // failing target with loading=false, and (deferred) loadURL
    // the interstitial HTML into the WebContentsView.
    view.webContents.on("certificate-error", (event, url, errorCode, certificate, callback) => {
      event.preventDefault();
      const payload = buildCertErrorPayload({
        key,
        url,
        errorCode,
        certificate: {
          fingerprint: certificate.fingerprint,
          subjectName: certificate.subjectName,
          issuerName: certificate.issuerName,
          validStart: certificate.validStart,
          validExpiry: certificate.validExpiry,
        },
      });
      this.pendingCertErrors.set(key, payload);
      dashLog(`cert-error: ${payload.host} fp=${payload.fingerprint} → interstitial`);
      // Tell the renderer the failing URL committed (with
      // loading=false) so the address bar reflects it and the
      // spinner stops. The `data:` URI load below is filtered.
      emitUrl(url, false);
      callback(false);
      const html = buildCertErrorHtml({
        url,
        host: payload.host,
        errorCode: payload.error_code,
        errorDescription: payload.error_description,
        certificate: {
          fingerprint: certificate.fingerprint,
          subjectName: certificate.subjectName,
          issuerName: certificate.issuerName,
          validStart: certificate.validStart,
          validExpiry: certificate.validExpiry,
        },
      });
      // DEFER via setImmediate — calling `loadURL` synchronously
      // from a Chromium event handler that still has navigation
      // state on the stack has caused main-process crashes deep
      // inside V8.
      setImmediate(() => {
        if (view.webContents.isDestroyed()) return;
        void view.webContents.loadURL(htmlToDataUrl(html));
      });
    });

    // ---- Generic load-failure error page ----
    // Companion to the cert flow above: catches `did-fail-load` for
    // main-frame DNS / connection / timeout / etc. failures and
    // paints a Chrome-style "This site can't be reached" page
    // directly into the view. Same screencast-friendly rationale:
    // remote viewers see the error and can click Reload / Back.
    //
    // Filters out user-aborted navigations and the cert error range
    // — the per-tab `certificate-error` listener above owns those,
    // and we don't want both pages to fight over the same tab. See
    // `browser/load-error.ts` for the filter rules.
    view.webContents.on(
      "did-fail-load",
      (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrameFailure({ errorCode, isMainFrame })) return;
        // Skip failures for our own internal URLs:
        //
        //   - `band-action://…` is the sentinel scheme our in-view
        //     buttons navigate to. Chromium has no handler for it
        //     and emits `did-fail-load` with ERR_UNKNOWN_URL_SCHEME
        //     (-300) — but the `did-start-navigation` interceptor
        //     above already deferred the real proceed/back/retry
        //     work via setImmediate. Reacting here too would queue
        //     a SECOND setImmediate that races the first and
        //     overwrites the loaded page with the load-error UI.
        //   - `data:` URIs are how we paint our own error pages.
        //     They shouldn't fail-load in normal operation, but if
        //     Chromium ever reports one we don't want to recurse
        //     into another error page.
        // Lenient `band-action:` match — see did-start-navigation block.
        if (validatedURL.startsWith("band-action:")) return;
        if (validatedURL.startsWith("data:")) return;
        const payload = buildLoadErrorPayload({
          key,
          url: validatedURL,
          errorCode,
        });
        this.pendingLoadErrors.set(key, payload);
        // Keep the address bar pointing at the failing URL with
        // loading=false; the data: URI load below is filtered.
        emitUrl(validatedURL, false);
        const html = buildLoadErrorHtml({
          url: validatedURL,
          errorCode,
          errorName: payload.error_name,
          headline: payload.headline,
          description: payload.description,
        });
        // DEFER — see the matching block in the cert-error handler.
        setImmediate(() => {
          if (view.webContents.isDestroyed()) return;
          void view.webContents.loadURL(htmlToDataUrl(html));
        });
      },
    );

    // ---- Find in page: stream results back to the renderer ----
    // Chromium emits at least one `found-in-page` per `findInPage(text)`
    // call. Large pages emit incremental updates as the scan walks the
    // DOM — the renderer only trusts `final_update: true`, but rendering
    // intermediate counts gives the find bar a snappy feel.
    view.webContents.on("found-in-page", (_e, result) => {
      const payload: BrowserFoundInPagePayload = {
        browser_id: key,
        workspace_id: key,
        request_id: result.requestId,
        active_match_ordinal: result.activeMatchOrdinal,
        matches: result.matches,
        final_update: result.finalUpdate,
      };
      this.emit(Events.browserFoundInPage, payload);
    });

    // ---- Cmd+F / Ctrl+F intercept while the webview has focus ----
    // The renderer's DOM-level keydown listener never sees keys typed
    // while focus is inside the child `WebContentsView` — Chromium
    // handles them in the embedded page process. Intercept here so the
    // shortcut still pops the find bar even when the user is focused on
    // the rendered page (e.g. just clicked a link).
    //
    // `event.preventDefault()` swallows the key so Chromium doesn't also
    // trigger any builtin shortcut (none exists for Cmd+F in
    // WebContentsView today, but defensive against future Chromium
    // changes).
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.shift || input.alt) return;
      const modifier =
        process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
      if (!modifier) return;
      const pressedKey = input.key.toLowerCase();
      // Transfer keyboard focus back to the main window's webContents so
      // the React side (find bar input, new-tab address bar, etc.)
      // receives subsequent keystrokes instead of the WebContentsView
      // the user was just typing into. Shared by every shortcut below.
      const handleShortcut = (eventName: string, payload: BrowserFindShortcutPayload) => {
        event.preventDefault();
        if (!this.opts.mainWindow.webContents.isDestroyed()) {
          this.opts.mainWindow.webContents.focus();
        }
        this.emit(eventName, payload);
      };
      // Cmd+F / Ctrl+F → open the find bar for this tab.
      if (pressedKey === "f") {
        handleShortcut(Events.browserFindShortcut, {
          browser_id: key,
          workspace_id: key,
        } satisfies BrowserFindShortcutPayload);
        return;
      }
      // Cmd+T / Ctrl+T → open a new sibling browser tab in the same
      // dockview group. The renderer's `DockviewBrowserContainer`
      // already handles Cmd+T when DOM focus is inside it; we forward
      // the same intent for the case where Chromium consumed the
      // keydown inside the WebContentsView.
      if (pressedKey === "t") {
        handleShortcut(Events.browserNewTabShortcut, {
          browser_id: key,
          workspace_id: key,
        } satisfies BrowserNewTabShortcutPayload);
        return;
      }
    });
  }

  private emit(event: string, payload: unknown): void {
    const target = this.opts.mainWindow.webContents;
    if (target.isDestroyed()) return;
    target.send(event, payload);
  }
}
