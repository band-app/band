import { createFileRoute } from "@tanstack/react-router";
import { checkPrereqs } from "../../lib/process-utils";

export const Route = createFileRoute("/api/prereqs/check")({
  server: {
    handlers: {
      GET: async () => {
        const prereqs = await checkPrereqs();
        return Response.json(prereqs);
      },
    },
  },
});
