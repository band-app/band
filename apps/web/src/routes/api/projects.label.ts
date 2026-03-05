import { createFileRoute } from "@tanstack/react-router";
import { loadState, saveState } from "../../lib/state";

export const Route = createFileRoute("/api/projects/label")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { name: string; label: string | null };
        if (typeof body.name !== "string") {
          return new Response(JSON.stringify({ error: "name must be a string" }), {
            status: 400,
          });
        }

        const state = loadState();
        const project = state.projects.find((p) => p.name === body.name);
        if (!project) {
          return new Response(JSON.stringify({ error: "project not found" }), {
            status: 404,
          });
        }

        if (body.label === null || body.label === undefined) {
          delete project.label;
        } else {
          project.label = body.label;
        }
        saveState(state);

        return Response.json({ ok: true });
      },
    },
  },
});
