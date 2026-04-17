import { DashboardProvider, DashboardShell, useSettingsQuery } from "@band-app/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band-app/dashboard-core/adapters/hybrid";
import { WebCapabilities, WebDashboardAdapter } from "@band-app/dashboard-core/adapters/web";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { DockviewInstanceManager } from "../components/DockviewInstanceManager";
import { TauriTitleBar } from "../components/TauriTitleBar";
import { ToolbarButtons } from "../components/ToolbarButtons";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useNavigationHistory } from "../hooks/useNavigationHistory";
import { useZoom } from "../hooks/useZoom";
import { isTauri } from "../lib/is-tauri";
import {
  loadSidebarWidth,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  saveSidebarWidth,
} from "../lib/sidebar-width";
import { applyZoomLevel, loadZoomLevel, zoomIn, zoomOut, zoomReset } from "../lib/zoom";
import "../styles/globals.css";

const adapter = isTauri ? new HybridDashboardAdapter() : new WebDashboardAdapter();
const capabilities = isTauri ? new NativeShellCapabilities() : new WebCapabilities();

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
      { name: "theme-color", content: "#181818" },
    ],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
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
 *  Reads a cached zoom value from localStorage (written by ZoomSync / zoom.ts). */
const ZOOM_INIT_SCRIPT = `(function(){try{var z=localStorage.getItem("band:zoom-level");if(z){var n=parseFloat(z);if(!isNaN(n)&&n>=0.5&&n<=2)document.documentElement.style.zoom=String(n)}}catch(e){}})()`;

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
 *  Runs for ALL pages (including standalone Tauri windows like tasks/cronjobs).
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

/** Syncs the zoom level across windows and exposes a global function
 *  for the Tauri menu handler to call via window.eval(). */
function ZoomSync() {
  useEffect(() => {
    // Safety net: apply the persisted zoom level on mount.
    // The blocking script should have already set it, but this
    // handles edge cases (e.g., new secondary window created later).
    applyZoomLevel(loadZoomLevel());

    // Expose a global function that the Rust menu event handler can call
    // via webview.eval("if(window.__bandZoom)window.__bandZoom('in')").
    (window as unknown as Record<string, unknown>).__bandZoom = (action: string) => {
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
  // apply the change immediately to this window's DOM.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== "band:zoom-level" || !e.newValue) return;
      const level = Number.parseFloat(e.newValue);
      if (!Number.isNaN(level) && level >= 0.5 && level <= 2) {
        document.documentElement.style.zoom = String(level);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return null;
}

const STANDALONE_ROUTES = ["/tasks", "/cronjobs", "/settings"];

/**
 * Syncs the appMode setting into the HybridDashboardAdapter and
 * NativeShellCapabilities so they behave correctly for the active mode.
 */
function ModeSync() {
  const { settings } = useSettingsQuery();
  const appMode = settings.appMode ?? "side-panel";

  useEffect(() => {
    if (isTauri) {
      (adapter as HybridDashboardAdapter).setAppMode(appMode);
      (capabilities as NativeShellCapabilities).setAppMode(appMode);
    }
  }, [appMode]);

  return null;
}

function AppShell() {
  const { settings } = useSettingsQuery();
  const appMode = settings.appMode ?? "side-panel";
  // Show desktop split layout when:
  // - In a regular browser on a wide screen, OR
  // - In Tauri with "full-editor" mode
  const isWideScreen = useIsDesktop();
  const isDesktop = (isWideScreen && !isTauri) || (isTauri && appMode === "full-editor");
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isStandalone = STANDALONE_ROUTES.includes(pathname);

  // Wire up client-side navigation for WebCapabilities
  useEffect(() => {
    if (capabilities.navigate) return;
    (capabilities as import("@band-app/dashboard-core/adapters/web").WebCapabilities).navigate = (
      href: string,
    ) => {
      router.navigate({ to: href });
    };
  }, [router]);

  // Cmd+[ / Cmd+] — back/forward through workspace history
  const routerNavigate = useCallback((href: string) => router.navigate({ to: href }), [router]);
  useNavigationHistory(routerNavigate, capabilities);

  // Cmd+= / Cmd+- / Cmd+0 — zoom in/out/reset (browser mode only;
  // in Tauri the View menu accelerators handle these keys)
  useZoom();

  // Resizable sidebar: load persisted width and skip the first layout callback
  // (react-resizable-panels fires it on mount with a computed layout that may
  // differ from the default before the container has its final CSS dimensions).
  const savedWidth = loadSidebarWidth();
  const defaultLayout = savedWidth ? { sidebar: savedWidth, main: 100 - savedWidth } : undefined;
  const skipFirstLayoutCallback = useRef(true);
  const handleSidebarResize = useCallback((layout: Record<string, number>) => {
    if (skipFirstLayoutCallback.current) {
      skipFirstLayoutCallback.current = false;
      return;
    }
    if (layout.sidebar != null) {
      saveSidebarWidth(layout.sidebar);
    }
  }, []);

  // Collapsible sidebar (Tauri title bar toggle)
  const sidebarPanelRef = usePanelRef();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [sidebarPanelRef]);
  const handleSidebarCollapse = useCallback(() => setSidebarCollapsed(true), []);
  const handleSidebarExpand = useCallback(() => setSidebarCollapsed(false), []);

  if (!isDesktop || isStandalone) {
    return <Outlet />;
  }

  const isTauriFullEditor = isTauri && appMode === "full-editor";

  return (
    <div className="flex flex-col h-dvh w-full overflow-hidden bg-background text-foreground">
      {isTauriFullEditor && (
        <TauriTitleBar onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed} />
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={handleSidebarResize}
        >
          <Panel
            id="sidebar"
            defaultSize={SIDEBAR_MIN_SIZE}
            minSize={SIDEBAR_MIN_SIZE}
            maxSize={SIDEBAR_MAX_SIZE}
            collapsible
            collapsedSize="0%"
            panelRef={sidebarPanelRef}
            onResize={(size) => {
              if (size.asPercentage === 0) handleSidebarCollapse();
              else handleSidebarExpand();
            }}
          >
            <div className="h-full border-r border-border overflow-hidden">
              <DashboardShell toolbarExtra={<ToolbarButtons />} hideTitleBar={isTauriFullEditor} />
            </div>
          </Panel>
          <Separator className="w-[3px] bg-transparent hover:bg-accent-foreground/20 active:bg-accent-foreground/30 transition-colors cursor-col-resize" />
          <Panel id="main" minSize="20%">
            <div className="h-full min-w-0 overflow-hidden relative">
              <Outlet />
              <DockviewInstanceManager />
            </div>
          </Panel>
        </Group>
      </div>
    </div>
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
          <ModeSync />
          <TooltipProvider>
            <AppShell />
          </TooltipProvider>
        </DashboardProvider>
        <Scripts />
      </body>
    </html>
  );
}
