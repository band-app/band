import { createFileRoute } from "@tanstack/react-router";
import { GitGraphView } from "../components/GitGraphView";

export const Route = createFileRoute("/workspace/$workspaceId/graph")({
  component: WorkspaceGraph,
});

function WorkspaceGraph() {
  const { workspaceId } = Route.useParams();
  return <GitGraphView workspaceId={decodeURIComponent(workspaceId)} />;
}
