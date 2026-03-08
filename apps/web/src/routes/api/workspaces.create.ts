import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { gitCmd } from "../../lib/git";
import { bandHome, loadState, worktreesDir } from "../../lib/state";

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

        if (prompt) {
          const workspaceId = `${project}-${branch}`;
          const promptFile = join(bandHome(), "workspace-prompts", `${workspaceId}.json`);
          mkdirSync(dirname(promptFile), { recursive: true });
          writeFileSync(promptFile, JSON.stringify({ prompt, didRun: false }, null, 2), "utf-8");
        }

        return Response.json({ ok: true });
      },
    },
  },
});
