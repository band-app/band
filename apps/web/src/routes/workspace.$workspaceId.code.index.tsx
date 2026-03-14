import { createFileRoute } from "@tanstack/react-router";
import { CodeBrowserView } from "../components/CodeBrowserView";

export const Route = createFileRoute("/workspace/$workspaceId/code/")({
  component: CodeIndex,
});

function CodeIndex() {
  const { workspaceId } = Route.useParams();
  return <CodeBrowserView workspaceId={decodeURIComponent(workspaceId)} />;
}
