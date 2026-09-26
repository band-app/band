/**
 * Main-process side of Band's browser tabs.
 *
 * A browser tab is a `<webview>` the renderer mounts inside its pane, so
 * Band's own menus, dialogs and tooltips stack over the page with ordinary
 * CSS. The renderer drives the element directly (navigation, find-in-page,
 * zoom). What stays here is what only the main process can do:
 *
 *   - Guest policy. `attachGuest` runs from the dashboard's
 *     `did-attach-webview` (after `will-attach-webview` admitted and
 *     hardened the guest, see `guest-policy.ts`) and wires the per-guest
 *     handlers before the page can act: navigation allowlist, popups
 *     routed to new Band tabs, the in-view cert and load-error pages,
 *     pane shortcuts that the guest would otherwise swallow.
 *   - Tab identity. The pane reports its guest's WebContents id with
 *     `registerGuest`; events are keyed by that Band browser id and the
 *     CDP bridge resolves a tab to its WebContents through it.
 *   - Ensure-only tabs. The CDP screencast bridge can ask for a tab that
 *     no pane has mounted (an agent working in a workspace the user never
 *     opened). Those get an offscreen `WebContentsView` in the hidden
 *     window. When a pane later mounts the tab, its guest takes over and
 *     the offscreen page is closed; the pane adopts its URL.
 *   - DevTools docking. The pane mounts a second `<webview>` below the
 *     page and `openDevTools` points the page's DevTools at it.
 *
 * Every page WebContents (guest or offscreen) is wired by `wireEvents`, so
 * cert handling, error pages and URL events behave the same for both.
 */

import {
  type BrowserWindow,
  type Input,
  type Session,
  type WebContents,
  WebContentsView,
  webContents,
} from "electron";
import { createLogger } from "../main/services/log.js";
import { Events } from "../shared/ipc-channels.js";
import type {
  BrowserEnsureArgs,
  BrowserGuestShortcutPayload,
  BrowserKeyArg,
  BrowserOpenDevToolsArgs,
  BrowserOpenWindowPayload,
  BrowserRegisterGuestArgs,
  BrowserRegisterGuestResult,
  BrowserTitleChangedPayload,
  BrowserUrlChangedPayload,
  BrowserViewDestroyedPayload,
} from "../shared/types.js";
import { type BrowserCertErrorPayload, buildCertErrorPayload, hostFromUrl } from "./cert-error.js";
import { type CertExceptionStore, partitionForSession } from "./cert-exceptions.js";
import {
  type BandAction,
  buildCertErrorHtml,
  buildLoadErrorHtml,
  htmlToDataUrl,
  parseBandAction,
} from "./error-html.js";
import { admitWebviewAttach, isAllowedGuestNavigation } from "./guest-policy.js";
import {
  type BrowserLoadErrorPayload,
  buildLoadErrorPayload,
  isMainFrameFailure,
} from "./load-error.js";
import { isRetiredProfile, partitionForProfile, sessionForProfile } from "./profiles.js";
import { decideWindowOpenAction } from "./window-open.js";

const log = createLogger("guest-manager");

/** Cap on ensure-only offscreen pages. Guests mounted by panes are bounded
 *  by the renderer's hidden-workspace budget instead. */
const MAX_OFFSCREEN_VIEWS = 10;

export interface GuestManagerOptions {
  /** The dashboard window. Its webContents hosts every `<webview>` guest
   *  and receives the events below. */
  mainWindow: BrowserWindow;
  /**
   * Never-user-visible window that hosts ensure-only offscreen pages.
   * Chromium parks the compositor (breaking screencast and
   * captureScreenshot) for a view whose parent isn't on screen; the hidden
   * window counts as visible while the user never sees it. Created only
   * when the CDP screencast experiment is on (`webBrowserCdpEnabled`),
   * which is also the only time `ensure` is called.
   */
  hiddenWindow?: BrowserWindow;
  /**
   * Session-scoped TLS exception store for the in-view cert
   * interstitial (issue #444). Owned by the bootstrap so accepted
   * exceptions survive for the whole session. The per-guest
   * `certificate-error` listener reads it to decide whether to trust a
   * cert (matched triple) or paint the interstitial.
   */
  certExceptions: CertExceptionStore;
}

export class BrowserGuestManager {
  /** Guests that passed `will-attach-webview` and had their policy wired.
   *  Only these can be registered as a tab or used as a DevTools host, so
   *  a renderer cannot point us at an arbitrary WebContents. */
  private readonly attachedGuestIds = new Set<number>();
  /** Band browser id → the WebContents currently backing that tab
   *  (a registered guest or an offscreen page). */
  private readonly pageByKey = new Map<string, WebContents>();
  /** Reverse of `pageByKey`, used to key events fired by a WebContents. */
  private readonly keyByWebContentsId = new Map<number, string>();
  /** Ensure-only offscreen pages, oldest first. */
  private readonly offscreenViews = new Map<string, WebContentsView>();
  /** Guests hosting a tab's docked DevTools. Never registered as tabs. */
  private readonly devToolsHostIds = new Set<number>();
  /**
   * Pending cert-error per page WebContents id, captured when Chromium
   * fires `certificate-error`. Lives until the user clicks "Proceed"
   * (records an exception and reloads) or "Back to safety", or a new
   * main-frame navigation starts. Validates the `band-action://`
   * cert-proceed link against what we actually showed.
   */
  private readonly pendingCertErrors = new Map<number, BrowserCertErrorPayload>();
  /**
   * Pending generic navigation error per page WebContents id (DNS,
   * refused, timeout, …), captured from `did-fail-load`. The cert
   * variant takes precedence so the two never coexist (the
   * `did-fail-load` listener filters codes in the cert-error range).
   */
  private readonly pendingLoadErrors = new Map<number, BrowserLoadErrorPayload>();
  /**
   * Lowercased hostnames the user has clicked Proceed on this session.
   * Distinct from the `CertExceptionStore` (keyed by
   * `(partition, host, fingerprint)`): this is the host-only projection
   * the dashboard chrome needs to paint a "Not Secure" badge.
   */
  private readonly overriddenHosts = new Set<string>();
  /** CDP target id per page WebContents, resolved on first request. */
  private readonly targetIdByWebContentsId = new Map<number, string>();

  constructor(private readonly opts: GuestManagerOptions) {}

  /**
   * Wire policy and events onto a freshly attached `<webview>` guest. Called
   * from the dashboard's `did-attach-webview`, before the guest's first
   * navigation can open a popup or hit a cert error.
   */
  attachGuest(guest: WebContents): void {
    const id = guest.id;
    this.attachedGuestIds.add(id);
    prepareBrowserSession(guest.session);
    this.installNavigationGuard(guest);
    this.wireEvents(guest);
    guest.once("destroyed", () => this.forgetWebContents(id));
  }

  /**
   * Tie a guest to its Band tab id. Refuses anything that is not a
   * `<webview>` guest we attached in the dashboard window, or that already
   * hosts DevTools. A guest that replaces an earlier one for the same tab
   * (the pane re-mounted it) takes over the id. An ensure-only offscreen
   * page for the tab is closed, and its URL returned for the pane to adopt.
   */
  registerGuest(args: BrowserRegisterGuestArgs): BrowserRegisterGuestResult {
    const guest = this.attachedGuest(args.webContentsId);
    if (!guest || this.devToolsHostIds.has(guest.id)) {
      log.warn({ browserId: args.browserId }, "registerGuest: refused unknown guest");
      return { ok: false, adoptUrl: null };
    }
    let adoptUrl: string | null = null;
    const offscreen = this.offscreenViews.get(args.browserId);
    if (offscreen) {
      adoptUrl = committedUrl(offscreen.webContents);
      this.closeOffscreen(args.browserId);
    }
    // A guest re-registered under another tab id leaves its old id.
    const oldKey = this.keyByWebContentsId.get(guest.id);
    if (oldKey !== undefined && oldKey !== args.browserId && this.pageByKey.get(oldKey) === guest) {
      this.pageByKey.delete(oldKey);
      this.emitViewDestroyed(oldKey);
    }
    const previous = this.pageByKey.get(args.browserId);
    if (previous && previous.id !== guest.id) {
      this.keyByWebContentsId.delete(previous.id);
      this.emitViewDestroyed(args.browserId);
    }
    this.pageByKey.set(args.browserId, guest);
    this.keyByWebContentsId.set(guest.id, args.browserId);
    return { ok: true, adoptUrl };
  }

  /**
   * Create-or-return-existing for the CDP bridge (`browserHost.ensureView`).
   * A tab with a registered guest needs nothing. Otherwise the tab gets an
   * offscreen page in the hidden window, sized so its compositor runs.
   */
  ensure(args: BrowserEnsureArgs): void {
    if (this.pageByKey.has(args.browserId)) {
      const offscreen = this.offscreenViews.get(args.browserId);
      if (offscreen) this.touchOffscreen(args.browserId, offscreen);
      return;
    }
    const hidden = this.opts.hiddenWindow;
    if (!hidden) throw new Error("No offscreen host: the CDP screencast experiment is off");
    while (this.offscreenViews.size >= MAX_OFFSCREEN_VIEWS) {
      const oldest = this.offscreenViews.keys().next().value;
      if (oldest === undefined) break;
      this.closeOffscreen(oldest);
    }
    // The tab's browser profile, or Default for a profile deleted this run.
    const profileId = isRetiredProfile(args.profileId) ? null : (args.profileId ?? null);
    const partition = partitionForProfile(profileId);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition,
      },
    });
    const wc = view.webContents;
    prepareBrowserSession(wc.session);
    this.installNavigationGuard(wc);
    this.wireEvents(wc);
    wc.once("destroyed", () => this.forgetWebContents(wc.id));
    hidden.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    this.offscreenViews.set(args.browserId, view);
    this.pageByKey.set(args.browserId, wc);
    this.keyByWebContentsId.set(wc.id, args.browserId);
    // The URL comes from the server's tab record, which anything can write;
    // hold it to the same rule as a guest's first `src`.
    const url = admitWebviewAttach({ src: args.url, partition }) ? args.url : "about:blank";
    void wc.loadURL(url);
  }

  /**
   * Return the chromium CDP targetId for the tab. The web server's
   * `browser-host` uses it to address the right `/devtools/page/<id>`
   * endpoint when proxying CDP traffic. The targetId is queried via the
   * per-`webContents` debugger API, then the debugger is detached so the
   * shared `--remote-debugging-port` channel stays usable.
   *
   * Throws if the tab has no page.
   */
  async getCdpTargetId(args: BrowserKeyArg): Promise<string> {
    const wc = this.pageByKey.get(args.browserId);
    if (!wc || wc.isDestroyed()) throw new Error(`Browser page not found: ${args.browserId}`);
    // A WebContents keeps its target id for life; resolve it once.
    const cached = this.targetIdByWebContentsId.get(wc.id);
    if (cached) return cached;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      dbg.attach("1.3");
    }
    try {
      const result = (await dbg.sendCommand("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const targetId = result.targetInfo?.targetId;
      if (typeof targetId !== "string" || !targetId) {
        throw new Error(`Target.getTargetInfo returned no targetId for ${args.browserId}`);
      }
      this.targetIdByWebContentsId.set(wc.id, targetId);
      return targetId;
    } finally {
      try {
        dbg.detach();
      } catch {
        // best-effort: detach may have happened already
      }
    }
  }

  /**
   * Dock the tab's DevTools into the pane's DevTools `<webview>`, the
   * bottom split of the tab area. `setDevToolsWebContents` makes Chromium
   * render the DevTools frontend inside that guest; `mode: "detach"` only
   * tells Chromium not to embed it in a host window of its own. Returns
   * false when either guest is unknown, so the pane can close its split.
   */
  openDevTools(args: BrowserOpenDevToolsArgs): boolean {
    const page = this.pageByKey.get(args.browserId);
    const host = this.attachedGuest(args.devToolsWebContentsId);
    if (!page || page.isDestroyed() || !host || this.keyByWebContentsId.has(host.id)) {
      return false;
    }
    if (!this.attachedGuestIds.has(page.id)) return false; // offscreen pages have no pane
    this.devToolsHostIds.add(host.id);
    try {
      if (page.isDevToolsOpened()) page.closeDevTools();
      page.setDevToolsWebContents(host);
      page.openDevTools({ mode: "detach", activate: false });
      return true;
    } catch (err) {
      // The pane drops this host on `false`; don't leave it marked meanwhile.
      this.devToolsHostIds.delete(host.id);
      log.error({ err: String(err), browserId: args.browserId }, "openDevTools failed");
      return false;
    }
  }

  closeDevTools(args: BrowserKeyArg): void {
    const page = this.pageByKey.get(args.browserId);
    if (!page || page.isDestroyed()) return;
    try {
      page.closeDevTools();
    } catch (err) {
      log.error({ err: String(err), browserId: args.browserId }, "closeDevTools failed");
    }
  }

  /**
   * Return the lowercased hostnames the user has accepted a cert
   * exception for in this session. Renderer-facing catch-up so a pane
   * restored mid-session can immediately paint the "Not Secure" badge.
   * The exception store's partition and fingerprint stay out of the IPC
   * payload; the renderer only needs the host.
   */
  getOverriddenHosts(): string[] {
    return Array.from(this.overriddenHosts);
  }

  /** Close every offscreen page (app quit). Guests go with their window. */
  /**
   * Stop every page running in a profile that is being deleted, so none
   * writes storage back while its partition is wiped. Offscreen pages are
   * closed. Pane guests belong to the renderer, which remounts them in
   * Default once the profile is gone; until then they are parked on
   * about:blank.
   */
  stopProfilePages(profileId: string): void {
    const sess = sessionForProfile(profileId);
    for (const [key, view] of [...this.offscreenViews]) {
      if (view.webContents.session === sess) this.closeOffscreen(key);
    }
    for (const id of this.attachedGuestIds) {
      const guest = this.attachedGuest(id);
      if (guest && guest.session === sess) void guest.loadURL("about:blank");
    }
  }

  destroyAll(): void {
    for (const key of [...this.offscreenViews.keys()]) this.closeOffscreen(key);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** A live `<webview>` guest of the dashboard window that we attached. */
  private attachedGuest(webContentsId: number): WebContents | null {
    if (!this.attachedGuestIds.has(webContentsId)) return null;
    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return null;
    if (guest.hostWebContents?.id !== this.opts.mainWindow.webContents.id) return null;
    return guest;
  }

  private touchOffscreen(key: string, view: WebContentsView): void {
    this.offscreenViews.delete(key);
    this.offscreenViews.set(key, view);
  }

  private closeOffscreen(key: string): void {
    const view = this.offscreenViews.get(key);
    if (!view) return;
    this.offscreenViews.delete(key);
    this.opts.hiddenWindow?.contentView.removeChildView(view);
    // `forgetWebContents` runs from the `destroyed` listener and emits the
    // view-destroyed event for this key.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** Drop every trace of a page or DevTools WebContents once it is gone. */
  private forgetWebContents(id: number): void {
    this.attachedGuestIds.delete(id);
    this.devToolsHostIds.delete(id);
    this.pendingCertErrors.delete(id);
    this.pendingLoadErrors.delete(id);
    this.targetIdByWebContentsId.delete(id);
    const key = this.keyByWebContentsId.get(id);
    if (key === undefined) return;
    this.keyByWebContentsId.delete(id);
    if (this.pageByKey.get(key)?.id === id) {
      this.pageByKey.delete(key);
      this.emitViewDestroyed(key);
    }
  }

  private emitViewDestroyed(key: string): void {
    // The renderer forwards this to the server's `browserHost.viewDestroyed`
    // so the cached bandTabId → cdpTargetId mapping is cleared. Without it
    // the next stream attempt would resolve a stale targetId.
    const payload: BrowserViewDestroyedPayload = { browser_id: key };
    this.emit(Events.browserViewDestroyed, payload);
  }

  /**
   * Keep main-frame navigations inside the allowlist in `guest-policy.ts`.
   * `will-attach-webview` only validated the first `src`; this covers link
   * clicks, `location` changes and server redirects afterwards.
   */
  private installNavigationGuard(wc: WebContents): void {
    wc.on("will-navigate", (event) => {
      if (!isAllowedGuestNavigation(event.url)) event.preventDefault();
    });
    wc.on("will-redirect", (event) => {
      if (event.isMainFrame && !isAllowedGuestNavigation(event.url)) event.preventDefault();
    });
  }

  /**
   * Handle a `band-action://…` link click captured by the
   * `did-start-navigation` interceptor. The error pages painted inside the
   * page encode all of their buttons as navigations to these URLs (see
   * `browser/error-html.ts`); we never let the "navigation" happen, we
   * read the action and dispatch it instead.
   */
  private handleBandAction(wc: WebContents, action: BandAction): void {
    if (wc.isDestroyed()) {
      log.debug("handleBandAction: webContents destroyed");
      return;
    }
    switch (action.kind) {
      case "cert-proceed": {
        // Security: validate the action against the pending cert-error for
        // this page BEFORE writing to the exception store. The host and
        // fingerprint come from query parameters on a `band-action://` URL
        // that any page loaded in a Band tab could craft (XSS-loaded HTML
        // in a navigated page, an attacker-controlled redirect, etc.).
        // Without this guard an attacker page could silently register a
        // session exception for an arbitrary (host, fingerprint) triple
        // and turn off the interstitial for the next visit to that host.
        //
        // The legitimate proceed flow only navigates to a
        // `band-action://cert-proceed?…` URL from inside our own in-view
        // interstitial HTML, generated against the pending entry, so any
        // mismatch is by definition not coming from our UI.
        const pending = this.pendingCertErrors.get(wc.id);
        if (
          !pending ||
          pending.host !== action.host ||
          pending.fingerprint !== action.fingerprint
        ) {
          log.warn(
            {
              actionHost: action.host,
              actionFingerprint: action.fingerprint,
              pendingHost: pending?.host ?? null,
              pendingFingerprint: pending?.fingerprint ?? null,
            },
            "cert-proceed: ignoring action that doesn't match pending cert-error",
          );
          return;
        }
        const partition = partitionForSession(wc.session);
        this.opts.certExceptions.add({
          partition,
          host: action.host,
          fingerprint: action.fingerprint,
        });
        this.overriddenHosts.add(action.host.toLowerCase());
        // Tell the renderer so its address bar can paint the
        // "Not Secure" badge for this host.
        this.emit(Events.browserHostOverridden, { host: action.host.toLowerCase() });
        this.pendingCertErrors.delete(wc.id);
        log.debug(
          {
            host: action.host,
            fingerprint: action.fingerprint,
            pendingUrl: pending.url,
            partition,
          },
          "cert-proceed",
        );
        void wc.loadURL(pending.url);
        return;
      }
      case "cert-back": {
        this.pendingCertErrors.delete(wc.id);
        void wc.loadURL("about:blank");
        return;
      }
      case "load-retry": {
        const pending = this.pendingLoadErrors.get(wc.id);
        this.pendingLoadErrors.delete(wc.id);
        void wc.loadURL(pending?.url || "about:blank");
        return;
      }
      case "load-back": {
        this.pendingLoadErrors.delete(wc.id);
        void wc.loadURL("about:blank");
        return;
      }
    }
  }

  private wireEvents(wc: WebContents): void {
    // Events are keyed by the Band tab id, looked up when they fire: a guest
    // starts loading before its pane has registered it, and a guest can be
    // registered under a new id later. Unregistered pages emit nothing.
    const emitUrl = (url: string, loading: boolean): void => {
      const key = this.keyByWebContentsId.get(wc.id);
      if (key === undefined) return;
      const payload: BrowserUrlChangedPayload = { url, browser_id: key, loading };
      this.emit(Events.browserUrlChanged, payload);
    };

    // ---- URL & loading state ----
    // `did-start-navigation` carries the *target* URL of a pending
    // navigation, so the address bar updates the moment the user clicks a
    // link (or types and submits one). `did-start-loading` would be wrong:
    // `getURL()` at that point still returns the OLD document's URL.
    //
    //   - Only main-frame navigations touch the address bar.
    //   - Same-document transitions (hash changes, History API pushState)
    //     don't load anything, so they emit `loading: false`.
    //   - Redirect chains fire `did-start-navigation` for each hop, so the
    //     address bar follows the redirect, as in Chrome.
    wc.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      // ---- band-action:… interceptor (issue #444 cast follow-up) ----
      // The in-view error pages encode button clicks as navigations to a
      // sentinel `band-action://` URL. Chromium has no idea what that
      // scheme is, so without intercepting it would commit the navigation,
      // fail to load, and leave the tab on the unknown-scheme URL.
      //
      // Lenient prefix match: Chromium normalises non-standard schemes
      // inconsistently (sometimes drops the authority slashes, sometimes
      // adds a trailing slash). The check and parser tolerate both.
      //
      // CRITICAL: DEFER the new loadURL via setImmediate. Calling
      // `loadURL()` synchronously from inside `did-start-navigation`
      // re-enters Chromium's navigation pipeline while it is still
      // processing the current navigation, which crashes the main process
      // with `EXC_BREAKPOINT` deep inside V8.
      //
      // We deliberately do NOT call `stop()` here. Chromium fires
      // `did-fail-load` for `band-action://` almost immediately (unknown
      // scheme → ERR_UNKNOWN_URL_SCHEME), so by the time setImmediate fires
      // the navigation has already aborted on its own. `stop()` risked
      // cancelling the brand-new loadURL and left the page blank after
      // Proceed.
      //
      // Why not `will-navigate`? It DOES fire for `band-action://` too, and
      // handling both produced a double dispatch of `handleBandAction` that
      // broke Proceed (the second call, with the pending entry already
      // cleared, loaded about:blank). `did-start-navigation` is the single
      // source of truth; the navigation guard lets `band-action:` through.
      if (details.url.startsWith("band-action:")) {
        const action = parseBandAction(details.url);
        log.debug(
          { url: details.url, parsed: action?.kind ?? null },
          "band-action did-start-navigation",
        );
        setImmediate(() => {
          if (wc.isDestroyed()) return;
          if (action) this.handleBandAction(wc, action);
        });
        return;
      }
      // Skip URL emissions for the in-view error pages we load via `data:`
      // URIs. The address bar should keep showing the failing target URL.
      if (details.url.startsWith("data:")) return;
      // Clear any pending error as soon as a real main-frame navigation
      // starts: Back-to-safety navigating away, or Proceed reloading. Our
      // own data: loads are filtered above so they don't wipe the pending
      // entries before the user has acted.
      if (!details.isSameDocument) {
        this.pendingCertErrors.delete(wc.id);
        this.pendingLoadErrors.delete(wc.id);
      }
      emitUrl(details.url, !details.isSameDocument);
    });
    // `did-stop-loading` is the "load finished" signal: it flips the
    // loading indicator off and re-emits the committed URL, which corrects
    // any drift if the final URL differs from what `did-start-navigation`
    // reported. `data:` and `band-action:` are filtered for the same
    // reasons as above.
    wc.on("did-stop-loading", () => {
      const url = wc.getURL();
      if (url.startsWith("data:")) return;
      if (url.startsWith("band-action:")) return;
      emitUrl(url, false);
    });

    // ---- New-window requests → new Band browser tab (issue #488) ----
    // Chromium funnels every page-initiated new-window request (window.open,
    // `<a target="_blank">`, middle / Cmd+click, `<form target="_blank">`)
    // through `setWindowOpenHandler`. We always deny the OS window, so no
    // detached browser window can ever appear, and emit
    // `browser-open-window` for the renderer to open a Band tab instead when
    // `decideWindowOpenAction` green-lights the URL (`about:blank`,
    // `javascript:`, custom schemes etc. are dropped).
    //
    // The handler must return SYNCHRONOUSLY; `emit` just queues an IPC
    // message, so it is safe here.
    wc.setWindowOpenHandler((details) => {
      const decision = decideWindowOpenAction(details.url);
      const key = this.keyByWebContentsId.get(wc.id);
      if (decision.kind === "open-in-band" && key !== undefined) {
        const payload: BrowserOpenWindowPayload = {
          browser_id: key,
          url: decision.url,
          disposition: details.disposition,
        };
        this.emit(Events.browserOpenWindow, payload);
      } else {
        log.debug(
          {
            url: details.url,
            reason: decision.kind === "ignore" ? decision.reason : "unregistered-page",
            disposition: details.disposition,
          },
          "window-open: denied without creating a Band tab",
        );
      }
      return { action: "deny" };
    });

    wc.on("page-title-updated", (_e, title) => {
      const key = this.keyByWebContentsId.get(wc.id);
      if (key === undefined) return;
      const payload: BrowserTitleChangedPayload = { browser_id: key, title };
      this.emit(Events.browserTitleChanged, payload);
    });

    // ---- TLS interstitial (issue #444) ----
    // The cert-override decision is made HERE rather than in the
    // session-wide `setCertificateVerifyProc`: Chromium has a per-host
    // short-term bad-cert cache that bypasses the verify proc on retries
    // after a denial, but `certificate-error` still fires, so it is the
    // only event that can honour a freshly-added exception.
    //
    //   - Exception matches our store → callback(true): trust the cert for
    //     THIS connection and let the page commit. No interstitial.
    //   - Otherwise → callback(false) and paint the in-view interstitial
    //     via a `data:` URI so the user can Proceed.
    wc.on("certificate-error", (event, url, errorCode, certificate, callback) => {
      event.preventDefault();
      const host = hostFromUrl(url);
      const fingerprint = certificate.fingerprint;
      const partition = partitionForSession(wc.session);
      if (host && fingerprint && this.opts.certExceptions.has({ partition, host, fingerprint })) {
        log.debug({ host, fingerprint }, "cert-error: override-trust");
        callback(true);
        return;
      }
      const cert = {
        fingerprint: certificate.fingerprint,
        subjectName: certificate.subjectName,
        issuerName: certificate.issuerName,
        validStart: certificate.validStart,
        validExpiry: certificate.validExpiry,
      };
      const payload = buildCertErrorPayload({
        key: this.keyByWebContentsId.get(wc.id) ?? "",
        url,
        errorCode,
        certificate: cert,
      });
      this.pendingCertErrors.set(wc.id, payload);
      log.debug(
        { host: payload.host, fingerprint: payload.fingerprint },
        "cert-error: interstitial",
      );
      // Tell the renderer the failing URL committed (loading=false) so the
      // address bar reflects it and the spinner stops. The `data:` URI load
      // below is filtered.
      emitUrl(url, false);
      callback(false);
      const html = buildCertErrorHtml({
        url,
        host: payload.host,
        errorCode: payload.error_code,
        errorDescription: payload.error_description,
        certificate: cert,
      });
      // DEFER via setImmediate: calling `loadURL` synchronously from a
      // Chromium event handler that still has navigation state on the stack
      // has caused main-process crashes deep inside V8.
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        void wc.loadURL(htmlToDataUrl(html));
      });
    });

    // ---- Generic load-failure error page ----
    // Companion to the cert flow above: catches `did-fail-load` for
    // main-frame DNS / connection / timeout failures and paints a
    // Chrome-style "This site can't be reached" page into the page itself,
    // so remote screencast viewers see it and can click Reload / Back.
    // User-aborted navigations and the cert error range are filtered (see
    // `browser/load-error.ts`).
    wc.on("did-fail-load", (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrameFailure({ errorCode, isMainFrame })) return;
      // `band-action:` fails with ERR_UNKNOWN_URL_SCHEME by design; the
      // interceptor above already queued the real action, and reacting here
      // too would race it with the load-error page. `data:` is our own error
      // page; never recurse into another one.
      if (validatedURL.startsWith("band-action:")) return;
      if (validatedURL.startsWith("data:")) return;
      const payload = buildLoadErrorPayload({
        key: this.keyByWebContentsId.get(wc.id) ?? "",
        url: validatedURL,
        errorCode,
      });
      this.pendingLoadErrors.set(wc.id, payload);
      emitUrl(validatedURL, false);
      const html = buildLoadErrorHtml({
        url: validatedURL,
        errorCode,
        errorName: payload.error_name,
        headline: payload.headline,
        description: payload.description,
      });
      // DEFER: see the matching block in the cert-error handler.
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        void wc.loadURL(htmlToDataUrl(html));
      });
    });

    // ---- Pane shortcuts typed inside the page ----
    // A guest consumes its own keydowns, so the dashboard's DOM listeners
    // never see keys typed while the page has focus. For the pane-level
    // shortcuts, swallow the key in the guest and forward it; the renderer
    // re-dispatches it on the tab's `<webview>` element, where the find
    // bar, tab and split handlers pick it up as if focus were in Band's UI.
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.alt) return;
      if (!isForwardedShortcut(input)) return;
      const key = this.keyByWebContentsId.get(wc.id);
      if (key === undefined) return;
      event.preventDefault();
      const payload: BrowserGuestShortcutPayload = {
        browser_id: key,
        key: input.key,
        code: input.code,
        shift: input.shift,
        control: input.control,
        meta: input.meta,
      };
      this.emit(Events.browserGuestShortcut, payload);
    });
  }

  private emit(event: string, payload: unknown): void {
    const target = this.opts.mainWindow.webContents;
    if (target.isDestroyed()) return;
    target.send(event, payload);
  }
}

/**
 * The pane shortcuts a guest forwards: Ctrl+(Shift)+Tab, and with the
 * platform modifier F (find), T (new tab), W (close), D / Shift+D (split),
 * [ and ] with or without Shift (cycle groups / tabs). Everything else
 * (copy, paste, select-all, the page's own bindings) stays with the page.
 */
function isForwardedShortcut(input: Input): boolean {
  const key = input.key.toLowerCase();
  // Ctrl, not the platform modifier: Cmd+Tab belongs to macOS.
  if (input.control && !input.meta && key === "tab") return true;
  const mod =
    process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return false;
  if (key === "d" || key === "[" || key === "]") return true;
  return !input.shift && (key === "f" || key === "t" || key === "w");
}

const preparedSessions = new WeakSet<Session>();

/**
 * One-time setup of a tab's session. Each partition's `Session` has its own
 * protocol registry and request hooks, and a guest's partition (the default
 * one or a browser profile's) is only known once it attaches.
 *
 *   - The no-op `band-action://` handler. Without it an in-page error page's
 *     buttons pop the macOS "no application set to open this URL" dialog.
 *     The action itself is dispatched in `did-start-navigation` (see
 *     `wireEvents`).
 *   - No `file:` requests. The navigation guard only sees navigations the
 *     page starts; one the dashboard starts (`webview.loadURL`) never fires
 *     `will-navigate`, so the session refuses the scheme outright and a
 *     compromised dashboard still can't read local files through a tab.
 */
function prepareBrowserSession(sess: Session): void {
  if (preparedSessions.has(sess)) return;
  preparedSessions.add(sess);
  if (!sess.protocol.isProtocolHandled("band-action")) {
    sess.protocol.handle("band-action", () => new Response(null, { status: 204 }));
  }
  sess.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (_details, callback) => {
    callback({ cancel: true });
  });
}

/** The page's committed URL, or null for blank and error pages. */
function committedUrl(wc: WebContents): string | null {
  if (wc.isDestroyed()) return null;
  const url = wc.getURL();
  if (!url || url === "about:blank" || url.startsWith("data:")) return null;
  return url;
}
