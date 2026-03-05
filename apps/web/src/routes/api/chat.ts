import { createFileRoute } from "@tanstack/react-router";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getOrCreateAgent } from "../../lib/agent-pool";
import { loadState } from "../../lib/state";
import { writeAgentStream } from "../../lib/stream-writer";

function resolveWorkspace(workspaceId: string) {
  const state = loadState();

  for (const project of state.projects) {
    const prefix = `${project.name}-`;
    if (workspaceId.startsWith(prefix)) {
      const branch = workspaceId.slice(prefix.length);
      for (const wt of project.worktrees) {
        if (wt.branch === branch) {
          return { project, worktree: wt };
        }
      }
    }
  }
  return null;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const { messages, sessionId, workspaceId } = body as {
          messages?: Array<{
            parts?: Array<{ type: string; text?: string }>;
            content?: string;
          }>;
          sessionId?: string;
          workspaceId?: string;
        };

        if (!workspaceId) {
          return Response.json({ error: "workspaceId required" }, { status: 400 });
        }

        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path);

        const lastMessage = messages?.[messages.length - 1];
        const userText =
          lastMessage?.parts?.find((p) => p.type === "text")?.text ?? lastMessage?.content ?? "";

        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            await writeAgentStream(agent, userText, sessionId, writer);
          },
        });

        return createUIMessageStreamResponse({ stream });
      },
    },
  },
});
