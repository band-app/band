import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { resolveWorkspace } from "../../lib/workspace";

export const Route = createFileRoute("/api/workspace/$workspaceId/files")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);
        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const url = new URL(request.url);
        const relativePath = url.searchParams.get("path") || "";
        const root = workspace.worktree.path;
        const target = resolve(join(root, relativePath));

        // Path traversal protection
        if (!target.startsWith(root)) {
          return Response.json({ error: "Invalid path" }, { status: 400 });
        }

        try {
          const dirents = await readdir(target, { withFileTypes: true });
          const entries = dirents
            .filter((d) => !d.name.startsWith("."))
            .map((d) => ({
              name: d.name,
              type: d.isDirectory() ? ("directory" as const) : ("file" as const),
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          return Response.json({ entries, path: relativePath });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed to list directory" },
            { status: 500 },
          );
        }
      },
    },
  },
});
