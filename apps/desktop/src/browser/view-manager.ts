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
  type BrowserEvalArgs,
  type BrowserKeyArg,
  type BrowserNavigateArgs,
  type BrowserTitleChangedPayload,
  type BrowserUrlChangedPayload,
  browserKey,
} from "../shared/types.js";

const MAX_BROWSER_VIEWS = 10;

export interface ViewManagerOptions {
  mainWindow: BrowserWindow;
}

export class BrowserViewManager {
  private readonly views = new Map<string, WebContentsView>();
  /** LRU order, oldest first. */
  private readonly order: string[] = [];

  constructor(private readonly opts: ViewManagerOptions) {}

  /**
   * Create-or-reuse the view. If a view with this key already exists, bump
   * its LRU position and reposition. Otherwise enforce the cap and spawn.
   */
  create(args: BrowserCreateArgs): void {
    const key = browserKey(args);
    if (!key) return;
    const existing = this.views.get(key);
    if (existing) {
      this.touch(key);
      this.applyBounds(existing, args);
      existing.setVisible(true);
      return;
    }

    this.enforceLru();

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.applyBounds(view, args);
    this.wireEvents(key, view);
    this.opts.mainWindow.contentView.addChildView(view);
    void view.webContents.loadURL(args.url);

    this.views.set(key, view);
    this.order.push(key);
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
    this.views.get(browserKey(args))?.setVisible(true);
  }

  hide(args: BrowserKeyArg): void {
    this.views.get(browserKey(args))?.setVisible(false);
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
    this.opts.mainWindow.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.views.delete(key);
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
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
