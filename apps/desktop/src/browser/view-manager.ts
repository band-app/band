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
import { Events } from "../shared/ipc-channels.js";
import {
  type BrowserBoundsArgs,
  type BrowserCreateArgs,
  type BrowserEnsureArgs,
  type BrowserEvalArgs,
  type BrowserKeyArg,
  type BrowserNavigateArgs,
  type BrowserTitleChangedPayload,
  type BrowserUrlChangedPayload,
  type BrowserViewDestroyedPayload,
  browserKey,
} from "../shared/types.js";

const MAX_BROWSER_VIEWS = 10;

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
}

type Parent = "main" | "hidden";

export class BrowserViewManager {
  private readonly views = new Map<string, WebContentsView>();
  /** Tracks which window each view is parented to so we can migrate
   *  on show / hide / ensure transitions. */
  private readonly parentByKey = new Map<string, Parent>();
  /** LRU order, oldest first. */
  private readonly order: string[] = [];

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
      this.applyBounds(existing, args);
      existing.setVisible(true);
      return;
    }

    this.enforceLru();

    const view = this.spawn(args.url, key);
    this.moveTo(key, view, "main");
    this.applyBounds(view, args);
    view.setVisible(true);
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
      existing.setVisible(true);
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
    const view = this.views.get(browserKey(args));
    if (!view) return;
    this.applyBounds(view, args);
  }

  show(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    // Migrate back to the main window so the user can see the tab.
    if (this.opts.hiddenWindow) this.moveTo(key, view, "main");
    view.setVisible(true);
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
      view.setVisible(true);
    } else {
      // CDP screencast disabled: original behavior. setVisible(false)
      // parks the compositor, which is exactly what we want for a tab
      // the user isn't currently viewing.
      view.setVisible(false);
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

  destroy(args: BrowserKeyArg): void {
    const key = browserKey(args);
    const view = this.views.get(key);
    if (!view) return;
    const parent = this.parentByKey.get(key) ?? "main";
    const win =
      parent === "hidden" && this.opts.hiddenWindow ? this.opts.hiddenWindow : this.opts.mainWindow;
    win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.views.delete(key);
    this.parentByKey.delete(key);
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

  /** Hide every tracked view. The Rust impl ignores `workspace_id`. */
  hideAll(): void {
    for (const id of this.order) {
      this.views.get(id)?.setVisible(false);
    }
  }

  /** Show every tracked view. The Rust impl ignores `workspace_id`. */
  showAll(): void {
    for (const id of this.order) {
      this.views.get(id)?.setVisible(true);
    }
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
    this.parentByKey.set(key, target);
  }

  private wireEvents(key: string, view: WebContentsView): void {
    const emitUrl = (loading: boolean): void => {
      // The renderer's two modes (workspace-keyed vs browser-keyed)
      // destructure different field names. We populate both with the same
      // value so either filter matches. The opposite key matches because
      // the renderer compares `event.payload.workspace_id !== workspaceIdRef`
      // (and similarly for browser_id), and the local ref equals the key
      // we used at creation time.
      const payload: BrowserUrlChangedPayload = {
        url: view.webContents.getURL(),
        browser_id: key,
        workspace_id: key,
        loading,
      };
      this.emit(Events.browserUrlChanged, payload);
    };
    view.webContents.on("did-start-loading", () => emitUrl(true));
    view.webContents.on("did-stop-loading", () => emitUrl(false));
    view.webContents.on("page-title-updated", (_e, title) => {
      const payload: BrowserTitleChangedPayload = {
        browser_id: key,
        workspace_id: key,
        title,
      };
      this.emit(Events.browserTitleChanged, payload);
    });
  }

  private emit(event: string, payload: unknown): void {
    const target = this.opts.mainWindow.webContents;
    if (target.isDestroyed()) return;
    target.send(event, payload);
  }
}
