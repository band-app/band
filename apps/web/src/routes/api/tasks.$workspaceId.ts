import { createFileRoute } from "@tanstack/react-router";
import { getTask } from "../../lib/task-runner";

export const Route = createFileRoute("/api/tasks/$workspaceId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);
        const task = getTask(workspaceId);
        return Response.json({ task });
      },
    },
  },
});
