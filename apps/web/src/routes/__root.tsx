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
import {
  FolderOpen,
  GitCompare,
  Globe,
  MessageSquare,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, type PanelSize, Separator, usePanelRef } from "react-resizable-panels";
import {
  DashboardProvider,
  DashboardShell,
  useDashboardStore,
  useSettingsQuery,
  useUpdateSettings,
} from "@/dashboard";
import { DesktopDashboardAdapter, NativeShellCapabilities } from "@/dashboard/adapters/desktop";
import { WebCapabilities, WebDashboardAdapter } from "@/dashboard/adapters/web";
import { BrowserHostBridge } from "../components/BrowserHostBridge";
import {
  NavControls,
  type PanelItem,
  SidebarTitleBar,
  WorkspaceTitleBar,
} from "../components/DesktopTitleBar";
import { crossPanelHandlers, SharedDockviewLayout } from "../components/SharedDockviewLayout";
import { ToolbarActionBar, ToolbarOverflowProvider } from "../components/ToolbarButtons";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useIsFullscreen } from "../hooks/useIsFullscreen";
import { useNavigationHistory } from "../hooks/useNavigationHistory";
import { useZoom } from "../hooks/useZoom";
import { getElectronBridge } from "../lib/desktop-ipc";
import { dispatchOpenFileEvent } from "../lib/dispatch-open-file";
import { isDesktop } from "../lib/is-desktop";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import {
  loadSidebarCollapsed,
  loadSidebarWidth,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from "../lib/sidebar-width";
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
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "theme-color", content: "#1e1e1e" },
    ],
  }),
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

/**
 * Exposes `window.__bandReload` for the desktop menu's Cmd+R handler.
 *
 * Routes the reload based on what's currently focused in the React DOM:
 *
 *   - Focus inside a browser pane (address bar, find bar, tab handle,
 *     etc., identified by the `data-band-browser-pane` attribute the
 *     `BrowserPanel` root sets): reload that browser tab via the
 *     `browser_reload` IPC instead of reloading the whole dashboard.
 *   - Anywhere else: `location.reload()`, matching the previous
 *     default-menu behaviour.
 *
 * The webview-focused case (user is clicked inside a rendered web page)
 * is handled in the main process *before* this global is called — see
 * `menu.ts::reloadFocused`. By the time `__bandReload` runs, focus is
 * inside the main-window DOM.
 */
function ReloadSync() {
  useEffect(() => {
    const globalKey = "__bandReload";
    const win = window as unknown as Record<string, unknown>;
    const handler = () => {
      // Walk up from the focused element looking for a browser-pane root.
      const active = document.activeElement as HTMLElement | null;
      const paneEl = active?.closest("[data-band-browser-pane]") as HTMLElement | null;
      if (paneEl) {
        const key = paneEl.dataset.bandBrowserPaneKey;
        const keyName = paneEl.dataset.bandBrowserPaneKeyname;
        if (key && (keyName === "browserId" || keyName === "workspaceId")) {
          const bridge = getElectronBridge();
          if (bridge) {
            void bridge.invoke("browser_reload", { [keyName]: key });
            return;
          }
        }
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
    // pane's React chrome (address bar, find bar, etc.), zoom that
    // tab's WebContentsView via IPC. Otherwise fall through to the
    // dashboard-wide CSS zoom. The "focus inside the rendered web page"
    // case is handled in the main process before this function is
    // called — see `menu.ts::zoomFocused`.
    (window as unknown as Record<string, unknown>).__bandZoom = (action: string) => {
      const active = document.activeElement as HTMLElement | null;
      const paneEl = active?.closest("[data-band-browser-pane]") as HTMLElement | null;
      if (paneEl) {
        const key = paneEl.dataset.bandBrowserPaneKey;
        const keyName = paneEl.dataset.bandBrowserPaneKeyname;
        if (key && (keyName === "browserId" || keyName === "workspaceId")) {
          const bridge = getElectronBridge();
          if (bridge) {
            void bridge.invoke("browser_zoom", { [keyName]: key, action });
            return;
          }
        }
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

function AppShell() {
  const { settings } = useSettingsQuery();
  const updateSettings = useUpdateSettings();
  const hiddenPanels = useMemo(
    () =>
      ((settings as unknown as Record<string, unknown>).hiddenPanels as string[] | undefined) ?? [],
    [settings],
  );
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

  // Workspace back/forward history — drives the title-bar arrow buttons.
  const routerNavigate = useCallback((href: string) => router.navigate({ to: href }), [router]);
  const navigationHistory = useNavigationHistory(routerNavigate, capabilities);

  // Cmd+= / Cmd+- / Cmd+0 — zoom in/out/reset (browser mode only;
  // in the desktop shell the View menu accelerators handle these keys)
  useZoom();

  // Derive active workspace from pathname for title bar display
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  // Get the workspace path from the statuses store (for Finder / copy path)
  const workspacePath = useDashboardStore((s) =>
    activeWorkspaceId ? s.statuses.get(activeWorkspaceId)?.worktreePath : undefined,
  );

  // Inform the server which workspace the user is currently focused on so
  // the `band open` CLI command knows where to route files when called
  // without an explicit `--workspace` flag. The adapter de-duplicates so
  // it's safe to call on every render — the mutation only fires when the
  // value actually changes.
  // `adapter` is a module-level singleton (created once per page load)
  // and is intentionally omitted from the dep array — biome's
  // `useExhaustiveDependencies` rejects outer-scope values as deps
  // because mutating them doesn't trigger a re-render. If we ever
  // promote it to a context or prop, list it then.
  useEffect(() => {
    void adapter.setActiveWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // Listen for `band open` events from the SSE stream and route the
  // dashboard to the requested file. The actual dispatch logic lives
  // in `lib/dispatch-open-file.ts` so it can be tested in isolation
  // without spinning up the dockview.
  //
  // Mobile / narrow web: short-circuit here. `band open` is a desktop
  // developer affordance — the mobile workspace layout's tab + file
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
    // deps — see the comment on the setActiveWorkspace effect above.
  }, []);

  // Panel items for the title bar panel switcher dropdown
  const panelItems: PanelItem[] = useMemo(
    () => [
      { id: "chat", label: "Chat", icon: MessageSquare, shortcut: "⌃⌘I" },
      { id: "changes", label: "Changes", icon: GitCompare, shortcut: "⇧⌘G" },
      { id: "files", label: "Files", icon: FolderOpen, shortcut: "⇧⌘E" },
      { id: "terminal", label: "Terminal", icon: TerminalIcon, shortcut: "⌃`" },
      // Browser pane works on both desktop (native webviews) and web (CDP
      // screencast of the desktop app's tabs — see ScreencastPanel).
      { id: "browser", label: "Browser", icon: Globe, shortcut: "⇧⌘B" },
    ],
    [],
  );

  // Copy the workspace path to clipboard
  const handleCopyPath = useCallback(() => {
    if (!workspacePath) return;
    navigator.clipboard.writeText(workspacePath).catch(() => {});
  }, [workspacePath]);

  // Clicking the title-bar workspace name opens the same picker as ⌘K. The
  // picker state lives in SharedDockviewLayout (a sibling), so we signal it via
  // the window event it listens for. Stable identity so the title bar can
  // bail out of re-renders if ever memoized.
  const handleWorkspaceNameClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent("band:open-workspace-picker"));
  }, []);

  // Toggle panel visibility on/off (persisted in settings)
  const handleTogglePanelVisibility = useCallback(
    (panelId: string) => {
      const current =
        ((settings as unknown as Record<string, unknown>).hiddenPanels as string[] | undefined) ??
        [];
      const isHidden = current.includes(panelId);
      const next = isHidden ? current.filter((id) => id !== panelId) : [...current, panelId];
      updateSettings.mutate({
        ...settings,
        hiddenPanels: next,
      } as typeof settings);
      // If the panel is being shown, activate it
      if (isHidden) {
        // Dispatch after a tick so the layout has time to add the panel
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("band:activate-panel", { detail: { panelId } }));
        }, 100);
      }
    },
    [settings, updateSettings],
  );

  // ──────────────────────────────────────────────────────────────────────
  // Project-list sidebar (separate from the dockview). Collapsing/expanding
  // the sidebar Panel via its imperative handle hides/shows the list WITHOUT
  // unmounting the sibling Panel that holds <SharedDockviewLayout /> — so the
  // dockview (and every cached workspace's chat/terminal/browser + live PTYs)
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

  // ⌘B toggles the sidebar; ⌃0 / "Focus Projects" reveal it before focusing
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

  // Cancel a pending sidebar-width RAF on unmount so it can't fire (and write
  // localStorage) after the component is gone — matches the cleanup discipline
  // of the other effects in this file.
  useEffect(
    () => () => {
      if (sidebarWidthRafRef.current != null) cancelAnimationFrame(sidebarWidthRafRef.current);
    },
    [],
  );

  // Props for the nav cluster (sidebar toggle + back/forward) hosted in the
  // stationary overlay in the render below. The overflow actions always live in
  // DashboardShell's bottom action bar, so the cluster carries no menu of
  // its own.
  //
  // Memoized for a stable prop reference across the frequent AppShell
  // re-renders (route changes, workspace switches, sidebar toggles). Hooks
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

  // Single source for the macOS traffic-light gutter: compute it once here (one
  // `useIsFullscreen` subscription) and pass to both title-bar halves, rather
  // than each bar instantiating its own hook. The offset applies to whichever
  // bar sits at the window's left edge.
  const isFullscreen = useIsFullscreen();
  const titleBarOffset = isDesktop && !isFullscreen ? "pl-[80px]" : "pl-2";

  if (!useDesktopLayout) {
    return <Outlet />;
  }

  return (
    <ToolbarOverflowProvider>
      <div className="relative flex flex-col h-full w-full overflow-hidden bg-background text-foreground">
        {/* The nav cluster (sidebar toggle + back/forward) is hosted ONCE in
            this stationary overlay pinned over the title-bar row's left edge, floating above
            both title bars. Hosting it inside either bar means remounting it
            on every sidebar toggle inside an overflow-clipped, animating
            panel — the buttons visibly flickered mid-tween. Here the panels
            slide beneath it and it never moves or remounts. The container is
            pointer-events-none so the drag regions beneath stay draggable;
            NavControls re-enables pointer events on itself. */}
        <div
          className={`pointer-events-none absolute top-0 left-0 z-10 flex h-[38px] items-center ${titleBarOffset}`}
        >
          <NavControls {...navControlProps} />
        </div>
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
              {/* The whole sidebar column (its title-bar half + the project
                  list) is painted with the `--sidebar` surface so it reads as a
                  distinct panel from the workspace layout to its right. */}
              <div
                className="h-full flex flex-col overflow-hidden border-r border-border bg-sidebar"
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
            <Separator className="w-[3px] bg-transparent hover:bg-accent-foreground/20 active:bg-accent-foreground/30 transition-colors cursor-col-resize" />
            <Panel id="main" elementRef={mainElRef} minSize="20%">
              {/* Stays mounted across sidebar toggles — never unmount this
                  subtree or the dockview tears down all cached workspaces. */}
              <div className="h-full flex flex-col min-w-0 overflow-hidden">
                <WorkspaceTitleBar
                  workspaceName={activeWorkspaceId ?? undefined}
                  workspacePath={activeWorkspaceId ? workspacePath : undefined}
                  onCopyPath={activeWorkspaceId ? handleCopyPath : undefined}
                  onWorkspaceNameClick={activeWorkspaceId ? handleWorkspaceNameClick : undefined}
                  panelItems={activeWorkspaceId ? panelItems : undefined}
                  hiddenPanels={activeWorkspaceId ? hiddenPanels : undefined}
                  onTogglePanelVisibility={
                    activeWorkspaceId ? handleTogglePanelVisibility : undefined
                  }
                />
                {/* `relative` anchors SharedDockviewLayout's `absolute inset-0`
                    overlay to the area BELOW the title bar. */}
                <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
                  <Outlet />
                  <SharedDockviewLayout />
                  <BrowserHostBridge />
                </div>
              </div>
            </Panel>
          </Group>
        </div>
      </div>
    </ToolbarOverflowProvider>
  );
}

function RootLayout() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script to prevent theme flash */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script to prevent zoom layout flash */}
        <script dangerouslySetInnerHTML={{ __html: ZOOM_INIT_SCRIPT }} />
      </head>
      <body>
        <DashboardProvider adapter={adapter} capabilities={capabilities}>
          <ThemeSync />
          <ZoomSync />
          <ReloadSync />
          <TooltipProvider>
            <AppShell />
          </TooltipProvider>
        </DashboardProvider>
        <Scripts />
      </body>
    </html>
  );
}
