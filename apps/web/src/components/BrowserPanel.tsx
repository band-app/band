import type { IDockviewPanelProps } from "dockview";
import { ArrowLeft, ArrowRight, RotateCw, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBrowserFindInPage } from "../hooks/useBrowserFindInPage";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";
import { BrowserFindBar } from "./BrowserFindBar";

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
  // `inputUrl` is user-owned while the address-bar input has keyboard
  // focus: incoming `browser-url-changed` events (e.g. navigation
  // completing, redirects, in-page hash updates) must not overwrite
  // the half-typed URL the user is editing. We sync from focus/blur
  // rather than reading `document.activeElement` so the check stays
  // synchronous inside the event listener.
  const addressInputFocusedRef = useRef(false);

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

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await desktopListen<{
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
      });
    })();

    return () => {
      unlisten?.();
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

  const handleToggleDevTools = useCallback(async () => {
    try {
      await invoke("browser_toggle_dev_tools", { workspaceId });
    } catch (e) {
      console.error("browser_toggle_dev_tools failed:", e);
    }
  }, [invoke, workspaceId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleNavigate(inputUrl);
        return;
      }
      // Escape abandons an in-progress edit and snaps the input back
      // to the canonical URL with the whole value re-selected — same
      // as Chrome's address bar. Keep focus so the user can type to
      // replace without re-clicking the bar.
      if (e.key === "Escape") {
        e.preventDefault();
        setInputUrl(currentUrlRef.current);
        const input = e.currentTarget;
        // Defer past the React commit so we select against the
        // restored value (setting `input.value` mid-render would clear
        // any selection we made here).
        requestAnimationFrame(() => input.select());
      }
    },
    [inputUrl, handleNavigate],
  );

  const handleAddressFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    addressInputFocusedRef.current = true;
    e.target.select();
  }, []);

  const handleAddressBlur = useCallback(() => {
    addressInputFocusedRef.current = false;
    // Re-sync to the latest committed URL in case events fired (and
    // were ignored) while we were focused. Matches Chrome: typed-but-
    // not-submitted URLs revert on blur.
    setInputUrl(currentUrlRef.current);
  }, []);

  // ------- find in page -------
  const find = useBrowserFindInPage({ key: workspaceId, keyName: "workspaceId" });

  // Pane-scoped Cmd+F / Ctrl+F handler. Covers the case where keyboard
  // focus is inside the React DOM (address bar, find bar input, the
  // panel itself). The complementary case — focus inside the
  // WebContentsView — is handled by the main process via
  // `before-input-event` and reaches the hook through the
  // `browser-find-shortcut` event.
  const handlePaneKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key.toLowerCase() !== "f") return;
      if (e.shiftKey || e.altKey) return;
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const wantsFind = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!wantsFind) return;
      e.preventDefault();
      e.stopPropagation();
      find.open();
    },
    [find],
  );

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
      // Cmd+R routing: the desktop menu's renderer-global handler walks
      // up from `document.activeElement` looking for these data attrs
      // to decide whether to reload this tab or fall through to the
      // app.
      data-band-browser-pane=""
      data-band-browser-pane-key={workspaceId}
      data-band-browser-pane-keyname="workspaceId"
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
          onKeyDown={handleKeyDown}
          onFocus={handleAddressFocus}
          onBlur={handleAddressBlur}
          className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
          placeholder="Enter URL or search..."
        />
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
      </div>

      {/* Find-in-page bar (Cmd+F / Ctrl+F) — slots between the address bar
       *  and the webview placeholder so it stacks naturally above the
       *  native WebContentsView. */}
      <BrowserFindBar find={find} />

      {/* Placeholder – the native webview is positioned over this area */}
      <div ref={placeholderRef} className="min-h-0 flex-1" />
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
  const { browserId, initialUrl } = params;

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
  // While the address-bar input has focus, the user owns `inputUrl` —
  // browser-url-changed events must not overwrite an in-progress edit.
  const addressInputFocusedRef = useRef(false);

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
  const urlPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        try {
          const origin = new URL(url).origin;
          setFaviconUrl(browserIdRef.current, `${origin}/favicon.ico`);
        } catch {
          // ignore invalid URLs
        }
      });
      unlistenTitle = await desktopListen<{ browser_id: string; title: string }>(
        "browser-title-changed",
        (event) => {
          if (event.payload.browser_id !== browserIdRef.current) return;
          if (event.payload.title) {
            api.setTitle(event.payload.title);
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

  const handleToggleDevTools = useCallback(async () => {
    try {
      await invoke("browser_toggle_dev_tools", { browserId });
    } catch (e) {
      console.error("browser_toggle_dev_tools failed:", e);
    }
  }, [invoke, browserId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleNavigate(inputUrl);
        return;
      }
      // Escape abandons an in-progress edit and snaps the input back
      // to the canonical URL with the whole value re-selected — same
      // as Chrome's address bar. Keep focus so the user can type to
      // replace without re-clicking the bar.
      if (e.key === "Escape") {
        e.preventDefault();
        setInputUrl(currentUrlRef.current);
        const input = e.currentTarget;
        // Defer past the React commit so we select against the
        // restored value (setting `input.value` mid-render would clear
        // any selection we made here).
        requestAnimationFrame(() => input.select());
      }
    },
    [inputUrl, handleNavigate],
  );

  const handleAddressFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    addressInputFocusedRef.current = true;
    e.target.select();
  }, []);

  const handleAddressBlur = useCallback(() => {
    addressInputFocusedRef.current = false;
    // Re-sync to the latest committed URL in case events fired (and
    // were ignored) while we were focused.
    setInputUrl(currentUrlRef.current);
  }, []);

  // ------- find in page -------
  const find = useBrowserFindInPage({ key: browserId, keyName: "browserId" });

  const handlePaneKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key.toLowerCase() !== "f") return;
      if (e.shiftKey || e.altKey) return;
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const wantsFind = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!wantsFind) return;
      e.preventDefault();
      e.stopPropagation();
      find.open();
    },
    [find],
  );

  if (!browserId) return null;

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
      data-band-browser-pane=""
      data-band-browser-pane-key={browserId}
      data-band-browser-pane-keyname="browserId"
    >
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
          onKeyDown={handleKeyDown}
          onFocus={handleAddressFocus}
          onBlur={handleAddressBlur}
          className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
          placeholder="Enter URL or search..."
        />
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
      </div>
      <BrowserFindBar find={find} />
      <div ref={placeholderRef} className="min-h-0 flex-1" />
    </div>
  );
}
