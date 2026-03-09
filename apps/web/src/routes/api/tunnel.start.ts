import { createFileRoute } from "@tanstack/react-router";
import { loadSettings } from "../../lib/state";
import { startTunnel } from "../../lib/tunnel";

export const Route = createFileRoute("/api/tunnel/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            subdomain?: string;
            skipSubdomain?: boolean;
          };
          const settings = loadSettings();
          const port = parseInt(process.env.PORT || "3456", 10);
          const subdomain = body.subdomain || (settings as Record<string, unknown>).tunnelSubdomain;

          await startTunnel({
            port,
            subdomain: subdomain as string | undefined,
            skipSubdomain: body.skipSubdomain,
          });
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
