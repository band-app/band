import { TooltipProvider } from "@band-app/ui";
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, type PanelSize, Separator, usePanelRef } from "react-resizable-panels";
import {
  DashboardProvider,
  DashboardShell,
  isMacPlatform,
  useDashboardStore,
  useRecordLabelLastWorktree,
  useSettingsQuery,
} from "@/dashboard";
import { DesktopDashboardAdapter, NativeShellCapabilities } from "@/dashboard/adapters/desktop";
import { WebCapabilities, WebDashboardAdapter } from "@/dashboard/adapters/web";
import { ToastHost } from "@/dashboard/components/ToastHost";
import { queryClient, queryKeys } from "@/dashboard/query-client";
import { BrowserHostBridge } from "../components/BrowserHostBridge";
import { BrowserProfileSweeper } from "../components/BrowserProfileSweeper";
import {
  CenterDragBar,
  NavControls,
  RightPanelHeaderActions,
  SidebarTitleBar,
  WorktreeChromeContext,
} from "../components/DesktopTitleBar";
import { MobileWorktreeShell } from "../components/MobileWorktreeShell";
import { RightSidepanel } from "../components/RightSidepanel";
import { crossPanelHandlers, SharedDockviewLayout } from "../components/SharedDockviewLayout";
import { ToolbarActionBar, ToolbarOverflowProvider } from "../components/ToolbarButtons";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useIsFullscreen } from "../hooks/useIsFullscreen";
import { useNavigationHistory } from "../hooks/useNavigationHistory";
import { useZoom } from "../hooks/useZoom";
import { activateBrowserGuestWorktree } from "../lib/browser-guest-retention";
import { type BrowserWebview, getBrowserWebview, zoomBrowserWebview } from "../lib/browser-webview";
import { HYDRATE_WAIT_MS, hydrateGlobal, startClientStateSync } from "../lib/client-state";
import { dispatchOpenFileEvent } from "../lib/dispatch-open-file";
import { isDesktop } from "../lib/is-desktop";
import { keepLastWorktreeOnce, pickStartWorktree, recordLastWorktree } from "../lib/last-worktree";
import { useWorktreeFromPath } from "../lib/parse-worktree";
import { worktreeHref } from "../lib/project-slugs";
import {
  loadRightPanelCollapsed,
  loadRightPanelWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  RIGHT_PANEL_MAX_SIZE,
  RIGHT_PANEL_MIN_SIZE,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  saveRightPanelCollapsed,
  saveRightPanelWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from "../lib/sidebar-width";
import {
  applyTranslucentSidebar,
  TRANSLUCENT_SIDEBAR_INIT_SCRIPT,
} from "../lib/translucent-sidebar";
import { trpc } from "../lib/trpc-client";
import { setActiveWorktree } from "../lib/worktree-cold-park";
import {
  applyZoomLevel,
  applyZoomLevelToDom,
  loadZoomLevel,
  zoomIn,
  zoomOut,
  zoomReset,
} from "../lib/zoom";
import "../styles/globals.css";

const adapter = isDesktop ? new DesktopDashboardAdapter() : new WebDashboardAdapter();
const capabilities = isDesktop ? new NativeShellCapabilities() : new WebCapabilities();

export { adapter, capabilities };

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Band" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      // Not `black-translucent`: on iOS 26 a home-screen app with that style and
      // `viewport-fit=cover` draws from the top screen edge but sizes the window
      // one status bar short (WebKit bug 301108), so the header sits under the
      // status bar and an unpaintable strip opens above the home indicator.
      // `black` gives an opaque status bar and a window that reaches the bottom
      // edge. iOS reads this tag at install time: re-add the app to pick it up.
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
      { name: "theme-color", content: "#1e1e1e" },
    ],
    links: [
      // `scope: "/"` keeps every Band URL inside the home-screen app; see
      // `server/api/web-app-manifest.ts`. iOS reads it at install time.
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-4xl font-bold">404</p>
      <p className="text-sm text-muted-foreground">Page not found</p>
      <Link to="/" className="text-sm text-primary underline">
        Back to dashboard
      </Link>
    </div>
  );
}

/** Blocking script injected into <head> to apply the theme before first paint.
 *  Reads a cached theme value from localStorage (written by ThemeSync). */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("band-theme")||"dark";var d=document.documentElement;if(t==="system"){if(window.matchMedia("(prefers-color-scheme:dark)").matches)d.classList.add("dark");else d.classList.remove("dark")}else if(t==="dark"){d.classList.add("dark")}else{d.classList.remove("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

/** Blocking script injected into <head> to apply the zoom level before first paint.
 *  Reads a cached zoom value from localStorage (written by ZoomSync / zoom.ts).
 *  Also seeds the `--app-zoom` CSS custom property the TerminalPanel relies on
 *  to counter-zoom xterm out of the document-level zoom coordinate space — see
 *  ZOOM_CSS_VAR in zoom.ts. We always set the var (defaulting to 1) so the
 *  counter-zoom `calc(1 / var(--app-zoom, 1))` resolves cleanly even when no
 *  zoom override is persisted.
 *
 *  Note: this also means `<html>` always gets an inline `zoom: 1` on first
 *  boot (the previous script left `zoom` unset in that case). This is
 *  functionally identical to the browser default, but `getComputedStyle`
 *  on `<html>` now reports `zoom: "1"` instead of `""` — do not use a
 *  truthiness check on `style.zoom` to detect "has the user ever changed
 *  zoom"; read the persisted value via `loadZoomLevel()` instead. */
const ZOOM_INIT_SCRIPT = `(function(){try{var z=localStorage.getItem("band:zoom-level");var n=1;if(z){var p=parseFloat(z);if(!isNaN(p)&&p>=0.5&&p<=2)n=p;}var d=document.documentElement;d.style.zoom=String(n);d.style.setProperty("--app-zoom",String(n));}catch(e){}})()`;

/** Applies a theme value ("dark", "light", or "system") to the document root. */
function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "system") {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  } else if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

/** Syncs the "dark" class on <html> with the persisted theme setting.
 *  Runs for ALL pages (including standalone desktop windows like tasks/cronjobs).
 *  Also caches the theme in localStorage so the blocking script can use it. */
function ThemeSync() {
  const { settings } = useSettingsQuery();
  const theme = settings.theme ?? "dark";

  useEffect(() => {
    try {
      localStorage.setItem("band-theme", theme);
    } catch {}

    applyTheme(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  // Cross-window theme sync via the storage event.
  // When another window updates "band-theme" in localStorage,
  // apply the change immediately to this window's DOM.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== "band-theme" || !e.newValue) return;
      applyTheme(e.newValue);
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return null;
}

/** Keeps the `data-translucent-sidebar` attribute on `<html>` in sync with
 *  `settings.translucentSidebar` (default on). A no-op outside the macOS
 *  desktop app, where the attribute is never set. */
function TranslucentSidebarSync() {
  const { settings, isLoading, error } = useSettingsQuery();
  const enabled = settings.translucentSidebar ?? true;

  // Wait for the real settings: applying the loading-state (or failed-fetch)
  // default would undo the pre-paint script for a user who turned it off.
  const loaded = !isLoading && !error;
  useEffect(() => {
    if (!loaded) return;
    applyTranslucentSidebar(enabled);
  }, [enabled, loaded]);

  return null;
}

/** The page of the browser tab whose pane holds keyboard focus, if any. */
function focusedBrowserWebview(): BrowserWebview | null {
  const active = document.activeElement as HTMLElement | null;
  const paneEl = active?.closest<HTMLElement>("[data-band-browser-pane]");
  const browserId = paneEl?.dataset.bandBrowserPaneKey;
  return browserId ? getBrowserWebview(browserId) : null;
}

/**
 * Exposes `window.__bandReload` for the desktop menu's Cmd+R handler.
 *
 * Routes the reload based on what's currently focused in the React DOM:
 *
 *   - Focus inside a browser pane (address bar, find bar, or the page
 *     itself, whose `<webview>` is then the active element; the pane root
 *     carries the `data-band-browser-pane` attribute): reload that tab
 *     instead of reloading the whole dashboard.
 *   - Anywhere else: `location.reload()`, matching the previous
 *     default-menu behaviour.
 */
function ReloadSync() {
  useEffect(() => {
    const globalKey = "__bandReload";
    const win = window as unknown as Record<string, unknown>;
    const handler = () => {
      const webview = focusedBrowserWebview();
      if (webview) {
        try {
          webview.reload();
        } catch {
          // The page hasn't finished attaching yet; nothing to reload.
        }
        return;
      }
      // No browser pane focused — preserve the historical "Cmd+R reloads
      // the dashboard" behaviour.
      window.location.reload();
    };
    // Same defensive ownership check pattern as `__bandOpenSettings` in
    // DashboardShell: cleanup only deletes if we still own the slot, so
    // a stale unmount can't wipe a newer registration.
    win[globalKey] = handler;
    return () => {
      if (win[globalKey] === handler) {
        delete win[globalKey];
      }
    };
  }, []);

  return null;
}

/** Syncs the zoom level across windows and exposes a global function
 *  for the Electron menu handler to call via webContents.executeJavaScript(). */
function ZoomSync() {
  useEffect(() => {
    // Safety net: apply the persisted zoom level on mount.
    // The blocking script should have already set it, but this
    // handles edge cases (e.g., new secondary window created later).
    applyZoomLevel(loadZoomLevel());

    // Expose a global function the Electron menu event handler can call via
    // webContents.executeJavaScript("if(window.__bandZoom)window.__bandZoom('in')").
    //
    // Same routing shape as `__bandReload`: if focus is inside a browser
    // pane (its chrome or the page itself), zoom that tab's page.
    // Otherwise fall through to the dashboard-wide CSS zoom.
    (window as unknown as Record<string, unknown>).__bandZoom = (action: string) => {
      const webview = focusedBrowserWebview();
      if (webview && (action === "in" || action === "out" || action === "reset")) {
        zoomBrowserWebview(webview, action);
        return;
      }
      if (action === "in") zoomIn();
      else if (action === "out") zoomOut();
      else zoomReset();
    };

    return () => {
      delete (window as unknown as Record<string, unknown>).__bandZoom;
    };
  }, []);

  // Cross-window zoom sync via the storage event.
  // When another window updates "band:zoom-level" in localStorage,
  // apply the change immediately to this window's DOM. Use the DOM-only
  // helper (no localStorage write) since the originating window already
  // persisted the value — re-saving here would be a redundant write that
  // relies on Chromium's same-value-write behaviour not echoing a storage
  // event (the spec doesn't require that). The helper still updates the
  // `--app-zoom` CSS variable and dispatches the `band:zoom-changed`
  // window event, which is what TerminalPanel subscribes to.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== "band:zoom-level" || !e.newValue) return;
      const level = Number.parseFloat(e.newValue);
      if (!Number.isNaN(level) && level >= 0.5 && level <= 2) {
        applyZoomLevelToDom(level);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return null;
}

/**
 * Renders its children once the server-kept client state (panel widths,
 * collapsed repos, …) is in localStorage, so the shell mounts with this
 * device's saved layout instead of a stale local copy. Gives up waiting
 * after `HYDRATE_WAIT_MS` so an offline load still renders from
 * localStorage. Server-side it renders nothing: the state lives in the
 * browser.
 */
function ClientStateGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  useEffect(() => {
    startClientStateSync((handler) => adapter.subscribeStatusEvents(handler));
    let cancelled = false;
    // The repo list tells which worktrees still exist. Fetching it into
    // the query cache here also saves the sidebar its own first fetch.
    const repos = queryClient
      .fetchQuery({ queryKey: queryKeys.repos, queryFn: () => adapter.listRepos() })
      .catch(() => null);
    // The projects tell whether a last project folder view still exists.
    const projects = queryClient
      .fetchQuery({ queryKey: ["projects.list"], queryFn: () => trpc.projects.list.query() })
      .then((r) => new Set(r.projects.map((p) => p.id)))
      .catch(() => null);
    void (async () => {
      await hydrateGlobal();
      // A load on `/` (every desktop launch) reopens the worktree this
      // device type last showed. A URL that names a worktree is kept.
      if (router.state.location.pathname === "/") {
        const list = await withTimeout(repos, HYDRATE_WAIT_MS);
        if (!list) keepLastWorktreeOnce();
        const projectIds = list ? await withTimeout(projects, HYDRATE_WAIT_MS) : null;
        const target = list ? pickStartWorktree(list, projectIds) : null;
        if (target && !cancelled) {
          // A project's scope id opens at `/project/<name>`.
          await router.navigate({ to: worktreeHref(target), replace: true });
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);
  return ready ? children : null;
}

/** `promise`'s value, or null when it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function AppShell() {
  // Show desktop split layout when:
  // - In a regular browser on a wide screen, OR
  // - Inside the desktop shell (always full-editor since side-panel mode was extracted)
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Wire up client-side navigation for WebCapabilities
  useEffect(() => {
    if (capabilities.navigate) return;
    (capabilities as import("@/dashboard/adapters/web").WebCapabilities).navigate = (
      href: string,
    ) => {
      router.navigate({ to: href });
    };
  }, [router]);

  // Worktree back/forward history — drives the title-bar arrow buttons.
  const routerNavigate = useCallback((href: string) => router.navigate({ to: href }), [router]);
  const navigationHistory = useNavigationHistory(routerNavigate, capabilities);

  // ⌥⌘← / ⌥⌘→ (Ctrl+Alt+← / → off macOS) step worktree history, copied from
  // Orca's worktree history keys. ⌘[ / ⌘] belong to pane cycling. The command
  // palette's Previous / Next Worktree dispatch the events.
  const { goBack, goForward } = navigationHistory;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || !e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowLeft") goBack();
      else goForward();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("band:worktree-go-back", goBack);
    window.addEventListener("band:worktree-go-forward", goForward);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("band:worktree-go-back", goBack);
      window.removeEventListener("band:worktree-go-forward", goForward);
    };
  }, [goBack, goForward]);

  // Cmd+= / Cmd+- / Cmd+Shift+0 — zoom in/out/reset (browser mode only;
  // in the desktop shell the View menu accelerators handle these keys)
  useZoom();

  // Derive active worktree from pathname for title bar display
  const activeWorktreeId = useWorktreeFromPath(pathname);

  // Tell the memory policies which worktree is on screen, on both layouts:
  // `worktree-cold-park.ts` stamps when each worktree was hidden (terminals,
  // LSP clients and file watchers of a cold worktree release), and the
  // browser guest budget orders worktrees by activation. It is also the
  // worktree the next launch reopens (`last-worktree.ts`).
  useEffect(() => {
    setActiveWorktree(activeWorktreeId);
    activateBrowserGuestWorktree(activeWorktreeId);
    recordLastWorktree(activeWorktreeId);
  }, [activeWorktreeId]);
  useRecordLabelLastWorktree(activeWorktreeId);

  // Get the worktree path from the statuses store (for Finder / copy path)
  const worktreePath = useDashboardStore((s) =>
    activeWorktreeId ? s.statuses.get(activeWorktreeId)?.worktreePath : undefined,
  );

  // Inform the server which worktree the user is currently focused on so
  // the `band open` CLI command knows where to route files when called
  // without an explicit `--worktree` flag. The adapter de-duplicates so
  // it's safe to call on every render — the mutation only fires when the
  // value actually changes.
  // `adapter` is a module-level singleton (created once per page load)
  // and is intentionally omitted from the dep array — biome's
  // `useExhaustiveDependencies` rejects outer-scope values as deps
  // because mutating them doesn't trigger a re-render. If we ever
  // promote it to a context or prop, list it then.
  useEffect(() => {
    void adapter.setActiveWorktree(activeWorktreeId);
  }, [activeWorktreeId]);

  // Listen for `band open` events from the SSE stream and route the
  // dashboard to the requested file. The actual dispatch logic lives
  // in `lib/dispatch-open-file.ts` so it can be tested in isolation
  // without spinning up the dockview.
  //
  // Mobile / narrow web: short-circuit here. `band open` is a desktop
  // developer affordance — the mobile worktree layout's tab + file
  // state is local-only, so an open-file event has nowhere to land
  // (see issue #467). `useDesktopLayout` is read through a ref so a
  // viewport resize doesn't tear down the SSE subscription — we read
  // the current value at event time instead.
  const useDesktopLayoutRef = useRef(useDesktopLayout);
  useDesktopLayoutRef.current = useDesktopLayout;
  useEffect(() => {
    const unsubscribe = adapter.subscribeStatusEvents((event) => {
      if (!useDesktopLayoutRef.current) return;
      dispatchOpenFileEvent(event, {
        onOpenFile: crossPanelHandlers.onOpenFile,
        onActivateFilesPanel: crossPanelHandlers.onActivateFilesPanel,
      });
    });
    return unsubscribe;
    // `adapter` (module-level singleton) and `crossPanelHandlers`
    // (module-level mutable registry) are intentionally omitted from
    // deps — see the comment on the setActiveWorktree effect above.
  }, []);

  // Copy the worktree path to clipboard
  const handleCopyPath = useCallback(() => {
    if (!worktreePath) return;
    navigator.clipboard.writeText(worktreePath).catch(() => {});
  }, [worktreePath]);

  // ──────────────────────────────────────────────────────────────────────
  // Repo-list sidebar (separate from the dockview). Collapsing/expanding
  // the sidebar Panel via its imperative handle hides/shows the list WITHOUT
  // unmounting the sibling Panel that holds <SharedDockviewLayout /> — so the
  // dockview (and every cached worktree's chat/terminal/browser + live PTYs)
  // survives a toggle. Width is persisted as a percentage; the last-left
  // visibility is persisted separately.
  // ──────────────────────────────────────────────────────────────────────
  const sidebarPanelRef = usePanelRef();

  // DOM refs to the two panels' outer (flex) elements. `<Panel className>`
  // targets a nested div, so the element whose `flex-grow` the library animates
  // is reached via `elementRef` — we need it to arm a width transition on a
  // programmatic toggle.
  const sidebarElRef = useRef<HTMLDivElement | null>(null);
  const mainElRef = useRef<HTMLDivElement | null>(null);

  // Right sidepanel (Explorer + Changes) — mirrors the sidebar plumbing above.
  // It lives in a nested group inside the main column, so its toggle animates
  // against the inner `center` panel element, not the outer `main`.
  const rightPanelRef = usePanelRef();
  const rightPanelElRef = useRef<HTMLDivElement | null>(null);
  const centerElRef = useRef<HTMLDivElement | null>(null);
  const rightInit = useRef({
    collapsed: loadRightPanelCollapsed(),
    width: loadRightPanelWidth(),
  });
  const [rightVisible, setRightVisible] = useState(() => !rightInit.current.collapsed);

  // Read the persisted sidebar state ONCE at mount (these `<Group>`/`useState`
  // seeds are only consumed on the first render). Stashing them in a ref keeps
  // the localStorage reads off the re-render path, matching the `sidebarVisible`
  // lazy initializer below.
  const sidebarInit = useRef({ collapsed: loadSidebarCollapsed(), width: loadSidebarWidth() });

  // Seed the initial visibility from the persisted collapsed flag directly
  // into the Group's `defaultLayout`, rather than collapsing imperatively
  // after mount — the Group applies `defaultLayout` during its own
  // post-mount measurement, which would race (and override) an effect-driven
  // `collapse()`. A sidebar size of 0 is below `minSize`, so a collapsible
  // panel starts collapsed.
  const [sidebarVisible, setSidebarVisible] = useState(() => !sidebarInit.current.collapsed);

  // Memoized at mount — values come from an immutable ref, and `<Group>`
  // only reads `defaultLayout` on its first render.
  const sidebarDefaultLayout = useMemo(
    () =>
      sidebarInit.current.collapsed
        ? { sidebar: 0, main: 100 }
        : sidebarInit.current.width
          ? { sidebar: sidebarInit.current.width, main: 100 - sidebarInit.current.width }
          : undefined,
    [],
  );

  // The right sidepanel lives in a NESTED [center | rightpanel] group inside the
  // main column, BELOW the worktree title bar — so it aligns with the dockview
  // content, not the title-bar row. This is that inner group's initial layout.
  const centerDefaultLayout = useMemo(() => {
    if (rightInit.current.collapsed) return { center: 100, rightpanel: 0 };
    if (rightInit.current.width != null) {
      return { center: 100 - rightInit.current.width, rightpanel: rightInit.current.width };
    }
    return undefined;
  }, []);

  // Skip the first layout callback: it fires during mount with the restored
  // layout, which we don't want to re-persist.
  const skipFirstSidebarLayout = useRef(true);
  // `onLayoutChanged` fires for every distinct layout during a drag (~60/s),
  // so coalesce the persist to at most one localStorage write per frame.
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const sidebarWidthRafRef = useRef<number | null>(null);
  const handleSidebarLayoutChanged = useCallback((layout: Record<string, number>) => {
    if (skipFirstSidebarLayout.current) {
      skipFirstSidebarLayout.current = false;
      return;
    }
    // Only persist a real (visible) width — a 0 here means the panel is
    // collapsed, and storing that would lose the user's chosen width on the
    // next expand.
    if (layout.sidebar == null || layout.sidebar <= 0) return;
    pendingSidebarWidthRef.current = layout.sidebar;
    if (sidebarWidthRafRef.current != null) return;
    sidebarWidthRafRef.current = requestAnimationFrame(() => {
      sidebarWidthRafRef.current = null;
      if (pendingSidebarWidthRef.current != null) {
        saveSidebarWidth(pendingSidebarWidthRef.current);
        pendingSidebarWidthRef.current = null;
      }
    });
  }, []);

  // The nested center|rightpanel group persists the right panel's width, same
  // RAF-coalesced pattern as the sidebar above.
  const skipFirstCenterLayout = useRef(true);
  const pendingRightWidthRef = useRef<number | null>(null);
  const rightWidthRafRef = useRef<number | null>(null);
  const handleCenterLayoutChanged = useCallback((layout: Record<string, number>) => {
    if (skipFirstCenterLayout.current) {
      skipFirstCenterLayout.current = false;
      return;
    }
    if (layout.rightpanel == null || layout.rightpanel <= 0) return;
    pendingRightWidthRef.current = layout.rightpanel;
    if (rightWidthRafRef.current != null) return;
    rightWidthRafRef.current = requestAnimationFrame(() => {
      rightWidthRafRef.current = null;
      if (pendingRightWidthRef.current != null) {
        saveRightPanelWidth(pendingRightWidthRef.current);
        pendingRightWidthRef.current = null;
      }
    });
  }, []);

  // Single source of truth for the toggle button's pressed state + the
  // persisted visibility. Fires for the toggle button, ⌘B, and drag-to-
  // collapse alike. `prevPanelSize === undefined` is the mount fire — skip
  // it so it can't clobber a stored "collapsed". `onResize` fires on every
  // pixel of a drag, so only write localStorage when the collapsed/expanded
  // state actually flips (not on every intermediate width).
  const lastSidebarVisibleRef = useRef(!sidebarInit.current.collapsed);
  const handleSidebarResize = useCallback(
    (size: PanelSize, _id: string | number | undefined, prev: PanelSize | undefined) => {
      if (prev === undefined) return;
      const visible = size.asPercentage > 0;
      // Bail unless the open/closed state actually flips — `onResize` fires
      // on every drag pixel, so this avoids both a redundant re-render and a
      // redundant localStorage write per pixel.
      if (visible === lastSidebarVisibleRef.current) return;
      lastSidebarVisibleRef.current = visible;
      setSidebarVisible(visible);
      saveSidebarCollapsed(!visible);
    },
    [],
  );

  // Same collapsed/expanded tracking for the right sidepanel.
  const lastRightVisibleRef = useRef(!rightInit.current.collapsed);
  const handleRightResize = useCallback(
    (size: PanelSize, _id: string | number | undefined, prev: PanelSize | undefined) => {
      if (prev === undefined) return;
      const visible = size.asPercentage > 0;
      if (visible === lastRightVisibleRef.current) return;
      lastRightVisibleRef.current = visible;
      setRightVisible(visible);
      saveRightPanelCollapsed(!visible);
    },
    [],
  );

  // Arm a one-shot width transition on both panels so a programmatic sidebar
  // toggle (⌘B / the toggle button / ⌃0) slides open/closed instead of
  // snapping. Set synchronously on the DOM before `collapse()`/`expand()` so
  // the transition is in place when the library writes the new `flex-grow`
  // (React never owns the `transition` property, so its re-render won't clear
  // it). Removed as soon as it finishes so dragging the separator stays
  // pixel-exact — a persistent transition would make the drag lag.
  const animateSidebarToggle = useCallback(() => {
    // Guard first: the cleanup that strips the transition back off is keyed on
    // the sidebar element's `transitionend`. Without the sidebar we have no way
    // to schedule that cleanup, so never write the transition (onto either
    // panel) unless the removal path will also run.
    const sidebar = sidebarElRef.current;
    if (!sidebar) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = [sidebar, mainElRef.current];
    for (const el of els) {
      if (el)
        el.style.transition =
          "flex-grow 200ms cubic-bezier(0.77, 0, 0.175, 1), flex-basis 200ms cubic-bezier(0.77, 0, 0.175, 1)";
    }
    let timer = 0;
    const clear = (e?: TransitionEvent) => {
      // Ignore transitions bubbling up from the sidebar's own contents; only
      // the panel's flex-grow reaching its target ends the toggle.
      if (e && (e.target !== sidebar || e.propertyName !== "flex-grow")) return;
      for (const el of els) if (el) el.style.transition = "";
      sidebar.removeEventListener("transitionend", clear);
      if (timer) window.clearTimeout(timer);
    };
    // Fallback in case transitionend never fires (e.g. no size change).
    timer = window.setTimeout(clear, 280);
    sidebar.addEventListener("transitionend", clear);
  }, []);

  const toggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    animateSidebarToggle();
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [sidebarPanelRef, animateSidebarToggle]);

  // Mirror of `animateSidebarToggle` for the right sidepanel: arm a one-shot
  // width transition on the right panel + the main panel so a programmatic
  // toggle slides instead of snapping. Keyed on the right panel's own
  // `transitionend` for cleanup.
  const animateRightToggle = useCallback(() => {
    const right = rightPanelElRef.current;
    if (!right) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = [right, centerElRef.current];
    for (const el of els) {
      if (el)
        el.style.transition =
          "flex-grow 200ms cubic-bezier(0.77, 0, 0.175, 1), flex-basis 200ms cubic-bezier(0.77, 0, 0.175, 1)";
    }
    let timer = 0;
    const clear = (e?: TransitionEvent) => {
      if (e && (e.target !== right || e.propertyName !== "flex-grow")) return;
      for (const el of els) if (el) el.style.transition = "";
      right.removeEventListener("transitionend", clear);
      if (timer) window.clearTimeout(timer);
    };
    timer = window.setTimeout(clear, 280);
    right.addEventListener("transitionend", clear);
  }, []);

  const toggleRightPanel = useCallback(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    animateRightToggle();
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [rightPanelRef, animateRightToggle]);

  // ⌘B toggles the sidebar; ⌃0 / "Focus Repos" reveal it before focusing
  // the list.
  useEffect(() => {
    const onToggle = () => toggleSidebar();
    const onShow = () => {
      if (sidebarPanelRef.current?.isCollapsed()) {
        animateSidebarToggle();
        sidebarPanelRef.current.expand();
      }
    };
    window.addEventListener("band:toggle-sidebar", onToggle);
    window.addEventListener("band:show-sidebar", onShow);
    return () => {
      window.removeEventListener("band:toggle-sidebar", onToggle);
      window.removeEventListener("band:show-sidebar", onShow);
    };
  }, [toggleSidebar, sidebarPanelRef, animateSidebarToggle]);

  // ⌥⌘B toggles the right sidepanel; ⇧⌘E / ⇧⌘G (and the title-bar switcher)
  // reveal it.
  useEffect(() => {
    const onToggle = () => toggleRightPanel();
    const onShow = () => {
      if (rightPanelRef.current?.isCollapsed()) {
        animateRightToggle();
        rightPanelRef.current.expand();
      }
    };
    window.addEventListener("band:toggle-right-panel", onToggle);
    window.addEventListener("band:show-right-panel", onShow);
    return () => {
      window.removeEventListener("band:toggle-right-panel", onToggle);
      window.removeEventListener("band:show-right-panel", onShow);
    };
  }, [toggleRightPanel, rightPanelRef, animateRightToggle]);

  // Cancel a pending sidebar-width RAF on unmount so it can't fire (and write
  // localStorage) after the component is gone — matches the cleanup discipline
  // of the other effects in this file.
  useEffect(
    () => () => {
      if (sidebarWidthRafRef.current != null) cancelAnimationFrame(sidebarWidthRafRef.current);
      if (rightWidthRafRef.current != null) cancelAnimationFrame(rightWidthRafRef.current);
    },
    [],
  );

  // Props for the nav cluster (sidebar toggle + back/forward) hosted in the
  // stationary overlay in the render below. The overflow actions always live in
  // DashboardShell's bottom action bar, so the cluster carries no menu of
  // its own.
  //
  // Memoized for a stable prop reference across the frequent AppShell
  // re-renders (route changes, worktree switches, sidebar toggles). Hooks
  // must run unconditionally, so this sits above the narrow/mobile early
  // return below.
  const navControlProps = useMemo(
    () => ({
      onGoBack: navigationHistory.goBack,
      onGoForward: navigationHistory.goForward,
      canGoBack: navigationHistory.canGoBack,
      canGoForward: navigationHistory.canGoForward,
      onToggleSidebar: toggleSidebar,
      sidebarVisible,
    }),
    [
      navigationHistory.goBack,
      navigationHistory.goForward,
      navigationHistory.canGoBack,
      navigationHistory.canGoForward,
      toggleSidebar,
      sidebarVisible,
    ],
  );

  // Single source for the macOS traffic-light gutter: the offset is applied
  // to the stationary nav-cluster overlay below so the sidebar-toggle /
  // back-forward buttons clear the traffic lights; the top-row drag surfaces
  // themselves take no offset prop.
  const isFullscreen = useIsFullscreen();
  const titleBarOffset = isDesktop && !isFullscreen ? "pl-[80px]" : "pl-2";

  // The center tab strip reserves the overlay's width at its left edge while
  // the sidebar is collapsed (`SidebarGutter`), so it tracks the rendered
  // width: it changes with the traffic-light offset (fullscreen) and with
  // whether the back/forward arrows render.
  const [navOverlayWidth, setNavOverlayWidth] = useState(0);
  const navOverlayRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(() => setNavOverlayWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const worktreeChrome = useMemo(
    () => ({
      sidebarVisible,
      navOverlayWidth,
      rightPanelVisible: rightVisible,
      onToggleRightPanel: activeWorktreeId ? toggleRightPanel : undefined,
    }),
    [sidebarVisible, navOverlayWidth, rightVisible, activeWorktreeId, toggleRightPanel],
  );

  // Mobile: the route's own page (the full-screen repo list on `/`) and,
  // over it, the worktree layout, which keeps every visited worktree
  // mounted across route changes the way `SharedDockviewLayout` does below.
  if (!useDesktopLayout) {
    return (
      <>
        <Outlet />
        <MobileWorktreeShell />
      </>
    );
  }

  return (
    <ToolbarOverflowProvider>
      <WorktreeChromeContext.Provider value={worktreeChrome}>
        {/* With the translucent sidebar on, this root is transparent so the
          window's vibrancy layer reaches the sidebar column; the main panel
          below paints its own solid background. */}
        <div className="relative flex flex-col h-full w-full overflow-hidden bg-background text-foreground translucent-sidebar:bg-transparent">
          <div className="flex-1 min-h-0 overflow-hidden">
            <Group
              orientation="horizontal"
              defaultLayout={sidebarDefaultLayout}
              onLayoutChanged={handleSidebarLayoutChanged}
              className="h-full w-full"
            >
              <Panel
                id="sidebar"
                panelRef={sidebarPanelRef}
                elementRef={sidebarElRef}
                defaultSize={SIDEBAR_MIN_SIZE}
                minSize={SIDEBAR_MIN_SIZE}
                maxSize={SIDEBAR_MAX_SIZE}
                collapsible
                collapsedSize="0%"
                onResize={handleSidebarResize}
              >
                {/* The whole sidebar column (its title-bar half + the repo
                  list) is painted with the `--sidebar` surface so it reads as a
                  distinct panel from the worktree layout to its right. With
                  the translucent sidebar on (macOS desktop), the surface is a
                  light tint over the window's vibrancy layer instead. */}
                {/* Each column pads the status-bar and home-indicator insets
                  itself, so the padding takes that column's surface colour. */}
                <div
                  className="h-full flex flex-col overflow-hidden border-r border-border bg-sidebar translucent-sidebar:bg-(--sidebar-translucent) pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
                  data-testid="app-shell__sidebar"
                >
                  {/* Pure drag/paint surface — the sidebar toggle + back/forward
                    arrows live in the stationary overlay above; the overflow
                    actions live in DashboardShell's bottom action bar below. */}
                  <SidebarTitleBar />
                  <div className="flex-1 min-h-0">
                    <DashboardShell hideTitleBar bottomActions={<ToolbarActionBar />} />
                  </div>
                </div>
              </Panel>
              {/* Opaque in every state, hover and drag included: under the
                translucent sidebar the root behind it is transparent, so a
                see-through tint would let the vibrancy layer through past the
                sidebar's border. The colours equal the other separator's
                accent tints over `--background`. */}
              {/* react-resizable-panels writes `id` into `data-testid`. */}
              <Separator
                id="app-shell__sidebar-separator"
                className="w-[3px] bg-background hover:bg-[color-mix(in_srgb,var(--accent-foreground)_20%,var(--background))] active:bg-[color-mix(in_srgb,var(--accent-foreground)_30%,var(--background))] transition-colors cursor-col-resize"
              />
              <Panel id="main" elementRef={mainElRef} minSize="20%">
                {/* Stays mounted across sidebar toggles — never unmount this
                  subtree or the dockview tears down all cached worktrees. */}
                {/* The dockview column and the right sidepanel share one
                  full-height row. There is no title bar over the dockview
                  column: its tab strip is the top row, level with the
                  sidepanel's own header row (tabs, open in editor, collapse).
                  With no worktree active there is no tab strip, so a plain
                  drag bar takes its place. */}
                <div
                  className="relative h-full min-w-0 overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
                  data-testid="app-shell__main"
                >
                  <Group
                    orientation="horizontal"
                    defaultLayout={centerDefaultLayout}
                    onLayoutChanged={handleCenterLayoutChanged}
                    className="h-full w-full"
                  >
                    <Panel id="center" elementRef={centerElRef} minSize="30%">
                      <div className="h-full flex flex-col min-w-0 overflow-hidden">
                        {!activeWorktreeId && <CenterDragBar />}
                        {/* `relative` anchors SharedDockviewLayout's `absolute
                          inset-0` overlay to the dockview area. */}
                        <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
                          <Outlet />
                          <SharedDockviewLayout />
                          <BrowserHostBridge />
                          <BrowserProfileSweeper />
                        </div>
                      </div>
                    </Panel>
                    <Separator className="w-[3px] bg-transparent hover:bg-accent-foreground/20 active:bg-accent-foreground/30 transition-colors cursor-col-resize" />
                    <Panel
                      id="rightpanel"
                      panelRef={rightPanelRef}
                      elementRef={rightPanelElRef}
                      defaultSize={RIGHT_PANEL_MIN_SIZE}
                      minSize={RIGHT_PANEL_MIN_SIZE}
                      maxSize={RIGHT_PANEL_MAX_SIZE}
                      collapsible
                      collapsedSize="0%"
                      onResize={handleRightResize}
                    >
                      <div
                        className="h-full flex flex-col overflow-hidden border-l border-border bg-background"
                        data-testid="app-shell__right-panel"
                        data-visible={rightVisible ? "true" : "false"}
                      >
                        <RightSidepanel
                          visible={rightVisible}
                          headerActions={
                            <RightPanelHeaderActions
                              worktreePath={activeWorktreeId ? worktreePath : undefined}
                              onCopyPath={activeWorktreeId ? handleCopyPath : undefined}
                              onToggleRightPanel={
                                activeWorktreeId && rightVisible ? toggleRightPanel : undefined
                              }
                            />
                          }
                        />
                      </div>
                    </Panel>
                  </Group>
                </div>
              </Panel>
            </Group>
          </div>
          {/* The nav cluster (sidebar toggle + back/forward) is hosted ONCE in
            this stationary overlay pinned over the top row's left edge,
            floating above the sidebar's title bar and the center column's tab
            strip. Hosting it inside either means remounting it
            on every sidebar toggle inside an overflow-clipped, animating
            panel — the buttons visibly flickered mid-tween. Here the panels
            slide beneath it and it never moves or remounts. The container is
            pointer-events-none so the drag regions beneath stay draggable;
            NavControls re-enables pointer events on itself.

            MUST come after every top-row drag surface in DOM order (the
            sidebar's title bar, the center tab strip, its sidebar gutter, and
            the center drag bar): Chromium computes the
            window's draggable region by walking the layout tree in document
            order, unioning `app-region: drag` rects and subtracting `no-drag`
            rects as it goes — z-index is irrelevant. If this overlay renders
            before them, their drag rects re-cover the buttons and
            every click on them starts a window drag in the desktop app.
            It sits below the status-bar inset, like the top row. */}
          <div
            ref={navOverlayRef}
            data-testid="app-shell__nav-overlay"
            className={`pointer-events-none absolute top-[env(safe-area-inset-top)] left-0 z-10 flex h-[38px] items-center ${titleBarOffset}`}
          >
            <NavControls {...navControlProps} />
          </div>
        </div>
      </WorktreeChromeContext.Provider>
    </ToolbarOverflowProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script to prevent theme flash */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script to prevent zoom layout flash */}
        <script dangerouslySetInnerHTML={{ __html: ZOOM_INIT_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script to prevent a solid-sidebar flash */}
        <script dangerouslySetInnerHTML={{ __html: TRANSLUCENT_SIDEBAR_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <ThemeSync />
      <TranslucentSidebarSync />
      <ZoomSync />
      <ReloadSync />
      <TooltipProvider>
        <ClientStateGate>
          <AppShell />
        </ClientStateGate>
        <ToastHost />
      </TooltipProvider>
    </DashboardProvider>
  );
}
