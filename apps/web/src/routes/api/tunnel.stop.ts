import { createFileRoute } from "@tanstack/react-router";
import { stopTunnel } from "../../lib/tunnel";

export const Route = createFileRoute("/api/tunnel/stop")({
  server: {
    handlers: {
      POST: async () => {
        try {
          await stopTunnel();
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
