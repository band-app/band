import { createFileRoute } from "@tanstack/react-router";
import { getOrCreateAgent } from "../../lib/agent-pool";
import { resolveWorkspace } from "../../lib/workspace";

export const Route = createFileRoute("/api/sessions/$workspaceId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);

        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path);

        if (!agent.supportedFeatures.sessionListing || !agent.listSessions) {
          return Response.json({ sessions: [], supported: false });
        }

        const sessions = await agent.listSessions(workspace.worktree.path);
        return Response.json({ sessions, supported: true });
      },
    },
  },
});
