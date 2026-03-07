import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/workspaces/run-script")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { path, scriptType } = (await request.json()) as {
          path: string;
          scriptType: string;
        };

        const scriptPath = join(path, ".band", scriptType);
        if (!existsSync(scriptPath)) {
          return Response.json({ error: `Script "${scriptType}" not found` }, { status: 404 });
        }

        return new Promise<Response>((resolve) => {
          execFile("bash", [scriptPath], { cwd: path }, (err) => {
            if (err) {
              resolve(Response.json({ error: err.message }, { status: 500 }));
            } else {
              resolve(Response.json({ ok: true }));
            }
          });
        });
      },
    },
  },
});
