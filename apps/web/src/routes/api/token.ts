import { createFileRoute } from "@tanstack/react-router";
import { getToken } from "../../lib/auth-token";

export const Route = createFileRoute("/api/token")({
  server: {
    handlers: {
      GET: async () => {
        const token = getToken();
        if (!token) {
          return Response.json({ error: "No token secret configured" }, { status: 404 });
        }
        return Response.json({ token });
      },
    },
  },
});
