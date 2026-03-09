import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { checkCli, installCli } from "../lib/cli";
import { execGit, gitCmd, listWorktrees } from "../lib/git";
import { checkHooks, installHooks } from "../lib/hooks";
import {
  bandHome,
  ensureDirs,
  loadCurrentStatuses,
  loadSettings,
  loadState,
  saveState,
  settingsFile,
  worktreesDir,
} from "../lib/state";
import { submitTask } from "../lib/task-runner";
import { resolveWorkspace } from "../lib/workspace";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create();

const publicProcedure = t.procedure;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectsRouter = t.router({
  list: publicProcedure.query(async () => {
    const state = loadState();
    const settings = loadSettings();
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
          label: project.label,
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

    return { projects, labels: settings.labels ?? [] };
  }),

  add: publicProcedure
    .input(z.object({ path: z.string(), label: z.string().optional() }))
    .mutation(async ({ input }) => {
      const state = loadState();
      const name = basename(input.path);

      if (state.projects.some((p) => p.name === name)) {
        throw new Error(`Project "${name}" already registered`);
      }

      let defaultBranch = "main";
      try {
        const env = { ...process.env };
        if (env.PATH) {
          env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
        }
        const output = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: input.path,
          env,
          encoding: "utf-8",
        }).trim();
        if (output) defaultBranch = output;
      } catch {
        // Fall back to "main"
      }

      let worktrees: { branch: string; path: string; head?: string }[] = [];
      try {
        const gitWorktrees = await listWorktrees(input.path);
        worktrees = gitWorktrees
          .filter((wt) => !wt.isBare)
          .map((wt) => ({ branch: wt.branch, path: wt.path, head: wt.head }));
      } catch {
        // No worktrees
      }

      const project = {
        name,
        path: input.path,
        defaultBranch,
        worktrees,
        label: input.label ?? undefined,
      };

      state.projects.push(project);
      saveState(state);

      return project;
    }),

  remove: publicProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
    const state = loadState();
    state.projects = state.projects.filter((p) => p.name !== input.name);
    saveState(state);
    return { ok: true };
  }),

  reorder: publicProcedure.input(z.object({ names: z.array(z.string()) })).mutation(({ input }) => {
    const state = loadState();
    state.projects.sort((a, b) => {
      const ai = input.names.indexOf(a.name);
      const bi = input.names.indexOf(b.name);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });
    saveState(state);
    return { ok: true };
  }),

  updateLabel: publicProcedure
    .input(z.object({ name: z.string(), label: z.string().nullable() }))
    .mutation(({ input }) => {
      const state = loadState();
      const project = state.projects.find((p) => p.name === input.name);
      if (!project) {
        throw new Error("Project not found");
      }

      if (input.label === null || input.label === undefined) {
        delete project.label;
      } else {
        project.label = input.label;
      }
      saveState(state);
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

const workspacesRouter = t.router({
  create: publicProcedure
    .input(
      z.object({
        project: z.string(),
        branch: z.string(),
        base: z.string().optional(),
        prompt: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const state = loadState();
      const proj = state.projects.find((p) => p.name === input.project);
      if (!proj) {
        throw new Error(`Project "${input.project}" not found`);
      }

      if (proj.worktrees.some((wt) => wt.branch === input.branch)) {
        return { ok: true };
      }

      const wtDir = worktreesDir();
      const worktreePath = join(wtDir, input.project, input.branch);
      mkdirSync(join(wtDir, input.project), { recursive: true });

      const { command, env } = gitCmd();
      const args = ["worktree", "add"];
      if (input.base) {
        args.push("-b", input.branch, worktreePath, input.base);
      } else {
        args.push("-b", input.branch, worktreePath);
      }

      try {
        execFileSync(command, args, { cwd: proj.path, env, encoding: "utf-8" });
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }

      proj.worktrees.push({ branch: input.branch, path: worktreePath });
      saveState(state);

      if (input.prompt) {
        const workspaceId = `${input.project}-${input.branch}`;
        submitTask(workspaceId, input.prompt);
      }

      return { ok: true };
    }),

  remove: publicProcedure
    .input(z.object({ project: z.string(), branch: z.string() }))
    .mutation(({ input }) => {
      const state = loadState();
      const proj = state.projects.find((p) => p.name === input.project);
      if (!proj) {
        throw new Error(`Project "${input.project}" not found`);
      }

      const { command, env } = gitCmd();

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
          if (currentBranch === input.branch) {
            execFileSync(command, ["worktree", "remove", "--force", currentPath], {
              cwd: proj.path,
              env,
              encoding: "utf-8",
            });
            try {
              execFileSync(command, ["branch", "-D", input.branch], {
                cwd: proj.path,
                env,
                encoding: "utf-8",
              });
            } catch {
              // Branch may already be deleted
            }
            proj.worktrees = proj.worktrees.filter((wt) => wt.branch !== input.branch);
            saveState(state);

            const workspaceId = `${input.project}-${input.branch}`;
            try {
              unlinkSync(join(bandHome(), "workspace-prompts", `${workspaceId}.json`));
            } catch {
              // Prompt file may not exist
            }
            return { ok: true };
          }
          currentPath = "";
          currentBranch = "";
        }
      }

      throw new Error(`Workspace "${input.branch}" not found`);
    }),

  runScript: publicProcedure
    .input(z.object({ path: z.string(), scriptType: z.string() }))
    .mutation(({ input }) => {
      const scriptPath = join(input.path, ".band", input.scriptType);
      if (!existsSync(scriptPath)) {
        throw new Error(`Script "${input.scriptType}" not found`);
      }

      return new Promise<{ ok: true }>((resolve, reject) => {
        execFile("bash", [scriptPath], { cwd: input.path }, (err) => {
          if (err) {
            reject(new Error(err.message));
          } else {
            resolve({ ok: true });
          }
        });
      });
    }),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsRouter = t.router({
  get: publicProcedure.query(() => {
    try {
      const data = readFileSync(settingsFile(), "utf-8");
      return JSON.parse(data);
    } catch {
      return { worktreesDir: null };
    }
  }),

  update: publicProcedure.input(z.record(z.string(), z.unknown())).mutation(({ input }) => {
    ensureDirs();
    writeFileSync(settingsFile(), JSON.stringify(input, null, 2), "utf-8");
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const hooksRouter = t.router({
  check: publicProcedure.query(async () => {
    return await checkHooks();
  }),

  install: publicProcedure.mutation(async () => {
    try {
      await installHooks();
      return { ok: true };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }),
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cliRouter = t.router({
  check: publicProcedure.query(async () => {
    const status = await checkCli();
    return { status };
  }),

  install: publicProcedure.mutation(async () => {
    try {
      await installCli();
      return { ok: true };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }),
});

// ---------------------------------------------------------------------------
// Workspace (file operations)
// ---------------------------------------------------------------------------

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

const workspaceRouter = t.router({
  getDiff: publicProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ input }) => {
    const workspace = resolveWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    const cwd = workspace.worktree.path;
    const defaultBranch = workspace.project.defaultBranch;

    const headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();

    let mergeBase: string;
    try {
      mergeBase = (await execGit(["merge-base", defaultBranch, "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
    }

    let diff = await execGit(["diff", mergeBase], cwd);

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

    const fileStatuses: Record<string, string> = {};
    const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
    for (const line of nameStatusOutput.trim().split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const statusCode = parts[0][0];
      if (statusCode === "R" && parts[2]) {
        fileStatuses[parts[2]] = "R";
      } else if (parts[1]) {
        fileStatuses[parts[1]] = statusCode;
      }
    }

    const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    for (const file of untrackedFiles) {
      try {
        const content = await readFile(join(cwd, file), "utf-8");
        const lines = content.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        diff += `diff --git a/${file} b/${file}\n`;
        diff += "new file mode 100644\n";
        diff += "--- /dev/null\n";
        diff += `+++ b/${file}\n`;
        diff += `@@ -0,0 +1,${lines.length} @@\n`;
        diff += lines.map((l) => `+${l}`).join("\n");
        diff += "\n";
        filesChanged++;
        insertions += lines.length;
        fileStatuses[file] = "U";
      } catch {
        // Skip binary or unreadable files
      }
    }

    return {
      diff,
      stats: { filesChanged, insertions, deletions },
      baseBranch: defaultBranch,
      headBranch,
      fileStatuses,
    };
  }),

  listFiles: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().default("") }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

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

      return { entries, path: input.path };
    }),

  getFile: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      if (!input.path) {
        throw new Error("Path is required");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

      const fileStat = await stat(target);
      const size = fileStat.size;

      if (size > MAX_FILE_SIZE) {
        return { tooLarge: true as const, size };
      }

      const buffer = await readFile(target);

      const sample = buffer.subarray(0, 8192);
      if (sample.includes(0)) {
        return { binary: true as const, size };
      }

      const ext = extname(target).toLowerCase();
      const language = LANG_MAP[ext];

      return {
        content: buffer.toString("utf-8"),
        size,
        language,
      };
    }),
});

// ---------------------------------------------------------------------------
// App Router
// ---------------------------------------------------------------------------

export const appRouter = t.router({
  projects: projectsRouter,
  workspaces: workspacesRouter,
  settings: settingsRouter,
  hooks: hooksRouter,
  cli: cliRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;
