import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CodeBrowserView } from "../components/CodeBrowserView";

export const Route = createFileRoute("/workspace/$workspaceId/code/$")({
  component: CodeFile,
});

function CodeFile() {
  const { workspaceId, _splat } = Route.useParams();
  const navigate = useNavigate();

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

  return (
    <CodeBrowserView
      workspaceId={decodeURIComponent(workspaceId)}
      file={_splat || undefined}
      onSelectFile={handleSelectFile}
    />
  );
}
