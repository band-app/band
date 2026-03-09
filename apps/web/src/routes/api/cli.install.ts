import { createFileRoute } from "@tanstack/react-router";
import { installCli } from "../../lib/cli";

export const Route = createFileRoute("/api/cli/install")({
  server: {
    handlers: {
      POST: async () => {
        try {
          await installCli();
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
