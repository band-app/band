import type { IDockviewPanelProps } from "dockview";
import { ArrowLeft, ArrowRight, RotateCw, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useBrowserPaneControls } from "../hooks/useBrowserPaneControls";
import { useBrowserPaneFrozen } from "../lib/browser-pane-freeze";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";
import { AddressBarAutocomplete } from "./AddressBarAutocomplete";
import { BrowserFindBar } from "./BrowserFindBar";
import { HistoryPopover } from "./HistoryPopover";

// Wait for the browser to paint at least one frame after the current
// React commit. Double-rAF is the canonical idiom: the first rAF fires
// before paint, the second after. We use this so the snapshot `<img>`
// is actually on screen before we hide the native `WebContentsView`
// — otherwise the OS can hide the view a frame before React paints,
// briefly exposing the blank placeholder underneath.
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

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
  // Static JPEG snapshot of the live webview shown while any overlay
  // (dialog / popover / dropdown / command palette) is open over the
  // pane. The native `WebContentsView` sits above the DOM, so any
  // floating UI would otherwise be hidden behind it — instead we
  // freeze the view (`browser_hide`) and paint this raster into the
  // placeholder. See `lib/browser-pane-freeze.ts`.
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const frozen = useBrowserPaneFrozen();
  const createdRef = useRef(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
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
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
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
      if (!normalized) return;

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

  // Snapshot + hide the native view whenever any overlay
  // (dialog / popover / dropdown / command palette / context menu)
  // is open anywhere in the app. Without this the overlay would
  // render *behind* the WebContentsView's OS-level compositor layer.
  // See `lib/browser-pane-freeze.ts` for the full story and
  // `BrowserViewManager.capturePage` for the snapshot side.
  //
  // The capture is best-effort: if the view is gone (LRU evicted)
  // or capture races against a navigation, we still hide the view
  // and just leave the placeholder blank — strictly better than
  // having the overlay disappear.
  //
  // Multi-pane / split-layout correctness:
  //
  //   - In a split layout, several panes can be visible at once.
  //     They each react to `frozen` independently and freeze in
  //     parallel — desired.
  //
  //   - Panes that are currently HIDDEN (inactive dockview tab in
  //     the same group, or workspace not active) must be left
  //     alone — calling `browser_show` on them when the overlay
  //     closes would surface them over the user's chosen tab.
  //     We gate on `api.isActive` + `params.wsActive` at freeze
  //     time and remember the decision in `freezeAppliedRef` so
  //     the unfreeze path only restores panes we actually hid.
  const freezeAppliedRef = useRef(false);
  useEffect(() => {
    if (!isDesktop || !created) return;
    let cancelled = false;
    if (frozen) {
      const visibleNow = api.isActive && params.wsActive !== false;
      if (!visibleNow) return; // skip — leaving the hidden view untouched
      freezeAppliedRef.current = true;
      (async () => {
        let painted = false;
        try {
          const dataUrl = await desktopInvoke<string | null>("browser_capture_page", {
            workspaceId: workspaceIdRef.current,
          });
          if (!cancelled && dataUrl) {
            // `flushSync` commits the snapshot state immediately so
            // the `<img>` is in the DOM by the time we yield. The
            // double-rAF wait then guarantees the browser has actually
            // PAINTED the img before we tell Electron to hide the
            // native view — otherwise there's a one-frame window
            // where the OS-level view is gone but the img hasn't been
            // composited yet, producing a visible flicker.
            flushSync(() => setSnapshot(dataUrl));
            await waitForPaint();
            painted = true;
          }
        } catch {
          // ignore — fall back to a blank placeholder
        }
        if (cancelled) return;
        if (!painted) {
          // Capture failed; still pause media + hide. The placeholder
          // will be blank, same as the pre-fix behaviour.
        }
        // Capture happened FIRST (so the snapshot shows the live frame,
        // not a paused-controls state); now pause media + hide.
        // `browser_pause_media` mutes + invokes `pause()` on every
        // top-frame `<video>`/`<audio>` — covers the audio that
        // `setVisible(false)` doesn't stop.
        desktopInvoke("browser_pause_media", { workspaceId: workspaceIdRef.current }).catch(
          () => {},
        );
        desktopInvoke("browser_hide", { workspaceId: workspaceIdRef.current }).catch(() => {});
      })();
    } else {
      if (freezeAppliedRef.current) {
        freezeAppliedRef.current = false;
        desktopInvoke("browser_show", { workspaceId: workspaceIdRef.current }).catch(() => {});
        // Resume after show so the page is visible by the time
        // `play()` lands — avoids the brief flash where audio
        // restarts before the visual frame snaps back.
        desktopInvoke("browser_resume_media", { workspaceId: workspaceIdRef.current }).catch(
          () => {},
        );
        // Keep the snapshot up for one more paint so the native view
        // gets a chance to come back on top before the snapshot is
        // removed. Otherwise React commits the `null` clear before the
        // OS compositor has the view visible again, briefly exposing
        // a blank placeholder.
        (async () => {
          await waitForPaint();
          if (!cancelled) setSnapshot(null);
        })();
      } else {
        setSnapshot(null);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [frozen, created, api, params.wsActive]);

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

      {/* Placeholder – the native webview is positioned over this area */}
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
  // Snapshot raster shown while any overlay is open — see comment
  // on the `BrowserPanelComponent` variant for full details.
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const frozen = useBrowserPaneFrozen();
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
  // `addressInputFocusedRef` is destructured from
  // `useBrowserPaneControls` below and read inside the
  // `browser-url-changed` listener to skip clobbering an in-progress
  // address-bar edit.

  // ------- helpers -------

  const getBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
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
  useEffect(() => {
    if (!isDesktop || !created) return;

    const showWebview = async () => {
      await invoke("browser_show", { browserId });
      const bounds = getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        await invoke("browser_set_bounds", { browserId, ...bounds });
      }
    };

    const hideWebview = async () => {
      await invoke("browser_hide", { browserId });
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

    if (!wsActive) {
      invoke("browser_hide", { browserId }).catch(() => {});
    } else if (api.isVisible) {
      invoke("browser_show", { browserId }).catch(() => {});
      const bounds = getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        invoke("browser_set_bounds", { browserId, ...bounds }).catch(() => {});
      }
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
      if (!normalized) return;

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

  // Snapshot + hide on overlay. See identical effect on
  // `BrowserPanelComponent` for the rationale, including the
  // multi-pane visibility gating below.
  const freezeAppliedRef = useRef(false);
  useEffect(() => {
    if (!isDesktop || !created) return;
    let cancelled = false;
    if (frozen) {
      // For multi-tab panes, dockview's `api.isVisible` is the
      // authoritative signal — it's `false` when this pane lives in
      // a dockview tab group that isn't currently focused, *or*
      // when its tab is inactive within its own group. We don't
      // touch hidden panes; doing so would re-show them over the
      // user's chosen tab when the overlay closes.
      const visibleNow = api.isVisible && params.wsActive !== false;
      if (!visibleNow) return;
      freezeAppliedRef.current = true;
      (async () => {
        try {
          const dataUrl = await desktopInvoke<string | null>("browser_capture_page", {
            browserId: browserIdRef.current,
          });
          if (!cancelled && dataUrl) {
            // flushSync + waitForPaint to avoid flicker — see
            // identical block in `BrowserPanelComponent` for details.
            flushSync(() => setSnapshot(dataUrl));
            await waitForPaint();
          }
        } catch {
          // ignore
        }
        if (cancelled) return;
        // See `BrowserPanelComponent` variant for capture/pause/hide ordering.
        desktopInvoke("browser_pause_media", { browserId: browserIdRef.current }).catch(() => {});
        desktopInvoke("browser_hide", { browserId: browserIdRef.current }).catch(() => {});
      })();
    } else {
      if (freezeAppliedRef.current) {
        freezeAppliedRef.current = false;
        desktopInvoke("browser_show", { browserId: browserIdRef.current }).catch(() => {});
        desktopInvoke("browser_resume_media", { browserId: browserIdRef.current }).catch(() => {});
        // Defer the snapshot clear by one paint so the native view
        // is back on top before the img is removed — see
        // `BrowserPanelComponent` for the rationale.
        (async () => {
          await waitForPaint();
          if (!cancelled) setSnapshot(null);
        })();
      } else {
        setSnapshot(null);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [frozen, created, api, params.wsActive]);

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
