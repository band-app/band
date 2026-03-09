import { createFileRoute } from "@tanstack/react-router";
import { checkTunnelAuth } from "../../lib/tunnel";

export const Route = createFileRoute("/api/tunnel/auth-check")({
  server: {
    handlers: {
      GET: async () => {
        const authenticated = await checkTunnelAuth();
        return Response.json({ authenticated });
      },
    },
  },
});
