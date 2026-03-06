import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/hooks/check")({
  server: {
    handlers: {
      GET: async () => {
        // Web app assumes hooks are handled by the desktop app
        // Return as "installed" to avoid showing the install banner
        return Response.json({ installed: true, other_hooks_exist: false });
      },
    },
  },
});
