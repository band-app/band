import { createFileRoute } from "@tanstack/react-router";
import { listWorktrees } from "../../lib/git";
import { loadCurrentStatuses, loadState } from "../../lib/state";

export const Route = createFileRoute("/api/projects")({
  server: {
    handlers: {
      GET: async () => {
        const state = loadState();
        const statuses = loadCurrentStatuses();
        const statusMap = new Map(statuses.map((s) => [s.workspaceId, s]));

        const projects = await Promise.all(
          state.projects.map(async (project) => {
            let worktrees = project.worktrees;
            try {
              const gitWorktrees = await listWorktrees(project.path);
              worktrees = gitWorktrees
                .filter((wt) => !wt.isBare)
                .map((wt) => ({
                  branch: wt.branch,
                  path: wt.path,
                  head: wt.head,
                }));
            } catch {
              // Fall back to state.json worktrees
            }

            return {
              name: project.name,
              path: project.path,
              defaultBranch: project.defaultBranch,
              worktrees: worktrees.map((wt) => {
                const workspaceId = `${project.name}-${wt.branch}`;
                const status = statusMap.get(workspaceId);
                return {
                  ...wt,
                  workspaceId,
                  agent: status?.agent ?? null,
                };
              }),
            };
          }),
        );

        return Response.json({ projects });
      },
    },
  },
});
