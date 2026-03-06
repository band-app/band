import { createFileRoute } from "@tanstack/react-router";
import { execFileSync } from "node:child_process";
import { loadState, saveState, worktreesDir } from "../../lib/state";
import { listWorktrees } from "../../lib/git";
import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";

export const Route = createFileRoute("/api/projects/add")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { path, label } = (await request.json()) as { path: string; label?: string };
        const state = loadState();

        // Derive project name from path
        const name = basename(path);

        // Check if already registered
        if (state.projects.some((p) => p.name === name)) {
          return Response.json({ error: `Project "${name}" already registered` }, { status: 400 });
        }

        // Detect default branch
        let defaultBranch = "main";
        try {
          const env = { ...process.env };
          if (env.PATH) {
            env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
          }
          const output = execFileSync(
            "git",
            ["symbolic-ref", "--short", "HEAD"],
            { cwd: path, env, encoding: "utf-8" },
          ).trim();
          if (output) defaultBranch = output;
        } catch {
          // Fall back to "main"
        }

        // List worktrees
        let worktrees: { branch: string; path: string; head?: string }[] = [];
        try {
          const gitWorktrees = await listWorktrees(path);
          worktrees = gitWorktrees
            .filter((wt) => !wt.isBare)
            .map((wt) => ({ branch: wt.branch, path: wt.path, head: wt.head }));
        } catch {
          // No worktrees
        }

        const project = {
          name,
          path,
          defaultBranch,
          worktrees,
          label: label ?? undefined,
        };

        state.projects.push(project);
        saveState(state);

        return Response.json(project);
      },
    },
  },
});
