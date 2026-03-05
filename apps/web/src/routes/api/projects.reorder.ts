import { createFileRoute } from "@tanstack/react-router";
import { loadState, saveState } from "../../lib/state";

export const Route = createFileRoute("/api/projects/reorder")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { names: string[] };
        if (!Array.isArray(body.names)) {
          return new Response(JSON.stringify({ error: "names must be an array" }), {
            status: 400,
          });
        }

        const state = loadState();
        state.projects.sort((a, b) => {
          const ai = body.names.indexOf(a.name);
          const bi = body.names.indexOf(b.name);
          return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
        });
        saveState(state);

        return Response.json({ ok: true });
      },
    },
  },
});
