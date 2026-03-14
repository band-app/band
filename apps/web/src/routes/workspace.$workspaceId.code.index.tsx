import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CodeBrowserView } from "../components/CodeBrowserView";

export const Route = createFileRoute("/workspace/$workspaceId/code/")({
  component: CodeIndex,
});

function CodeIndex() {
  const { workspaceId } = Route.useParams();
  const navigate = useNavigate();

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

  return (
    <CodeBrowserView
      workspaceId={decodeURIComponent(workspaceId)}
      onSelectFile={handleSelectFile}
    />
  );
}
