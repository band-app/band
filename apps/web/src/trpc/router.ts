import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { toWorkspaceId } from "@band/dashboard-core";
import { createLogger } from "@band/logger";
import { initTRPC, TRPCError } from "@trpc/server";
import { Cron } from "croner";
import { z } from "zod";
import { getOrCreateAgent } from "../lib/agent-pool";
import { checkCli, installCli } from "../lib/cli";
import { stopJobsForKey } from "../lib/cronjob-scheduler";
import {
  deleteCronjobFile,
  generateCronjobId,
  listAllCronjobs,
  loadCronjobFile,
  saveCronjobFile,
} from "../lib/cronjob-store";
import type { CronjobDefinition } from "../lib/cronjob-types";
import { execGit, gitCmd, listWorktrees } from "../lib/git";
import { checkHooks, installHooks } from "../lib/hooks";
import { resolvePendingInput } from "../lib/pending-inputs";
import { checkPrereqs, shellPath } from "../lib/process-utils";
import {
  bandHome,
  ensureDirs,
  loadCurrentStatuses,
  loadSettings,
  loadState,
  saveState,
  settingsFile,
  statusDir,
  worktreesDir,
} from "../lib/state";
import {
  abortTask,
  cancelTask,
  getBufferedChunks,
  getTask,
  submitTask,
  subscribe as subscribeTask,
  TaskConflictError,
} from "../lib/task-runner";
import { listTasks, loadTask } from "../lib/task-store";
import { getTunnelStatus, startTunnel, stopTunnel } from "../lib/tunnel";
import { subscribe as subscribeStatus } from "../lib/watcher";
import { resolveWorkspace } from "../lib/workspace";
import type { Context } from "./context";

const log = createLogger("trpc");

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
            const workspaceId = toWorkspaceId(project.name, wt.branch);
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

    // Clean up project-scoped cronjobs
    stopJobsForKey(input.name);
    deleteCronjobFile(input.name);

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

      const existing = proj.worktrees.find((wt) => wt.branch === input.branch);
      if (existing) {
        return { ok: true, path: existing.path };
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

      // Run setup script if configured
      const configPath = join(worktreePath, ".band", "config.json");
      try {
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          if (config.setup) {
            execFileSync("bash", ["-c", config.setup], {
              cwd: worktreePath,
              env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
              encoding: "utf-8",
              timeout: 60_000,
            });
          }
        }
      } catch {
        // Setup script failure is non-fatal
      }

      if (input.prompt) {
        const workspaceId = toWorkspaceId(input.project, input.branch);
        submitTask(workspaceId, input.prompt);
      }

      return { ok: true, path: worktreePath };
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
            const worktreePath = currentPath;

            // Run teardown script before removing worktree so it can access project files
            const configPath = join(worktreePath, ".band", "config.json");
            try {
              if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, "utf-8"));
                if (config.teardown) {
                  execFileSync("bash", ["-c", config.teardown], {
                    cwd: worktreePath,
                    env: {
                      ...process.env,
                      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
                    },
                    encoding: "utf-8",
                    timeout: 60_000,
                  });
                }
              }
            } catch {
              // Teardown script failure is non-fatal
            }

            execFileSync(command, ["worktree", "remove", "--force", worktreePath], {
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

            const workspaceId = toWorkspaceId(input.project, input.branch);
            try {
              unlinkSync(join(bandHome(), "workspace-prompts", `${workspaceId}.json`));
            } catch {
              // Prompt file may not exist
            }
            try {
              unlinkSync(join(statusDir(), `${workspaceId}.json`));
            } catch {
              // Status file may not exist
            }

            // Clean up workspace-scoped cronjobs
            stopJobsForKey(workspaceId);
            deleteCronjobFile(workspaceId);

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
// Tunnel
// ---------------------------------------------------------------------------

const tunnelRouter = t.router({
  status: publicProcedure.query(() => {
    return getTunnelStatus();
  }),

  start: publicProcedure.input(z.object({}).optional()).mutation(async () => {
    log.debug("tunnel.start called");
    const port = parseInt(process.env.PORT || "3456", 10);
    log.debug("tunnel.start: port=%d", port);
    try {
      await startTunnel({ port });
    } catch (err) {
      log.debug({ err }, "tunnel.start: startTunnel failed");
      return { ok: true, url: null as string | null };
    }
    const status = getTunnelStatus();
    log.debug({ status }, "tunnel.start: after startTunnel");
    if (status.url) {
      return { ok: true, url: status.url };
    }
    log.debug("tunnel.start: no URL available");
    return { ok: true, url: null as string | null };
  }),

  stop: publicProcedure.mutation(async () => {
    await stopTunnel();
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const prereqsRouter = t.router({
  check: publicProcedure.query(async () => {
    return await checkPrereqs();
  }),

  installTunnel: publicProcedure.mutation(async () => {
    const resolvedPath = await shellPath();
    await new Promise<void>((resolve, reject) => {
      execFile(
        "brew",
        ["install", "cloudflared"],
        { env: { ...process.env, PATH: resolvedPath }, timeout: 120_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          resolve();
        },
      );
    });
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface FilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

async function saveUploadedFiles(fileParts: FilePart[]): Promise<string[]> {
  const uploadDir = join(bandHome(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  const savedPaths: string[] = [];

  for (const part of fileParts) {
    const dataUrlMatch = part.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!dataUrlMatch) continue;

    const buffer = Buffer.from(dataUrlMatch[1], "base64");
    const timestamp = Date.now();
    const filename = part.filename || `file-${timestamp}`;
    const safeName = `${timestamp}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = join(uploadDir, safeName);

    await writeFile(filePath, buffer);
    savedPaths.push(filePath);
  }

  return savedPaths;
}

const tasksRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({
          project: z.string().optional(),
          workspaceId: z.string().optional(),
          status: z.enum(["running", "completed", "failed"]).optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      return { tasks: listTasks(input) };
    }),

  submit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        prompt: z.string(),
        sessionId: z.string().optional(),
        files: z
          .array(
            z.object({
              mediaType: z.string(),
              url: z.string(),
              filename: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      let agentPrompt: string | undefined;
      if (input.files && input.files.length > 0) {
        const savedPaths = await saveUploadedFiles(input.files);
        if (savedPaths.length > 0) {
          const fileList = savedPaths.map((p) => `- ${p}`).join("\n");
          agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${input.prompt}`;
        }
      }

      try {
        const task = submitTask(input.workspaceId, input.prompt, input.sessionId, agentPrompt);
        return { id: task.id, workspaceId: task.workspaceId, sessionId: task.sessionId };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this workspace",
          });
        }
        if (err instanceof Error && err.message.startsWith("Workspace not found")) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: err.message,
          });
        }
        throw err;
      }
    }),

  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    const task = getTask(input.workspaceId);
    return { task };
  }),

  abort: publicProcedure.input(z.object({ workspaceId: z.string() })).mutation(({ input }) => {
    const aborted = abortTask(input.workspaceId);
    if (!aborted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No running task found" });
    }
    return { aborted: true };
  }),

  cancel: publicProcedure.input(z.object({ taskId: z.string() })).mutation(({ input }) => {
    const result = cancelTask(input.taskId);
    if (!result.cancelled) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Task not found or not running",
      });
    }
    return { cancelled: true };
  }),

  rerun: publicProcedure.input(z.object({ taskId: z.string() })).mutation(({ input }) => {
    const record = loadTask(input.taskId);
    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    }

    try {
      const task = submitTask(record.workspaceId, record.prompt);
      return { workspaceId: task.workspaceId, sessionId: task.sessionId };
    } catch (err) {
      if (err instanceof TaskConflictError) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Task already running for this workspace",
        });
      }
      throw err;
    }
  }),

  stream: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .subscription(async function* (opts) {
      const workspaceId = opts.input.workspaceId;
      const task = getTask(workspaceId);

      if (!task) {
        // No active task — replay any buffered chunks (e.g. recently completed)
        const buffered = getBufferedChunks(workspaceId);
        for (const chunk of buffered) {
          yield chunk;
        }
        return;
      }

      // Subscribe for live events FIRST, then snapshot the buffer.
      // Both calls are synchronous, so no events can be emitted between
      // them (single-threaded JS). This guarantees zero gap and zero
      // overlap between the buffer snapshot and the live listener.
      type Chunk = Parameters<Parameters<typeof subscribeTask>[1]>[0];
      const queue: Chunk[] = [];
      let resolve: (() => void) | null = null;
      let done = false;

      const unsubscribe = subscribeTask(workspaceId, (chunk) => {
        queue.push(chunk);
        if (chunk.type === "finish") {
          done = true;
        }
        resolve?.();
      });

      const buffered = getBufferedChunks(workspaceId);

      // Replay buffered chunks
      for (const chunk of buffered) {
        yield chunk;
      }

      // If task is already done and no live events queued, stop
      if (task.status !== "running" && queue.length === 0) {
        unsubscribe();
        return;
      }

      opts.signal.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      try {
        while (!opts.signal.aborted) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) return;
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      } finally {
        unsubscribe();
      }
    }),
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionsRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ input }) => {
    const workspace = resolveWorkspace(input.workspaceId);
    if (!workspace) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
    }

    const agent = await getOrCreateAgent(input.workspaceId, workspace.worktree.path);

    if (!agent.supportedFeatures.sessionListing || !agent.listSessions) {
      return { sessions: [], supported: false };
    }

    const sessions = await agent.listSessions(workspace.worktree.path);
    return { sessions, supported: true };
  }),

  messages: publicProcedure
    .input(z.object({ workspaceId: z.string(), sessionId: z.string() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      const agent = await getOrCreateAgent(input.workspaceId, workspace.worktree.path);

      if (!agent.supportedFeatures.sessionListing || !agent.getSessionMessages) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Session listing not supported" });
      }

      const messages = await agent.getSessionMessages(input.sessionId, workspace.worktree.path);
      return { messages };
    }),
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const servicesRouter = t.router({
  health: publicProcedure.query(() => {
    log.debug("services.health called");
    const tunnel = getTunnelStatus();
    log.debug({ tunnel }, "services.health: tunnel status");

    const result = {
      webserver: true,
      tunnel: tunnel.running,
      tunnel_url: tunnel.url,
    };
    log.debug({ result }, "services.health result");
    return result;
  }),
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const chatRouter = t.router({
  answer: publicProcedure
    .input(z.object({ approvalId: z.string(), answers: z.record(z.string(), z.string()) }))
    .mutation(({ input }) => {
      const resolved = resolvePendingInput(input.approvalId, input.answers);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No pending input found for this approvalId",
        });
      }
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

const statusesRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    const filePath = join(statusDir(), `${input.workspaceId}.json`);
    try {
      const data = readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }),

  update: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        agent: z.object({
          status: z.string(),
          lastActivity: z.string().optional(),
        }),
      }),
    )
    .mutation(({ input }) => {
      ensureDirs();
      const filePath = join(statusDir(), `${input.workspaceId}.json`);

      // Read existing status file to preserve fields
      let status: Record<string, unknown> = {};
      try {
        const data = readFileSync(filePath, "utf-8");
        status = JSON.parse(data);
      } catch {
        // File doesn't exist or is invalid — start fresh
      }

      status.workspaceId = input.workspaceId;

      // Merge agent fields
      const existing = (status.agent as Record<string, unknown>) ?? {};
      status.agent = { ...existing, ...input.agent };

      const json = JSON.stringify(status, null, 2);

      // Atomic write: write to temp file then rename
      const tmpPath = join(statusDir(), `.${input.workspaceId}.json.tmp`);
      writeFileSync(tmpPath, json, "utf-8");
      renameSync(tmpPath, filePath);

      return { ok: true };
    }),

  resolve: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) => {
    const state = loadState();
    for (const proj of state.projects) {
      for (const wt of proj.worktrees) {
        if (input.cwd === wt.path || input.cwd.startsWith(`${wt.path}/`)) {
          return { workspaceId: toWorkspaceId(proj.name, wt.branch) };
        }
      }
    }
    return { workspaceId: null };
  }),
});

// ---------------------------------------------------------------------------
// Status (SSE subscription)
// ---------------------------------------------------------------------------

const statusRouter = t.router({
  stream: publicProcedure.subscription(async function* (opts) {
    type QueueItem = Parameters<Parameters<typeof subscribeStatus>[0]>[0];
    const queue: QueueItem[] = [];
    let resolve: (() => void) | null = null;

    const unsubscribe = subscribeStatus((event) => {
      queue.push(event);
      resolve?.();
    });

    opts.signal.addEventListener("abort", () => {
      unsubscribe();
      resolve?.();
    });

    try {
      while (!opts.signal.aborted) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    } finally {
      unsubscribe();
    }
  }),
});

// ---------------------------------------------------------------------------
// Cronjobs
// ---------------------------------------------------------------------------

const cronjobsRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({
          project: z.string().optional(),
          workspaceId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      if (input?.project) {
        const file = loadCronjobFile(input.project);
        return { jobs: file.jobs.map((j) => ({ ...j, fileKey: input.project! })) };
      }
      if (input?.workspaceId) {
        const file = loadCronjobFile(input.workspaceId);
        return { jobs: file.jobs.map((j) => ({ ...j, fileKey: input.workspaceId! })) };
      }
      return { jobs: listAllCronjobs() };
    }),

  get: publicProcedure.input(z.object({ key: z.string(), id: z.string() })).query(({ input }) => {
    const file = loadCronjobFile(input.key);
    const job = file.jobs.find((j) => j.id === input.id);
    if (!job) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Cronjob not found" });
    }
    return { job };
  }),

  create: publicProcedure
    .input(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        prompt: z.string().min(1),
        cronExpression: z.string().min(1),
        scope: z.enum(["project", "workspace"]),
        workspaceId: z.string().optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(({ input }) => {
      // Validate cron expression
      try {
        // eslint-disable-next-line no-new
        new Cron(input.cronExpression, { maxRuns: 0 });
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid cron expression",
        });
      }

      if (input.scope === "workspace" && !input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceId is required for workspace-scoped cronjobs",
        });
      }

      const file = loadCronjobFile(input.key);
      const job: CronjobDefinition = {
        id: generateCronjobId(),
        name: input.name,
        prompt: input.prompt,
        cronExpression: input.cronExpression,
        scope: input.scope,
        workspaceId: input.workspaceId,
        enabled: input.enabled,
        createdAt: new Date().toISOString(),
      };
      file.jobs.push(job);
      saveCronjobFile(input.key, file);
      return { job };
    }),

  update: publicProcedure
    .input(
      z.object({
        key: z.string(),
        id: z.string(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        cronExpression: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.cronExpression) {
        try {
          // eslint-disable-next-line no-new
          new Cron(input.cronExpression, { maxRuns: 0 });
        } catch {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid cron expression",
          });
        }
      }

      const file = loadCronjobFile(input.key);
      const job = file.jobs.find((j) => j.id === input.id);
      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Cronjob not found" });
      }

      if (input.name !== undefined) job.name = input.name;
      if (input.prompt !== undefined) job.prompt = input.prompt;
      if (input.cronExpression !== undefined) job.cronExpression = input.cronExpression;
      if (input.enabled !== undefined) job.enabled = input.enabled;

      saveCronjobFile(input.key, file);
      return { job };
    }),

  delete: publicProcedure
    .input(z.object({ key: z.string(), id: z.string() }))
    .mutation(({ input }) => {
      const file = loadCronjobFile(input.key);
      const index = file.jobs.findIndex((j) => j.id === input.id);
      if (index === -1) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Cronjob not found" });
      }
      file.jobs.splice(index, 1);
      saveCronjobFile(input.key, file);
      return { ok: true };
    }),

  trigger: publicProcedure
    .input(z.object({ key: z.string(), id: z.string() }))
    .mutation(({ input }) => {
      const file = loadCronjobFile(input.key);
      const job = file.jobs.find((j) => j.id === input.id);
      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Cronjob not found" });
      }

      let workspaceId: string;
      if (job.scope === "workspace" && job.workspaceId) {
        workspaceId = job.workspaceId;
      } else {
        const state = loadState();
        const project = state.projects.find((p) => p.name === input.key);
        if (!project) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }
        workspaceId = toWorkspaceId(project.name, project.defaultBranch);
      }

      try {
        const task = submitTask(workspaceId, job.prompt);
        return { taskId: task.id, workspaceId };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this workspace",
          });
        }
        throw err;
      }
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
  tunnel: tunnelRouter,
  prereqs: prereqsRouter,
  tasks: tasksRouter,
  sessions: sessionsRouter,
  services: servicesRouter,
  chat: chatRouter,
  statuses: statusesRouter,
  status: statusRouter,
  cronjobs: cronjobsRouter,
});

export type AppRouter = typeof appRouter;
