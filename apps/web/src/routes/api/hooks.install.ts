import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/hooks/install")({
  server: {
    handlers: {
      POST: async () => {
        // Web app doesn't handle hook installation
        return Response.json({ ok: true });
      },
    },
  },
});
