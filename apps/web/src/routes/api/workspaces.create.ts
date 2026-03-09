import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { gitCmd } from "../../lib/git";
import { loadState, saveState, worktreesDir } from "../../lib/state";
import { submitTask } from "../../lib/task-runner";

export const Route = createFileRoute("/api/workspaces/create")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { project, branch, base, prompt } = (await request.json()) as {
          project: string;
          branch: string;
          base?: string;
          prompt?: string;
        };

        const state = loadState();
        const proj = state.projects.find((p) => p.name === project);
        if (!proj) {
          return Response.json({ error: `Project "${project}" not found` }, { status: 404 });
        }

        // Already tracked — nothing to do
        if (proj.worktrees.some((wt) => wt.branch === branch)) {
          return Response.json({ ok: true });
        }

        const wtDir = worktreesDir();
        const worktreePath = join(wtDir, project, branch);
        mkdirSync(join(wtDir, project), { recursive: true });

        const { command, env } = gitCmd();
        const args = ["worktree", "add"];
        if (base) {
          args.push("-b", branch, worktreePath, base);
        } else {
          args.push("-b", branch, worktreePath);
        }

        try {
          execFileSync(command, args, { cwd: proj.path, env, encoding: "utf-8" });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }

        // Persist workspace to state so Tauri's workspace_open can find it
        proj.worktrees.push({ branch, path: worktreePath, head: null });
        saveState(state);

        const workspaceId = `${project}-${branch}`;

        if (prompt) {
          submitTask(workspaceId, prompt);
        }

        return Response.json({ ok: true });
      },
    },
  },
});
