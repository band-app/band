import { createFileRoute } from "@tanstack/react-router";
import { abortTask } from "../../lib/task-runner";

export const Route = createFileRoute("/api/tasks/$workspaceId/abort")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);
        const aborted = abortTask(workspaceId);
        if (!aborted) {
          return Response.json({ error: "No running task found" }, { status: 404 });
        }
        return Response.json({ aborted: true });
      },
    },
  },
});
