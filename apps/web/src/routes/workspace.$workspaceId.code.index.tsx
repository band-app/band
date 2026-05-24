import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CodeBrowserView } from "../components/CodeBrowserView";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { useFindInFileContext } from "./workspace.$workspaceId";

export const Route = createFileRoute("/workspace/$workspaceId/code/")({
  component: CodeIndex,
});

// Mobile-only route — see the sibling `code.$` route and issue #467 for the
// full rationale. Desktop renders the Files panel via the shared dockview,
// so this route has nothing to add.
function CodeIndex() {
  const { workspaceId } = Route.useParams();
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
      }
    },
    [navigate, workspaceId],
  );

  if (useDesktopLayout) return null;

  return (
    <CodeBrowserView
      workspaceId={decodeURIComponent(workspaceId)}
      onSelectFile={handleSelectFile}
      onFindInFile={setFindInFile}
    />
  );
}
