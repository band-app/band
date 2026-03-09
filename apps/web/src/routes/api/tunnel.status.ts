import { createFileRoute } from "@tanstack/react-router";
import { getTunnelStatus } from "../../lib/tunnel";

export const Route = createFileRoute("/api/tunnel/status")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(getTunnelStatus());
      },
    },
  },
});
