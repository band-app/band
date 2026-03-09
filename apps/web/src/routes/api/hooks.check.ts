import { createFileRoute } from "@tanstack/react-router";
import { checkHooks } from "../../lib/hooks";

export const Route = createFileRoute("/api/hooks/check")({
  server: {
    handlers: {
      GET: async () => {
        const status = await checkHooks();
        return Response.json(status);
      },
    },
  },
});
