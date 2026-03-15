import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import { WebCapabilities, WebDashboardAdapter } from "@band/dashboard-core/adapters/web";
import { TooltipProvider } from "@band/ui";
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ToolbarButtons } from "../components/ToolbarButtons";
import { useIsDesktop } from "../hooks/useIsDesktop";
import "../styles/globals.css";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const adapter = inTauri ? new HybridDashboardAdapter() : new WebDashboardAdapter();
const capabilities = inTauri ? new NativeShellCapabilities() : new WebCapabilities();

export { adapter, capabilities, inTauri };

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
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

function AppShell() {
  const isDesktop = useIsDesktop() && !inTauri;
  const router = useRouter();

  // Wire up client-side navigation for WebCapabilities
  useEffect(() => {
    if (capabilities.navigate) return;
    (capabilities as import("@band/dashboard-core/adapters/web").WebCapabilities).navigate = (
      href: string,
    ) => {
      router.navigate({ to: href });
    };
  }, [router]);

  if (!isDesktop) {
    return <Outlet />;
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <div className="w-80 shrink-0 border-r border-white/20 overflow-hidden">
        <DashboardShell toolbarExtra={<ToolbarButtons />} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

function RootLayout() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <DashboardProvider adapter={adapter} capabilities={capabilities}>
          <TooltipProvider>
            <AppShell />
          </TooltipProvider>
        </DashboardProvider>
        <Scripts />
      </body>
    </html>
  );
}
