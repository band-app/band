import { createFileRoute } from "@tanstack/react-router";
import { CodeBrowserView } from "../components/CodeBrowserView";

export const Route = createFileRoute("/workspace/$workspaceId/code/$")({
  component: CodeFile,
});

function CodeFile() {
  const { workspaceId, _splat } = Route.useParams();
  return (
    <CodeBrowserView workspaceId={decodeURIComponent(workspaceId)} file={_splat || undefined} />
  );
}
