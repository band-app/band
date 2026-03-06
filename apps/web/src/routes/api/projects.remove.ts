import { createFileRoute } from "@tanstack/react-router";
import { loadState, saveState } from "../../lib/state";

export const Route = createFileRoute("/api/projects/remove")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { name } = (await request.json()) as { name: string };
        const state = loadState();
        state.projects = state.projects.filter((p) => p.name !== name);
        saveState(state);
        return Response.json({ ok: true });
      },
    },
  },
});
