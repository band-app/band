import { createFileRoute } from "@tanstack/react-router";
import { DashboardView } from "../components/DashboardView";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const isWideScreen = useIsDesktop();
  // Desktop split layout is active inside the desktop shell or in a wide
  // browser window.
  const useDesktopLayout = isWideScreen || isDesktop;

  // Desktop: the SharedDockviewLayout mounted in __root.tsx already covers
  // this route. Each per-workspace panel host renders its NoWorkspaceMessage
  // empty state because the URL has no $workspaceId. There is nothing else
  // to render here — the AppShell's <Outlet /> sits BEHIND
  // <SharedDockviewLayout />, so anything we return would be hidden.
  if (useDesktopLayout) {
    return null;
  }

  // Mobile / narrow browser: full-screen dashboard shell
  return (
    <div className="h-dvh pb-4 standalone:pb-[env(safe-area-inset-bottom)]">
      <DashboardView />
    </div>
  );
}
