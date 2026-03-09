import { execFile } from "node:child_process";
import { createFileRoute } from "@tanstack/react-router";
import { shellPath } from "../../lib/process-utils";

export const Route = createFileRoute("/api/prereqs/install-node")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const resolvedPath = await shellPath();
          await new Promise<void>((resolve, reject) => {
            execFile(
              "brew",
              ["install", "node"],
              { env: { ...process.env, PATH: resolvedPath }, timeout: 120_000 },
              (err, _stdout, stderr) => {
                if (err) {
                  reject(new Error(stderr || err.message));
                  return;
                }
                resolve();
              },
            );
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
