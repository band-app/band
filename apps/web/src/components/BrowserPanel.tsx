import type { IDockviewPanelProps } from "dockview";
import { ArrowLeft, ArrowRight, RotateCw, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBrowserPaneControls } from "../hooks/useBrowserPaneControls";
import { useBrowserPaneFreeze } from "../hooks/useBrowserPaneFreeze";
import { useOverriddenHosts } from "../hooks/useOverriddenHosts";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";
import { AddressBarAutocomplete } from "./AddressBarAutocomplete";
import { BrowserFindBar } from "./BrowserFindBar";
import { HistoryPopover } from "./HistoryPopover";
import { NotSecureBadge } from "./NotSecureBadge";

const DEFAULT_URL = "";
const BLANK_URL = "about:blank";
const STORAGE_PREFIX = "band:browser-url:";

// ---------------------------------------------------------------------------
// Per-workspace URL persistence in localStorage
// ---------------------------------------------------------------------------

function saveUrl(workspaceId: string, url: string) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${workspaceId}`, url);
  } catch {}
}

function loadUrl(workspaceId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${workspaceId}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Favicon store — tracks per-browser favicon URLs emitted by the desktop shell.
// ---------------------------------------------------------------------------

const faviconMap = new Map<string, string>();
const faviconListeners = new Set<() => void>();

function setFaviconUrl(browserId: string, url: string) {
  if (faviconMap.get(browserId) !== url) {
    faviconMap.set(browserId, url);
    for (const listener of faviconListeners) listener();
  }
}

function subscribeFavicons(cb: () => void) {
  faviconListeners.add(cb);
  return () => {
    faviconListeners.delete(cb);
  };
}

/** Reactive hook that returns the current favicon URL for a browser tab. */
export function useFavicon(browserId: string): string | undefined {
  return useSyncExternalStore(subscribeFavicons, () => faviconMap.get(browserId));
}

// ---------------------------------------------------------------------------
// Browser pane params — used by DockviewBrowserContainer for multi-tab support.
// ---------------------------------------------------------------------------

export interface BrowserPaneParams {
  workspaceId: string;
  browserId: string;
  wsActive?: boolean;
  initialUrl?: string;
}

// ---------------------------------------------------------------------------
// Browser panel component – renders an address bar and a placeholder div.
// A native Electron BrowserView is positioned over the placeholder area.
// Each workspace gets its own persistent webview (hidden/shown on switch).
// ---------------------------------------------------------------------------

interface BrowserParams {
  workspaceId: string;
  wsActive?: boolean;
}

export function BrowserPanelComponent({ params, api }: IDockviewPanelProps<BrowserParams>) {
  const workspaceId = params.workspaceId;

  const [currentUrl, setCurrentUrl] = useState(() => loadUrl(workspaceId) ?? DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(() => loadUrl(workspaceId) ?? DEFAULT_URL);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const createdRef = useRef(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  // Freeze on overlay — captures a snapshot + hides the native view
  // while any popover / dialog / dropdown is open. `snapshot` is
  // the JPEG data URL to paint into the placeholder. Shared with
  // `BrowserPaneComponent` via the `useBrowserPaneFreeze` hook.
  const ipcKeyRef = useRef({ workspaceId });
  ipcKeyRef.current = { workspaceId };
  const { snapshot } = useBrowserPaneFreeze({
    created,
    visible: api.isActive && params.wsActive !== false,
    ipcKeyRef,
  });
  // TLS interstitial + generic "site can't be reached" pages are
  // painted INSIDE the WebContentsView via a data: URI (issue #444).
  // The renderer just needs the set of hosts the user has overridden
  // a cert error for, so the address bar can paint a "Not Secure"
  // badge while the user is on those origins.
  const { isOverriddenHost } = useOverriddenHosts();
  // `addressInputFocusedRef` is now owned by `useBrowserPaneControls`
  // — it's destructured back out below and read inside the
  // `browser-url-changed` listener to skip clobbering an in-progress
  // address-bar edit.

  // ------- restore persisted URL when workspaceId becomes available -------
  // useState initializers run on first mount when workspaceId may still be
  // undefined (fromJSON restores panels with empty params). This effect
  // syncs state from localStorage once the real workspaceId is injected.

  useEffect(() => {
    if (!workspaceId) return;
    const saved = loadUrl(workspaceId);
    if (saved) {
      setCurrentUrl(saved);
      setInputUrl(saved);
    }
  }, [workspaceId]);

  // ------- helpers -------

  const getBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Inset by 1px on the left and right so the dockview group separators
    // (1px lines between this pane and its horizontal neighbors) stay
    // visible. The native WebContentsView is an OS-level layer that floats
    // above the React DOM, so without these insets it draws on top of the
    // separators on either side.
    return {
      x: rect.left + 1,
      y: rect.top,
      width: Math.max(0, rect.width - 2),
      height: rect.height,
    };
  }, []);

  const invoke = useCallback(async (cmd: string, args?: Record<string, unknown>) => {
    if (!isDesktop) return;
    return desktopInvoke(cmd, args);
  }, []);

  // ------- create or show webview once placeholder has real dimensions -------
  //
  // The panel may be mounted while its tab is inactive (dockview renders
  // hidden tabs with display:none).  A simple setTimeout would see 0×0
  // bounds and give up.  Instead we use a ResizeObserver that fires as
  // soon as the placeholder gets a non-zero size (i.e. the tab is shown).

  useEffect(() => {
    if (!isDesktop || created || creatingRef.current) return;
    const el = placeholderRef.current;
    if (!el) return;

    let cancelled = false;

    const tryCreate = async () => {
      if (cancelled || createdRef.current || creatingRef.current) return;
      const bounds = getBounds();
      if (!bounds || bounds.width === 0 || bounds.height === 0) return;

      observer.disconnect();
      creatingRef.current = true;
      try {
        await invoke("browser_create", {
          workspaceId,
          ...bounds,
          url: loadUrl(workspaceId) || currentUrlRef.current || BLANK_URL,
        });
        createdRef.current = true;
        setCreated(true);
        // If a navigation was requested while we were creating, flush it now
        const pending = pendingNavRef.current;
        if (pending) {
          pendingNavRef.current = null;
          await invoke("browser_navigate", {
            workspaceId: workspaceIdRef.current,
            url: pending,
          });
        }
      } catch (e) {
        console.error("Failed to create browser webview:", e);
      } finally {
        creatingRef.current = false;
      }
    };

    // Watch for the placeholder gaining real dimensions
    const observer = new ResizeObserver(() => {
      tryCreate();
    });
    observer.observe(el);

    // Also try after a short tick in case the tab is already visible
    const timer = setTimeout(tryCreate, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [created, getBounds, invoke, workspaceId]);

  // ------- listen for URL changes from the Rust side -------
  // Refs (`workspaceIdRef`, `addressInputFocusedRef`) are intentionally
  // read via `.current` inside the listener — adding `.current` to the
  // deps would force the listener to re-bind on every focus/blur or
  // workspace switch.

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!isDesktop) return;
    let unlistenUrl: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;

    (async () => {
      unlistenUrl = await desktopListen<{
        url: string;
        workspace_id: string;
        loading: boolean;
      }>("browser-url-changed", (event) => {
        // Only update if the event is for our workspace
        if (event.payload.workspace_id !== workspaceIdRef.current) return;
        const url = event.payload.url;
        setLoading(event.payload.loading);
        // Don't sync about:blank to the address bar or localStorage
        if (url === BLANK_URL) return;
        setCurrentUrl(url);
        // Preserve in-progress edits: while the user is typing in the
        // address bar, the canonical URL still updates behind the scenes
        // but the visible input value is left alone. See the matching
        // logic in `BrowserPaneComponent` below.
        if (!addressInputFocusedRef.current) {
          setInputUrl(url);
        }
        saveUrl(workspaceIdRef.current, url);

        // Record committed navigations into the per-workspace history.
        // `loading=false` is the "load finished" signal; `did-start-
        // navigation` (`loading=true`) intentionally does NOT record
        // because the URL there can be wrong for redirect chains —
        // we'd insert an intermediate hop and never resolve to the
        // real destination's title. Server-side filtering rejects
        // about:blank / chrome-extension / devtools / file URLs.
        if (!event.payload.loading) {
          let favicon: string | undefined;
          try {
            favicon = `${new URL(url).origin}/favicon.ico`;
          } catch {
            // not a valid URL — leave favicon undefined
          }
          trpc.history.record
            .mutate({ workspaceId: workspaceIdRef.current, url, faviconUrl: favicon })
            .catch(() => {});
        }
      });

      // Backfill the title onto the most recent history row for this
      // URL as soon as Chromium resolves it (typically 100-2000ms
      // after the URL commit).
      unlistenTitle = await desktopListen<{
        workspace_id: string;
        title: string;
      }>("browser-title-changed", (event) => {
        if (event.payload.workspace_id !== workspaceIdRef.current) return;
        const url = currentUrlRef.current;
        if (!url || url === BLANK_URL) return;
        trpc.history.updateMeta
          .mutate({
            workspaceId: workspaceIdRef.current,
            url,
            title: event.payload.title,
          })
          .catch(() => {});
      });
    })();

    return () => {
      unlistenUrl?.();
      unlistenTitle?.();
    };
  }, []);

  // ------- visibility tracking (hide/show when tab switches) -------

  useEffect(() => {
    if (!isDesktop || !created) return;

    const handleVisibility = async (visible: boolean) => {
      if (visible) {
        await invoke("browser_show", { workspaceId });
        const bounds = getBounds();
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          await invoke("browser_set_bounds", { workspaceId, ...bounds });
        }
      } else {
        await invoke("browser_hide", { workspaceId });
      }
    };

    const d1 = api.onDidActiveChange((e) => {
      handleVisibility(e.isActive);
    });
    const d2 = api.onDidVisibilityChange((e) => {
      if (!e.isVisible) {
        handleVisibility(false);
      } else if (api.isActive) {
        handleVisibility(true);
      }
    });

    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api, created, getBounds, invoke, workspaceId]);

  // ------- workspace-level visibility -------
  // The native webview is an OS-level layer that floats on top of the DOM.
  // When the workspace is hidden (wsActive=false) we must explicitly hide
  // the webview — CSS display:none on the React tree has no effect on it.

  useEffect(() => {
    if (!isDesktop || !created) return;
    const wsActive = params.wsActive !== false;

    if (!wsActive) {
      invoke("browser_hide", { workspaceId }).catch(() => {});
    } else if (api.isActive) {
      // Only re-show if the browser tab is the active tab in its group
      invoke("browser_show", { workspaceId }).catch(() => {});
      const bounds = getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        invoke("browser_set_bounds", { workspaceId, ...bounds }).catch(() => {});
      }
    }
  }, [params.wsActive, api, created, getBounds, invoke, workspaceId]);

  // ------- keep webview bounds in sync on resize -------

  useEffect(() => {
    if (!isDesktop || !created) return;
    const el = placeholderRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const bounds = getBounds();
      if (!bounds || bounds.width === 0 || bounds.height === 0) return;
      invoke("browser_set_bounds", { workspaceId, ...bounds }).catch(() => {});
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, [created, getBounds, invoke, workspaceId]);

  // ------- destroy on unmount (workspace evicted from frontend cache) -------
  // Workspace *switches* are handled by the wsActive effect (hide/show).
  // Unmount only happens when the workspace view is fully evicted, so we
  // destroy the native webview to free memory.

  useEffect(() => {
    return () => {
      if (isDesktop) {
        const wsId = workspaceIdRef.current;
        desktopInvoke("browser_destroy", { workspaceId: wsId }).catch(() => {});
      }
    };
  }, []);

  // ------- navigation handlers -------

  const handleNavigate = useCallback(
    async (rawUrl: string) => {
      let normalized = rawUrl.trim();

      // Empty input — load a blank page and clear the address bar.
      // The `browser-url-changed` listener filters out `about:blank`,
      // so the input stays visibly empty rather than showing
      // "about:blank" after the navigation lands.
      if (!normalized) {
        setCurrentUrl("");
        setInputUrl("");
        setLoading(false);
        saveUrl(workspaceId, "");
        if (createdRef.current) {
          try {
            await invoke("browser_navigate", { workspaceId, url: BLANK_URL });
          } catch (e) {
            console.error("browser_navigate failed:", e);
          }
        } else {
          pendingNavRef.current = BLANK_URL;
        }
        return;
      }

      if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        if (normalized.includes(".") && !normalized.includes(" ")) {
          normalized = `https://${normalized}`;
        } else {
          normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
        }
      }

      setCurrentUrl(normalized);
      setInputUrl(normalized);
      setLoading(true);
      saveUrl(workspaceId, normalized);

      if (createdRef.current) {
        try {
          await invoke("browser_navigate", { workspaceId, url: normalized });
        } catch (e) {
          console.error("browser_navigate failed:", e);
        }
      } else {
        // Webview still being created — queue the navigation
        pendingNavRef.current = normalized;
      }
    },
    [invoke, workspaceId],
  );

  const handleBack = useCallback(async () => {
    try {
      await invoke("browser_go_back", { workspaceId });
    } catch (e) {
      console.error("browser_go_back failed:", e);
    }
  }, [invoke, workspaceId]);

  const handleForward = useCallback(async () => {
    try {
      await invoke("browser_go_forward", { workspaceId });
    } catch (e) {
      console.error("browser_go_forward failed:", e);
    }
  }, [invoke, workspaceId]);

  const handleReload = useCallback(async () => {
    try {
      setLoading(true);
      await invoke("browser_reload", { workspaceId });
    } catch (e) {
      console.error("browser_reload failed:", e);
    }
  }, [invoke, workspaceId]);

  const handleStop = useCallback(async () => {
    try {
      // Stop loading by evaluating window.stop() in the webview
      await invoke("browser_eval", { workspaceId, js: "window.stop()" });
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [invoke, workspaceId]);

  // ------- pane chrome controls (find bar, DevTools, address-bar UX) -------
  const {
    find,
    addressInputFocusedRef,
    handleAddressFocus,
    handleAddressBlur,
    handleAddressKeyDown,
    handlePaneKeyDown,
    handleToggleDevTools,
    autocomplete,
    paneDataAttrs,
  } = useBrowserPaneControls({
    key: workspaceId,
    keyName: "workspaceId",
    workspaceId,
    currentUrlRef,
    setInputUrl,
    inputUrl,
    onNavigate: handleNavigate,
  });

  // Don't render until workspaceId is injected — during layout sync fromJSON
  // recreates panels with empty params before injectParams runs a tick later.
  if (!workspaceId) return null;

  // ------- non-desktop fallback -------

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Browser panel is only available in the desktop app
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col"
      onKeyDown={handlePaneKeyDown}
      // Cmd+R / Cmd+= routing: the desktop menu's renderer-global
      // handlers walk up from `document.activeElement` looking for
      // these data attrs to decide whether to act on this tab or fall
      // through to the app. Sourced from `useBrowserPaneControls` so
      // both panel variants stay in sync.
      {...paneDataAttrs}
    >
      {/* Keyframes for the loading bar (injected once, deduped by browser) */}
      <style>{`@keyframes browser-bar-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(200%); }
  100% { transform: translateX(-100%); }
}`}</style>
      {/* Address bar */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={handleForward}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Forward"
        >
          <ArrowRight className="size-4" />
        </button>
        {loading ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Stop"
          >
            <X className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReload}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Reload"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {isOverriddenHost(currentUrl) ? <NotSecureBadge /> : null}
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          onFocus={handleAddressFocus}
          onBlur={handleAddressBlur}
          className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
          placeholder="Enter URL or search..."
          // Stable hook for `DockviewBrowserContainer` to focus the
          // address bar via `[data-band-address-input]` — more durable
          // than `input[type='text']`, which would also match the
          // find-bar's search input.
          data-band-address-input=""
        />
        <HistoryPopover workspaceId={workspaceId} onNavigate={handleNavigate} />
        <button
          type="button"
          onClick={handleToggleDevTools}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Toggle DevTools"
        >
          <Wrench className="size-4" />
        </button>
        {/* Loading progress bar — indeterminate sliding indicator */}
        {loading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-500/10">
            <div
              className="h-full w-2/5 rounded-full bg-blue-500"
              style={{
                animation: "browser-bar-slide 1.4s ease-in-out infinite",
              }}
            />
          </div>
        )}
        {/* History autocomplete — absolutely positioned under the
            address-bar row (which is `relative`). Opening it
            registers a freeze hold via `useFreezeWhile` in
            `useBrowserPaneControls`, so the WebContentsView is
            replaced with a snapshot raster underneath and this
            dropdown sits cleanly on top. Mirrors Chrome's omnibox. */}
        <AddressBarAutocomplete state={autocomplete} onSelect={handleNavigate} />
      </div>

      {/* Find-in-page bar (Cmd+F / Ctrl+F) — slots between the address bar
       *  and the webview placeholder so it stacks naturally above the
       *  native WebContentsView. */}
      <BrowserFindBar find={find} />

      {/* Placeholder – the native webview is positioned over this area.
       *  Error pages (cert / "site can't be reached") are painted
       *  INSIDE the WebContentsView via a data: URI — see
       *  apps/desktop/src/browser/error-html.ts. The only error-
       *  related UI the renderer still owns is the "Not Secure"
       *  badge in the address bar above. */}
      <div ref={placeholderRef} className="relative min-h-0 flex-1">
        {snapshot ? (
          // Frozen raster shown while any overlay is open. See
          // `lib/browser-pane-freeze.ts`.
          //
          // `object-contain object-top` (not `object-cover`):
          //   - When the tab has docked DevTools, `capturePage`
          //     returns just the *page view*'s pixels — DevTools is a
          //     sibling `WebContentsView` and isn't part of the
          //     capture. The placeholder div, however, spans the
          //     whole tab area (page + DevTools). With `object-cover`
          //     the image would stretch to fill both, distorting the
          //     page visibly. With `object-contain object-top` the
          //     image scales preserving aspect ratio and pins to the
          //     top edge, so the page sits exactly where it was and
          //     the DevTools strip below stays empty (DevTools is
          //     hidden by the same `browser_hide` call). Without
          //     DevTools, aspects match the placeholder and `contain`
          //     gives the same result as `cover`.
          //   - Followup if it becomes annoying: also capture the
          //     DevTools view and stack a second `<img>` below, so
          //     the docked panel doesn't vanish either.
          <img
            src={snapshot}
            alt=""
            className="pointer-events-none absolute inset-0 size-full object-contain object-top"
            draggable={false}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowserPaneComponent — multi-tab variant keyed by browserId.
// Used by DockviewBrowserContainer to render individual browser tabs.
// ---------------------------------------------------------------------------

export function BrowserPaneComponent({
  params,
  api,
}: {
  params: BrowserPaneParams;
  api: IDockviewPanelProps<BrowserPaneParams>["api"];
}) {
  const { browserId, initialUrl, workspaceId: workspaceIdParam } = params;

  const [currentUrl, setCurrentUrl] = useState(() => initialUrl ?? DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(() => initialUrl ?? DEFAULT_URL);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const createdRef = useRef(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);
  const browserIdRef = useRef(browserId);
  browserIdRef.current = browserId;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  // `workspaceId` may be absent on the BrowserPaneParams when the panel
  // is restored from a saved layout that pre-dates the history feature.
  // Backfill it lazily from `trpc.browsers.get` so history recording and
  // autocomplete still know which workspace they belong to. Keep the
  // value in a ref so listeners read the latest workspace without
  // re-binding.
  const [workspaceId, setWorkspaceId] = useState(workspaceIdParam ?? "");
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  // Freeze on overlay — see `useBrowserPaneFreeze` hook.
  const ipcKeyRef = useRef({ browserId });
  ipcKeyRef.current = { browserId };
  const { snapshot } = useBrowserPaneFreeze({
    created,
    visible: api.isVisible && params.wsActive !== false,
    ipcKeyRef,
  });
  // Error pages live INSIDE the WebContentsView (issue #444 +
  // screencast follow-up); the renderer only tracks the host-override
  // set for the "Not Secure" badge. Same hook + behaviour as
  // `BrowserPanelComponent`.
  const { isOverriddenHost } = useOverriddenHosts();
  // `addressInputFocusedRef` is destructured from
  // `useBrowserPaneControls` below and read inside the
  // `browser-url-changed` listener to skip clobbering an in-progress
  // address-bar edit.

  // ------- helpers -------

  const getBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Inset by 1px on the left and right so the dockview group separators
    // (1px lines between this pane and its horizontal neighbors) stay
    // visible. The native WebContentsView is an OS-level layer that floats
    // above the React DOM, so without these insets it draws on top of the
    // separators on either side.
    return {
      x: rect.left + 1,
      y: rect.top,
      width: Math.max(0, rect.width - 2),
      height: rect.height,
    };
  }, []);

  const invoke = useCallback(async (cmd: string, args?: Record<string, unknown>) => {
    if (!isDesktop) return;
    return desktopInvoke(cmd, args);
  }, []);

  // ------- fetch URL from server when no initialUrl param -------
  // The server browser record is the source of truth for the URL.
  // When a browser is created via CLI with --url, or on workspace revisit,
  // the panel is added without an initialUrl param — fetch it from the server.
  useEffect(() => {
    if (!browserId || initialUrl) return;

    let cancelled = false;
    trpc.browsers.get
      .query({ browserId })
      .then((result) => {
        if (cancelled) return;
        const ws = result.browser?.workspaceId;
        if (ws && !workspaceIdRef.current) {
          // Lazy workspace backfill — see comment on `workspaceId`
          // state above.
          setWorkspaceId(ws);
        }
        const url = result.browser?.url;
        if (!url || url === "" || url === BLANK_URL) return;
        setCurrentUrl(url);
        setInputUrl(url);
        if (createdRef.current) {
          // Webview exists — navigate it directly.
          invoke("browser_navigate", { browserId, url }).catch(() => {});
        } else {
          // Webview not yet created — queue it so tryCreate flushes after
          // browser_create completes (same mechanism as handleNavigate).
          pendingNavRef.current = url;
        }
      })
      .catch(() => {
        // Server fetch failed — the user can still type a URL manually
      });
    return () => {
      cancelled = true;
    };
  }, [browserId, initialUrl, invoke]);

  // ------- create or show webview once placeholder has real dimensions -------
  useEffect(() => {
    if (!isDesktop || created || creatingRef.current) return;
    const el = placeholderRef.current;
    if (!el) return;

    let cancelled = false;

    const tryCreate = async () => {
      if (cancelled || createdRef.current || creatingRef.current) return;
      const bounds = getBounds();
      if (!bounds || bounds.width === 0 || bounds.height === 0) return;

      observer.disconnect();
      creatingRef.current = true;
      try {
        await invoke("browser_create", {
          browserId,
          ...bounds,
          url: currentUrlRef.current || BLANK_URL,
        });
        createdRef.current = true;
        setCreated(true);
        const pending = pendingNavRef.current;
        if (pending) {
          pendingNavRef.current = null;
          await invoke("browser_navigate", {
            browserId: browserIdRef.current,
            url: pending,
          });
        }
      } catch (e) {
        console.error("Failed to create browser webview:", e);
      } finally {
        creatingRef.current = false;
      }
    };

    const observer = new ResizeObserver(() => {
      tryCreate();
    });
    observer.observe(el);
    const timer = setTimeout(tryCreate, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [created, getBounds, invoke, browserId]);

  // ------- listen for URL / title changes from the Rust side -------
  // Persist URL to server (debounced) so it survives workspace switches.
  // Refs (`browserIdRef`, `currentUrlRef`, `addressInputFocusedRef`,
  // `urlPersistTimer`) are read via `.current` inside the listener —
  // adding `.current` to the deps would force the listener to re-bind
  // every URL/focus change. The `api` dep is the only thing that
  // should re-bind this effect.
  const urlPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!isDesktop) return;
    let unlistenUrl: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;

    (async () => {
      unlistenUrl = await desktopListen<{
        url: string;
        browser_id: string;
        loading: boolean;
      }>("browser-url-changed", (event) => {
        if (event.payload.browser_id !== browserIdRef.current) return;
        const url = event.payload.url;
        setLoading(event.payload.loading);
        if (url === BLANK_URL) return;
        setCurrentUrl(url);
        // Don't clobber the user's in-progress address-bar edit. If they
        // started typing mid-navigation, their text stays put until they
        // submit (Enter), abandon (Escape), or blur the input.
        if (!addressInputFocusedRef.current) {
          setInputUrl(url);
        }

        // Persist to server (debounced to avoid hammering on redirect chains)
        if (urlPersistTimer.current) clearTimeout(urlPersistTimer.current);
        urlPersistTimer.current = setTimeout(() => {
          trpc.browsers.navigate.mutate({ browserId: browserIdRef.current, url }).catch(() => {});
        }, 500);

        // Try to extract favicon from the URL's origin
        let faviconForHistory: string | undefined;
        try {
          const origin = new URL(url).origin;
          faviconForHistory = `${origin}/favicon.ico`;
          setFaviconUrl(browserIdRef.current, faviconForHistory);
        } catch {
          // ignore invalid URLs
        }

        // Record committed navigations into the per-workspace history.
        // Gated on `loading=false` so we only capture the final URL
        // after a redirect chain settles. The server filters
        // about:blank / chrome-extension / devtools / file URLs.
        if (!event.payload.loading && workspaceIdRef.current) {
          trpc.history.record
            .mutate({
              workspaceId: workspaceIdRef.current,
              url,
              faviconUrl: faviconForHistory,
            })
            .catch(() => {});
        }
      });
      unlistenTitle = await desktopListen<{ browser_id: string; title: string }>(
        "browser-title-changed",
        (event) => {
          if (event.payload.browser_id !== browserIdRef.current) return;
          if (event.payload.title) {
            api.setTitle(event.payload.title);
            // Backfill the title onto the existing history row for the
            // current URL. `page-title-updated` typically lands
            // 100-2000ms after `did-stop-loading`, so the row already
            // exists from the URL listener above.
            const url = currentUrlRef.current;
            if (url && url !== BLANK_URL && workspaceIdRef.current) {
              trpc.history.updateMeta
                .mutate({
                  workspaceId: workspaceIdRef.current,
                  url,
                  title: event.payload.title,
                })
                .catch(() => {});
            }
          }
        },
      );
    })();

    return () => {
      unlistenUrl?.();
      unlistenTitle?.();
      // Flush a pending URL persist before tearing down. Just clearing
      // the timer would lose the latest URL — e.g. when the user
      // navigates and then the workspace gets LRU-evicted before the
      // debounce window elapses. Fire the mutation with whatever URL
      // we have on hand; it's `void`-returning so it can safely race
      // the unmount.
      if (urlPersistTimer.current) {
        clearTimeout(urlPersistTimer.current);
        urlPersistTimer.current = null;
        const finalUrl = currentUrlRef.current;
        if (finalUrl && finalUrl !== BLANK_URL) {
          trpc.browsers.navigate
            .mutate({ browserId: browserIdRef.current, url: finalUrl })
            .catch(() => {});
        }
      }
    };
  }, [api]);

  // ------- visibility tracking (hide/show when tab switches) -------
  // In dockview, `isActive` = globally focused (only one panel at a time),
  // while `isVisible` = content area is on screen (multiple in a split).
  // We show/hide based on *visibility*, not active focus, so split views
  // keep both native webviews rendered simultaneously.
  //
  // Bounds-before-show ordering: setting bounds on a hidden view is a
  // no-visible-effect update, so we apply the current placeholder rect
  // *first* and then flip `setVisible(true)`. If we did it the other
  // way around (show, then set-bounds), the chromium compositor would
  // un-park at the view's last-known bounds — which is the source of
  // the "renders small then expands" snap users reported when the
  // outer Browser tab re-attached its DOM after a window resize or
  // any other geometry change that happened while the tab was hidden.
  // Same reasoning applies to the workspace-level effect below.
  useEffect(() => {
    if (!isDesktop || !created) return;

    // Log IPC failures instead of swallowing them. A failed
    // `browser_show` / `browser_set_bounds` / `browser_hide` leaves
    // the native WebContentsView in an indeterminate state (hidden
    // when it should be shown, stale bounds, etc.) — surfacing the
    // error makes the failure mode visible during debugging.
    const logFail = (cmd: string) => (err: unknown) =>
      console.error(`[BrowserPane] ${cmd} failed`, err);

    const showWebview = () => {
      const bounds = getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        invoke("browser_set_bounds", { browserId, ...bounds }).catch(logFail("browser_set_bounds"));
      }
      invoke("browser_show", { browserId }).catch(logFail("browser_show"));
    };

    const hideWebview = () => {
      invoke("browser_hide", { browserId }).catch(logFail("browser_hide"));
    };

    const d = api.onDidVisibilityChange((e) => {
      if (e.isVisible) {
        showWebview();
      } else {
        hideWebview();
      }
    });

    return () => {
      d.dispose();
    };
  }, [api, created, getBounds, invoke, browserId]);

  // ------- workspace-level visibility -------
  useEffect(() => {
    if (!isDesktop || !created) return;
    const wsActive = params.wsActive !== false;
    const logFail = (cmd: string) => (err: unknown) =>
      console.error(`[BrowserPane] ${cmd} failed`, err);

    if (!wsActive) {
      invoke("browser_hide", { browserId }).catch(logFail("browser_hide"));
    } else if (api.isVisible) {
      // Bounds before show — see the rationale on the
      // onDidVisibilityChange effect above. Same fix, same reason.
      const bounds = getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        invoke("browser_set_bounds", { browserId, ...bounds }).catch(logFail("browser_set_bounds"));
      }
      invoke("browser_show", { browserId }).catch(logFail("browser_show"));
    }
  }, [params.wsActive, api, created, getBounds, invoke, browserId]);

  // ------- keep webview bounds in sync on resize -------
  useEffect(() => {
    if (!isDesktop || !created) return;
    const el = placeholderRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const bounds = getBounds();
      if (!bounds || bounds.width === 0 || bounds.height === 0) return;
      invoke("browser_set_bounds", { browserId, ...bounds }).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [created, getBounds, invoke, browserId]);

  // ------- destroy on unmount -------
  useEffect(() => {
    return () => {
      if (isDesktop) {
        const bId = browserIdRef.current;
        desktopInvoke("browser_destroy", { browserId: bId }).catch(() => {});
      }
    };
  }, []);

  // ------- navigation handlers -------

  const handleNavigate = useCallback(
    async (rawUrl: string) => {
      let normalized = rawUrl.trim();

      // Empty input — load a blank page and clear the address bar.
      // The `browser-url-changed` listener filters out `about:blank`,
      // so the input stays visibly empty after the navigation lands.
      if (!normalized) {
        setCurrentUrl("");
        setInputUrl("");
        setLoading(false);
        if (createdRef.current) {
          try {
            await invoke("browser_navigate", { browserId, url: BLANK_URL });
          } catch (e) {
            console.error("browser_navigate failed:", e);
          }
        } else {
          pendingNavRef.current = BLANK_URL;
        }
        return;
      }

      if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        if (normalized.includes(".") && !normalized.includes(" ")) {
          normalized = `https://${normalized}`;
        } else {
          normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
        }
      }

      setCurrentUrl(normalized);
      setInputUrl(normalized);
      setLoading(true);

      if (createdRef.current) {
        try {
          await invoke("browser_navigate", { browserId, url: normalized });
        } catch (e) {
          console.error("browser_navigate failed:", e);
        }
      } else {
        pendingNavRef.current = normalized;
      }
    },
    [invoke, browserId],
  );

  const handleBack = useCallback(async () => {
    try {
      await invoke("browser_go_back", { browserId });
    } catch (e) {
      console.error("browser_go_back failed:", e);
    }
  }, [invoke, browserId]);

  const handleForward = useCallback(async () => {
    try {
      await invoke("browser_go_forward", { browserId });
    } catch (e) {
      console.error("browser_go_forward failed:", e);
    }
  }, [invoke, browserId]);

  const handleReload = useCallback(async () => {
    try {
      setLoading(true);
      await invoke("browser_reload", { browserId });
    } catch (e) {
      console.error("browser_reload failed:", e);
    }
  }, [invoke, browserId]);

  const handleStop = useCallback(async () => {
    try {
      await invoke("browser_eval", { browserId, js: "window.stop()" });
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [invoke, browserId]);

  // ------- pane chrome controls (find bar, DevTools, address-bar UX) -------
  const {
    find,
    addressInputFocusedRef,
    handleAddressFocus,
    handleAddressBlur,
    handleAddressKeyDown,
    handlePaneKeyDown,
    handleToggleDevTools,
    autocomplete,
    paneDataAttrs,
  } = useBrowserPaneControls({
    key: browserId,
    keyName: "browserId",
    workspaceId,
    currentUrlRef,
    setInputUrl,
    inputUrl,
    onNavigate: handleNavigate,
  });

  if (!browserId) return null;

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Browser panel is only available in the desktop app
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col" onKeyDown={handlePaneKeyDown} {...paneDataAttrs}>
      <style>{`@keyframes browser-bar-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(200%); }
  100% { transform: translateX(-100%); }
}`}</style>
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={handleForward}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Forward"
        >
          <ArrowRight className="size-4" />
        </button>
        {loading ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Stop"
          >
            <X className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReload}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Reload"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {isOverriddenHost(currentUrl) ? <NotSecureBadge /> : null}
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          onFocus={handleAddressFocus}
          onBlur={handleAddressBlur}
          className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
          placeholder="Enter URL or search..."
          // Stable hook for `DockviewBrowserContainer` to focus the
          // address bar via `[data-band-address-input]` — more durable
          // than `input[type='text']`, which would also match the
          // find-bar's search input.
          data-band-address-input=""
        />
        {workspaceId ? (
          <HistoryPopover workspaceId={workspaceId} onNavigate={handleNavigate} />
        ) : null}
        <button
          type="button"
          onClick={handleToggleDevTools}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Toggle DevTools"
        >
          <Wrench className="size-4" />
        </button>
        {loading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-500/10">
            <div
              className="h-full w-2/5 rounded-full bg-blue-500"
              style={{
                animation: "browser-bar-slide 1.4s ease-in-out infinite",
              }}
            />
          </div>
        )}
        {/* History autocomplete — absolutely positioned under the
            address-bar row (which is `relative`). See identical block
            in `BrowserPanelComponent` for the freeze-hold rationale. */}
        <AddressBarAutocomplete state={autocomplete} onSelect={handleNavigate} />
      </div>
      <BrowserFindBar find={find} />
      {/* Placeholder – error pages live inside the WebContentsView via
       *  a data: URI; see the identical block in `BrowserPanelComponent`. */}
      <div ref={placeholderRef} className="relative min-h-0 flex-1">
        {snapshot ? (
          // `object-contain object-top` — see the identical block in
          // `BrowserPanelComponent` for the DevTools-aware rationale.
          <img
            src={snapshot}
            alt=""
            className="pointer-events-none absolute inset-0 size-full object-contain object-top"
            draggable={false}
          />
        ) : null}
      </div>
    </div>
  );
}
