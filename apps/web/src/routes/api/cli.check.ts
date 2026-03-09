import { createFileRoute } from "@tanstack/react-router";
import { checkCli } from "../../lib/cli";

export const Route = createFileRoute("/api/cli/check")({
  server: {
    handlers: {
      GET: async () => {
        const status = await checkCli();
        return Response.json({ status });
      },
    },
  },
});
