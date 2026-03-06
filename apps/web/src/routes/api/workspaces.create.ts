import { createFileRoute } from "@tanstack/react-router";
import { execFileSync } from "node:child_process";
import { loadState, worktreesDir } from "../../lib/state";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function gitCmd(): { command: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
  }
  return { command: "git", env };
}

export const Route = createFileRoute("/api/workspaces/create")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { project, branch, base } = (await request.json()) as {
          project: string;
          branch: string;
          base?: string;
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

        return Response.json({ ok: true });
      },
    },
  },
});
