import { createFileRoute } from "@tanstack/react-router";
import { readFileSync, writeFileSync } from "node:fs";
import { settingsFile, ensureDirs, type Settings } from "../../lib/state";

export const Route = createFileRoute("/api/settings")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const data = readFileSync(settingsFile(), "utf-8");
          return Response.json(JSON.parse(data) as Settings);
        } catch {
          return Response.json({ worktreesDir: null });
        }
      },
      PUT: async ({ request }) => {
        const settings = (await request.json()) as Settings;
        ensureDirs();
        writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf-8");
        return Response.json({ ok: true });
      },
    },
  },
});
