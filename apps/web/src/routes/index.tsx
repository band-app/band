import { createFileRoute } from "@tanstack/react-router";
import { DashboardView } from "../components/DashboardView";
import { DockviewWorkspaceLayout } from "../components/DockviewWorkspaceLayout";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const isWideScreen = useIsDesktop();
  // Desktop split layout is active inside the desktop shell or in a wide browser window.
  const useDesktopLayout = isWideScreen || isDesktop;

  // Desktop: render the SAME dockview shell as the workspace route, just with
  // no active workspace. The Projects panel (workspace-agnostic — it's the
  // global project list) renders in the left edge group. The center panels
  // (Chat / Changes / Files / Terminal / Browser) all short-circuit to null
  // when params.workspaceId is empty, so the center groups exist
  // structurally (matching the workspace layout) but render no content
  // until the user picks a project. Workspace-id "" gates saveLayout via
  // isActiveRef.current = useWsActive("") = false, so layout edits made
  // on this route don't pollute the shared band:dockview-layout-v6 key.
  if (useDesktopLayout) {
    return <DockviewWorkspaceLayout workspaceId="" />;
  }

  // Mobile / narrow browser: full-screen dashboard shell
  return (
    <div className="h-dvh pb-4 standalone:pb-[env(safe-area-inset-bottom)]">
      <DashboardView />
    </div>
  );
}
