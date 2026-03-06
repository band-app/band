import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/workspaces/open")({
  server: {
    handlers: {
      POST: async () => {
        // Web app doesn't have a concept of "opening" a workspace in an IDE
        // This is a no-op endpoint for compatibility with the adapter interface
        return Response.json({ ok: true });
      },
    },
  },
});
