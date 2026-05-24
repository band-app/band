import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { DiffView } from "@/dashboard";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { useDiffStatsContext, useFindInFileContext } from "./workspace.$workspaceId";

export const Route = createFileRoute("/workspace/$workspaceId/changes")({
  component: ChangesTab,
});

// Mobile-only route. On desktop, the shared dockview (mounted at AppShell)
// already renders the Changes panel, so the URL `/workspace/$id/changes`
// resolves to nothing visible (the parent's `DesktopWorkspaceLayout` doesn't
// render an `<Outlet />`). The explicit `null` early-return here documents
// that intent and keeps this component a no-op even if a future change
// reintroduces a desktop `<Outlet />`. See issue #467.
function ChangesTab() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const navigate = useNavigate();
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  const { setDiffStats } = useDiffStatsContext();
  const { setFindInFile } = useFindInFileContext();

  const handleOpenFile = useCallback(
    (filename: string) => {
      navigate({
        to: "/workspace/$workspaceId/code/$",
        params: { workspaceId, _splat: filename },
      });
    },
    [workspaceId, navigate],
  );

  if (useDesktopLayout) return null;

  return (
    <DiffView
      workspaceId={decoded}
      active
      onStatsChange={setDiffStats}
      onOpenFile={handleOpenFile}
      onFindInFile={setFindInFile}
    />
  );
}
