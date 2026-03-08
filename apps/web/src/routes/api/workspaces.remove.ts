import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { gitCmd } from "../../lib/git";
import { bandHome, loadState } from "../../lib/state";

export const Route = createFileRoute("/api/workspaces/remove")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { project, branch } = (await request.json()) as {
          project: string;
          branch: string;
        };

        const state = loadState();
        const proj = state.projects.find((p) => p.name === project);
        if (!proj) {
          return Response.json({ error: `Project "${project}" not found` }, { status: 404 });
        }

        const { command, env } = gitCmd();

        try {
          // First find the worktree path
          const output = execFileSync(command, ["worktree", "list", "--porcelain"], {
            cwd: proj.path,
            env,
            encoding: "utf-8",
          });

          let currentPath = "";
          let currentBranch = "";
          for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
              currentPath = line.slice("worktree ".length);
            } else if (line.startsWith("branch ")) {
              const branchRef = line.slice("branch ".length);
              currentBranch = branchRef.startsWith("refs/heads/")
                ? branchRef.slice("refs/heads/".length)
                : branchRef;
            } else if (line === "" && currentPath) {
              if (currentBranch === branch) {
                // Remove the worktree
                execFileSync(command, ["worktree", "remove", "--force", currentPath], {
                  cwd: proj.path,
                  env,
                  encoding: "utf-8",
                });
                // Delete the branch
                try {
                  execFileSync(command, ["branch", "-D", branch], {
                    cwd: proj.path,
                    env,
                    encoding: "utf-8",
                  });
                } catch {
                  // Branch may already be deleted
                }
                // Clean up prompt file
                const workspaceId = `${project}-${branch}`;
                try {
                  unlinkSync(join(bandHome(), "workspace-prompts", `${workspaceId}.json`));
                } catch {
                  // Prompt file may not exist
                }
                return Response.json({ ok: true });
              }
              currentPath = "";
              currentBranch = "";
            }
          }

          return Response.json({ error: `Workspace "${branch}" not found` }, { status: 404 });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
