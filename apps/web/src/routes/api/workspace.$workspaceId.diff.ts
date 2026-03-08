import { createFileRoute } from "@tanstack/react-router";
import { execGit } from "../../lib/git";
import { resolveWorkspace } from "../../lib/workspace";

export const Route = createFileRoute("/api/workspace/$workspaceId/diff")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);
        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const cwd = workspace.worktree.path;
        const defaultBranch = workspace.project.defaultBranch;

        try {
          const headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();

          let mergeBase: string;
          try {
            mergeBase = (await execGit(["merge-base", defaultBranch, "HEAD"], cwd)).trim();
          } catch {
            // If merge-base fails (e.g. no common ancestor), diff against empty tree
            mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
          }

          // Diff merge-base against working tree (includes uncommitted changes)
          const diff = await execGit(["diff", mergeBase], cwd);

          const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
          const statLines = statOutput.trim().split("\n");
          const summaryLine = statLines[statLines.length - 1] || "";

          let filesChanged = 0;
          let insertions = 0;
          let deletions = 0;

          const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
          const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
          const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

          if (filesMatch) filesChanged = Number.parseInt(filesMatch[1], 10);
          if (insertMatch) insertions = Number.parseInt(insertMatch[1], 10);
          if (deleteMatch) deletions = Number.parseInt(deleteMatch[1], 10);

          return Response.json({
            diff,
            stats: { filesChanged, insertions, deletions },
            baseBranch: defaultBranch,
            headBranch,
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed to compute diff" },
            { status: 500 },
          );
        }
      },
    },
  },
});
