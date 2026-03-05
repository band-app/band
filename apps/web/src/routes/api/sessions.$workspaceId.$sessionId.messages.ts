import { createFileRoute } from "@tanstack/react-router";
import { getOrCreateAgent } from "../../lib/agent-pool";
import { resolveWorkspace } from "../../lib/workspace";

export const Route = createFileRoute("/api/sessions/$workspaceId/$sessionId/messages")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);
        const sessionId = decodeURIComponent(params.sessionId);

        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path);

        if (!agent.supportedFeatures.sessionListing || !agent.getSessionMessages) {
          return Response.json({ error: "Session listing not supported" }, { status: 400 });
        }

        const url = new URL(request.url);
        const limit = Number(url.searchParams.get("limit")) || 50;
        const offset = Number(url.searchParams.get("offset")) || 0;

        const messages = await agent.getSessionMessages(sessionId, workspace.worktree.path, {
          limit,
          offset,
        });

        return Response.json({ messages });
      },
    },
  },
});
