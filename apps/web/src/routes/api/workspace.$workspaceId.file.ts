import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { resolveWorkspace } from "../../lib/workspace";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".sh": "bash",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".diff": "diff",
};

export const Route = createFileRoute("/api/workspace/$workspaceId/file")({
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
        if (!relativePath) {
          return Response.json({ error: "Path is required" }, { status: 400 });
        }

        const root = workspace.worktree.path;
        const target = resolve(join(root, relativePath));

        // Path traversal protection
        if (!target.startsWith(root)) {
          return Response.json({ error: "Invalid path" }, { status: 400 });
        }

        try {
          const fileStat = await stat(target);
          const size = fileStat.size;

          if (size > MAX_FILE_SIZE) {
            return Response.json({ tooLarge: true, size });
          }

          const buffer = await readFile(target);

          // Binary detection: check for null bytes in first 8KB
          const sample = buffer.subarray(0, 8192);
          if (sample.includes(0)) {
            return Response.json({ binary: true, size });
          }

          const ext = extname(target).toLowerCase();
          const language = LANG_MAP[ext];

          return Response.json({
            content: buffer.toString("utf-8"),
            size,
            language,
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed to read file" },
            { status: 500 },
          );
        }
      },
    },
  },
});
