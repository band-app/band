import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CodeBrowserView } from "../components/CodeBrowserView";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { useFindInFileContext } from "./workspace.$workspaceId";

export const Route = createFileRoute("/workspace/$workspaceId/code/$")({
  component: CodeFile,
});

// Mobile-only route. The parent `code` layout already returns `null` on
// desktop, so this guard is defensive — but it documents intent and keeps
// the route a clean no-op if a future change re-enables the desktop
// `<Outlet />`. See issue #467.
function CodeFile() {
  const { workspaceId, _splat } = Route.useParams();
  const navigate = useNavigate();
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  const { setFindInFile } = useFindInFileContext();

  const handleSelectFile = useCallback(
    (filePath: string | null) => {
      if (filePath) {
        navigate({
          to: "/workspace/$workspaceId/code/$",
          params: { workspaceId, _splat: filePath },
        });
      } else {
        navigate({
          to: "/workspace/$workspaceId/code",
          params: { workspaceId },
        });
      }
    },
    [navigate, workspaceId],
  );

  if (useDesktopLayout) return null;

  return (
    <CodeBrowserView
      workspaceId={decodeURIComponent(workspaceId)}
      file={_splat || undefined}
      onSelectFile={handleSelectFile}
      onFindInFile={setFindInFile}
    />
  );
}
