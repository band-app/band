import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { createLogger } from "@band-app/logger";
import { initTRPC, TRPCError } from "@trpc/server";
import type { UIMessage } from "ai";
import { Cron } from "croner";
import { z } from "zod";
import { createMetadataAgent, getOrCreateAgent, replaceAgent } from "../lib/agent-pool";
import {
  deleteBrowserLayout,
  getBrowserLayout,
  removeBrowserFromLayout,
  saveBrowserLayout,
} from "../lib/browser-layout-manager";
import {
  createBrowser,
  getBrowser,
  listBrowsers,
  removeBrowser,
  removeWorkspaceBrowsers,
  updateBrowser,
  updateBrowserUrl,
} from "../lib/browser-manager";
import { deleteChatLayout, getChatLayout, saveChatLayout } from "../lib/chat-layout-manager";
import {
  createChat,
  getChat,
  getOrCreateDefaultChat,
  listChats,
  removeChat,
  removeWorkspaceChats,
  updateChat,
  updateChatActiveSession,
  updateChatStatus,
} from "../lib/chat-manager";
import {
  ensureActiveSessionSummary,
  scheduleActiveSessionRefresh,
} from "../lib/chat-session-summary";
import { checkCli, installCli, resolveCliPaths } from "../lib/cli";
import { convertEventsToUIMessages, convertHistoryToUIMessages } from "../lib/convert-events";
import { reloadSchedules, stopJobsForKey } from "../lib/cronjob-scheduler";
import {
  deleteCronjobFile,
  generateCronjobId,
  listAllCronjobs,
  loadCronjobFile,
  saveCronjobFile,
} from "../lib/cronjob-store";
import type { CronjobDefinition } from "../lib/cronjob-types";
import { fuzzyScore } from "../lib/fuzzy-score";
import { execGit, gitCmd, listWorktrees } from "../lib/git";
import { checkHooks, installHooks } from "../lib/hooks";
import { killWorkspaceServers } from "../lib/lsp-manager";
import { resolvePendingInput } from "../lib/pending-inputs";
import { checkPrereqs, shellPath } from "../lib/process-utils";
import { loadProjectConfig } from "../lib/project-config";
import {
  clearQueuedMessages,
  getQueuedMessages,
  pushQueuedMessage,
  removeQueuedMessage,
  setQueuedMessages,
  shiftQueuedMessage,
  subscribeQueue,
} from "../lib/queued-message-store";
import { getSessionEventsBefore, getSessionEventsTail } from "../lib/session-store";
import { runSetup } from "../lib/setup-runner";
import {
  bandHome,
  deleteBranchStatus,
  deleteWorkspaceStatus,
  getAgentDefinition,
  getWorkspaceStatus,
  loadCurrentStatuses,
  loadSettings,
  loadState,
  saveSettings,
  saveState,
  upsertWorkspaceStatus,
  worktreesDir,
} from "../lib/state";
import { abortTask, cancelTask, getTask, submitTask, TaskConflictError } from "../lib/task-runner";
import { listTasks, loadTask } from "../lib/task-store";
import { loadWorkspaceTerminalConfig } from "../lib/terminal-config";
import {
  deleteTerminalLayout,
  getTerminalLayout,
  removeTerminalFromLayout,
  saveTerminalLayout,
} from "../lib/terminal-layout-manager";
import {
  getScrollback,
  getTerminalSession,
  killTerminal,
  killWorkspaceTerminals,
  listTerminals,
  spawnTerminal,
  subscribeTerminalOutput,
  writeToTerminal,
} from "../lib/terminal-manager";
import { getTunnelStatus, startTunnel, stopTunnel } from "../lib/tunnel";
import { saveUploadedFiles } from "../lib/upload-utils";
import { emit, subscribe as subscribeStatus } from "../lib/watcher";
import { resolveWorkspace } from "../lib/workspace";
import type { Context } from "./context";

const execFileAsync = promisify(execFile);
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

  checkPath: publicProcedure.input(z.object({ path: z.string() })).query(({ input }) => {
    const resolvedPath = resolve(input.path);
    const isGitRepo = existsSync(join(resolvedPath, ".git"));
    return { isGitRepo };
  }),

  gitInit: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    const resolvedPath = resolve(input.path);
    await execGit(["init"], resolvedPath);
  }),

  add: publicProcedure
    .input(z.object({ path: z.string(), label: z.string().optional() }))
    .mutation(async ({ input }) => {
      const state = loadState();
      const name = basename(input.path);

      if (state.projects.some((p) => p.name === name)) {
        throw new Error(`Project "${name}" already registered`);
      }

      if (input.label) {
        const settings = loadSettings();
        const validIds = (settings.labels ?? []).map((l) => l.id);
        if (!validIds.includes(input.label)) {
          throw new Error(
            `Label "${input.label}" does not exist. Valid labels: ${validIds.join(", ") || "(none)"}`,
          );
        }
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
        maxTurns: z.number().int().positive().optional(),
        mode: z.string().optional(),
        model: z.string().optional(),
        codingAgentId: z.string().optional(),
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

      const workspaceId = toWorkspaceId(input.project, input.branch);

      // Run setup script in the background (non-blocking).
      // If a prompt is provided, defer task submission until setup completes
      // so the agent has dependencies installed.
      const defaultChat = getOrCreateDefaultChat(workspaceId);
      const onSetupComplete = input.prompt
        ? () =>
            submitTask({
              workspaceId,
              chatId: defaultChat.id,
              prompt: input.prompt!,
              maxTurns: input.maxTurns,
              mode: input.mode,
              model: input.model,
              codingAgentId: input.codingAgentId,
            })
        : undefined;

      runSetup(workspaceId, worktreePath, proj.path, onSetupComplete);

      // If there's no setup command, runSetup calls onComplete synchronously,
      // so the task is submitted immediately. If there IS a setup command,
      // the task will be submitted when setup finishes.

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

      const { command, env: gitEnv } = gitCmd();

      const output = execFileSync(command, ["worktree", "list", "--porcelain"], {
        cwd: proj.path,
        env: gitEnv,
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

            // Capture config before returning — the directory may be removed
            // by background cleanup before loadProjectConfig can read it.
            let teardownCmd: string | undefined;
            try {
              const config = loadProjectConfig(worktreePath, proj.path);
              if (config?.teardown && typeof config.teardown === "string") {
                teardownCmd = config.teardown;
              }
            } catch {
              // Config may not exist
            }

            // ── Fast path: update state and return immediately ──
            proj.worktrees = proj.worktrees.filter((wt) => wt.branch !== input.branch);
            saveState(state);

            const workspaceId = toWorkspaceId(input.project, input.branch);
            try {
              unlinkSync(join(bandHome(), "workspace-prompts", `${workspaceId}.json`));
            } catch {
              // Prompt file may not exist
            }
            deleteWorkspaceStatus(workspaceId);
            deleteBranchStatus(workspaceId);

            // Clean up all chat panes and their agent processes
            removeWorkspaceChats(workspaceId);

            // Clean up chat layout tree
            deleteChatLayout(workspaceId);

            // Clean up all browser tabs
            removeWorkspaceBrowsers(workspaceId);

            // Clean up browser layout tree
            deleteBrowserLayout(workspaceId);

            // Kill any running terminal PTY sessions
            killWorkspaceTerminals(workspaceId);

            // Clean up terminal layout tree
            deleteTerminalLayout(workspaceId);

            // Kill any running language server processes
            killWorkspaceServers(workspaceId);

            // Clean up workspace-scoped cronjobs
            stopJobsForKey(workspaceId);
            deleteCronjobFile(workspaceId);

            // Notify subscribers (dashboard status stream) that this workspace is gone
            emit({ kind: "remove", workspaceId });

            // ── Background cleanup: slow git/fs operations ──
            const projPath = proj.path;
            setImmediate(() => {
              (async () => {
                // Run teardown script before removing worktree so it can access project files
                if (teardownCmd) {
                  try {
                    await execFileAsync("bash", ["-c", teardownCmd], {
                      cwd: worktreePath,
                      env: {
                        ...process.env,
                        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
                      },
                      encoding: "utf-8",
                      timeout: 60_000,
                    });
                  } catch (err) {
                    log.warn({ err, workspaceId }, "teardown script failed");
                  }
                }

                try {
                  await execFileAsync(command, ["worktree", "remove", "--force", worktreePath], {
                    cwd: projPath,
                    env: gitEnv,
                    encoding: "utf-8",
                  });
                } catch {
                  // Worktree may be corrupted (e.g. missing .git file).
                  // Manually remove the directory and prune stale entries.
                  await rm(worktreePath, { recursive: true, force: true });
                  try {
                    await execFileAsync(command, ["worktree", "prune"], {
                      cwd: projPath,
                      env: gitEnv,
                      encoding: "utf-8",
                    });
                  } catch (err) {
                    log.warn({ err, workspaceId }, "git worktree prune failed");
                  }
                }

                try {
                  await execFileAsync(command, ["branch", "-D", input.branch], {
                    cwd: projPath,
                    env: gitEnv,
                    encoding: "utf-8",
                  });
                } catch {
                  // Branch may already be deleted
                }
              })().catch((err) => {
                log.error({ err, workspaceId }, "background workspace cleanup failed");
              });
            });

            return { ok: true };
          }
          currentPath = "";
          currentBranch = "";
        }
      }

      throw new Error(`Workspace "${input.branch}" not found`);
    }),

  gitPull: publicProcedure
    .input(z.object({ project: z.string(), branch: z.string() }))
    .mutation(async ({ input }) => {
      const workspaceId = toWorkspaceId(input.project, input.branch);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["pull", "--rebase"], cwd);
      } catch (e) {
        // git pull --rebase can exit non-zero with "Cannot rebase onto multiple
        // branches" when the fetch step already fast-forwarded the working tree.
        // The pull effectively succeeded, so swallow this specific error.
        const msg = String(e);
        if (msg.includes("Cannot rebase onto multiple branches")) {
          return { ok: true };
        }
        throw e;
      }
      return { ok: true };
    }),

  gitPush: publicProcedure
    .input(z.object({ project: z.string(), branch: z.string() }))
    .mutation(async ({ input }) => {
      const workspaceId = toWorkspaceId(input.project, input.branch);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["push"], cwd);
      } catch {
        // First push may need to set upstream
        await execGit(["push", "--set-upstream", "origin", input.branch], cwd);
      }
      return { ok: true };
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
    return loadSettings();
  }),

  update: publicProcedure.input(z.record(z.string(), z.unknown())).mutation(({ input }) => {
    saveSettings(input);
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

  resolve: publicProcedure.query(() => {
    return resolveCliPaths();
  }),

  install: publicProcedure
    .input(z.object({ allowPrompt: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
      try {
        await installCli({ allowPrompt: input?.allowPrompt });
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
  getTerminalConfig: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) return { config: null };
      const config = loadWorkspaceTerminalConfig(workspace.worktree.path, workspace.project.path);
      return { config };
    }),

  getDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;

      let headBranch: string;
      try {
        headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      } catch {
        // No commits yet — HEAD doesn't exist
        headBranch = defaultBranch;
      }

      let mergeBase: string;
      if (input.diffMode === "uncommitted") {
        try {
          mergeBase = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
        } catch {
          // No commits yet — diff against the empty tree so all staged files appear as new
          mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      } else {
        try {
          mergeBase = (await execGit(["merge-base", defaultBranch, "HEAD"], cwd)).trim();
        } catch {
          mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      }

      const diffArgs = ["diff"];
      if (input.contextLines !== undefined) {
        diffArgs.push(`-U${input.contextLines}`);
      }
      diffArgs.push(mergeBase);
      let diff = await execGit(diffArgs, cwd);

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

  getDiffSummary: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;

      let headBranch: string;
      try {
        headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      } catch {
        // No commits yet — HEAD doesn't exist
        headBranch = defaultBranch;
      }

      let mergeBase: string;
      if (input.diffMode === "uncommitted") {
        try {
          mergeBase = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
        } catch {
          // No commits yet — diff against the empty tree so all staged files appear as new
          mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      } else {
        try {
          mergeBase = (await execGit(["merge-base", defaultBranch, "HEAD"], cwd)).trim();
        } catch {
          mergeBase = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      }

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
          filesChanged++;
          insertions += lines.length;
          fileStatuses[file] = "U";
        } catch {
          // Skip binary or unreadable files
        }
      }

      return {
        stats: { filesChanged, insertions, deletions },
        baseBranch: defaultBranch,
        headBranch,
        fileStatuses,
        mergeBase,
      };
    }),

  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
        mergeBase: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;

      // Check if file is untracked
      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      if (untrackedFiles.includes(input.filePath)) {
        // Synthesize diff for untracked file
        try {
          const content = await readFile(join(cwd, input.filePath), "utf-8");
          const lines = content.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          let diff = `diff --git a/${input.filePath} b/${input.filePath}\n`;
          diff += "new file mode 100644\n";
          diff += "--- /dev/null\n";
          diff += `+++ b/${input.filePath}\n`;
          diff += `@@ -0,0 +1,${lines.length} @@\n`;
          diff += lines.map((l) => `+${l}`).join("\n");
          diff += "\n";
          return { diff };
        } catch {
          return { diff: "" };
        }
      }

      // Tracked file — get diff for this single file
      const fileDiffArgs = ["diff"];
      if (input.contextLines !== undefined) {
        fileDiffArgs.push(`-U${input.contextLines}`);
      }
      fileDiffArgs.push(input.mergeBase, "--", input.filePath);
      const diff = await execGit(fileDiffArgs, cwd);
      return { diff };
    }),

  revertFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const { filePath, diffMode } = input;

      // Determine the file status server-side
      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      if (untrackedFiles.includes(filePath)) {
        // Untracked file — just delete it
        await rm(join(cwd, filePath), { force: true });
        return { ok: true };
      }

      // Resolve the reference commit for the diff mode
      let ref: string;
      if (diffMode === "uncommitted") {
        try {
          ref = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
        } catch {
          ref = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      } else {
        const defaultBranch = workspace.project.defaultBranch;
        try {
          ref = (await execGit(["merge-base", defaultBranch, "HEAD"], cwd)).trim();
        } catch {
          ref = (await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
        }
      }

      // Determine the tracked file status from the diff
      const nameStatusOutput = await execGit(["diff", "--name-status", ref, "--", filePath], cwd);
      const statusLine = nameStatusOutput.trim().split("\n").filter(Boolean)[0];
      const fileStatus = statusLine ? statusLine[0] : null;

      if (fileStatus === "A") {
        // Added (staged) file — remove from index and delete from working tree
        await execGit(["rm", "-f", "--", filePath], cwd);
      } else {
        // Modified, Deleted, or Renamed — restore to the reference commit
        await execGit(["checkout", ref, "--", filePath], cwd);
      }

      return { ok: true };
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

  saveFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new Error("Cannot write to a directory");
      }

      await writeFile(target, input.content, "utf-8");

      return { ok: true };
    }),

  searchFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().default(""),
        limit: z.number().default(50),
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const output = await execGit(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);

      let files = output.trim().split("\n").filter(Boolean);

      if (input.query) {
        const scored: { file: string; score: number }[] = [];
        for (const f of files) {
          const score = fuzzyScore(input.query, f);
          if (score !== null) {
            scored.push({ file: f, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        files = scored.map((r) => r.file);
      }

      return { files: files.slice(0, input.limit) };
    }),

  searchContent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().min(1),
        caseSensitive: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        regex: z.boolean().default(false),
        limit: z.number().default(100),
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const args = ["grep", "-n", "--no-color", "-I"];
      if (input.regex) {
        args.push("-E");
      } else {
        args.push("-F");
      }
      if (!input.caseSensitive) args.push("-i");
      if (input.wholeWord) args.push("-w");
      args.push("--", input.query);

      let output: string;
      try {
        output = await execGit(args, cwd);
      } catch {
        // git grep exits with status 1 when no matches found
        return { results: [] };
      }

      const lines = output.trim().split("\n").filter(Boolean);
      const results: Array<{ file: string; line: number; content: string }> = [];

      for (const raw of lines) {
        if (results.length >= input.limit) break;
        const colonIdx1 = raw.indexOf(":");
        if (colonIdx1 === -1) continue;
        const colonIdx2 = raw.indexOf(":", colonIdx1 + 1);
        if (colonIdx2 === -1) continue;

        const file = raw.slice(0, colonIdx1);
        const line = Number.parseInt(raw.slice(colonIdx1 + 1, colonIdx2), 10);
        const content = raw.slice(colonIdx2 + 1);

        results.push({ file, line, content });
      }

      return { results };
    }),

  switchAgent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        agentId: z.string(),
        chatId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      // Resolve the chat pane (use provided chatId or default)
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;

      // Abort any running task and clear queued messages so the new agent
      // starts with a clean slate.
      abortTask(chatId);
      clearQueuedMessages(chatId);

      // Replace the agent in the pool with the new agent type
      await replaceAgent(chatId, workspace.worktree.path, input.agentId);

      // Update the chat pane's agent config
      updateChat(chatId, { agent: input.agentId });

      // Update workspace status with the new coding agent ID
      upsertWorkspaceStatus(input.workspaceId, {
        status: "waiting",
        codingAgentId: input.agentId,
      });

      emit({ kind: "update", status: getWorkspaceStatus(input.workspaceId)! });

      return { ok: true };
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
    const port = parseInt(process.env.BAND_PORT || "3456", 10);
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

const tasksRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({
          project: z.string().optional(),
          workspaceId: z.string().optional(),
          status: z.enum(["running", "completed", "failed"]).optional(),
          sessionId: z.string().optional(),
          chatId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const tasks = listTasks(input);
      const state = loadState();
      const workspaceIds = new Set<string>();
      for (const p of state.projects) {
        for (const wt of p.worktrees) {
          workspaceIds.add(toWorkspaceId(p.name, wt.branch));
        }
      }
      return {
        tasks: tasks.map((t) => ({
          ...t,
          workspaceExists: workspaceIds.has(t.workspaceId),
        })),
      };
    }),

  submit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        prompt: z.string(),
        sessionId: z.string().optional(),
        maxTurns: z.number().int().positive().optional(),
        mode: z.string().optional(),
        model: z.string().optional(),
        codingAgentId: z.string().optional(),
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
      // Resolve chatId: if the client provides one, lazily ensure the server
      // record exists. If not provided, fall back to the default chat.
      let chatId: string;
      if (input.chatId) {
        const existing = getChat(input.chatId);
        if (!existing) {
          // Lazily create the chat record.  Preserve the agent from the
          // task so the correct agent type is used (not the default).
          createChat(input.workspaceId, {
            id: input.chatId,
            name: "Chat",
            agent: input.codingAgentId,
          });
        }
        chatId = input.chatId;
      } else {
        chatId = getOrCreateDefaultChat(input.workspaceId).id;
      }

      let agentPrompt: string | undefined;
      if (input.files && input.files.length > 0) {
        const savedPaths = await saveUploadedFiles(input.files);
        if (savedPaths.length > 0) {
          const fileList = savedPaths.map((p) => `- ${p}`).join("\n");
          agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${input.prompt}`;
        }
      }

      try {
        const task = submitTask({
          workspaceId: input.workspaceId,
          chatId,
          prompt: input.prompt,
          sessionId: input.sessionId,
          agentPrompt,
          maxTurns: input.maxTurns,
          mode: input.mode,
          model: input.model,
          codingAgentId: input.codingAgentId,
        });
        return {
          id: task.id,
          workspaceId: task.workspaceId,
          chatId: task.chatId,
          sessionId: task.sessionId,
        };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this chat pane",
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

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const task = getTask(chatId);
      return { task };
    }),

  /**
   * Lightweight existence check — used by the client during reconnect retries
   * to distinguish "server says nothing's running, give up" from "server says
   * a task IS running, keep retrying". This avoids a noisy `task` payload
   * round-trip on every retry tick.
   */
  isRunning: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const task = getTask(chatId);
      return { running: task?.status === "running" };
    }),

  abort: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const aborted = abortTask(chatId);
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

    // Use original chat pane or default for workspace
    const chatId = record.chatId ?? getOrCreateDefaultChat(record.workspaceId).id;

    try {
      const task = submitTask({
        workspaceId: record.workspaceId,
        chatId,
        prompt: record.prompt,
        maxTurns: record.maxTurns,
        mode: record.mode,
        model: record.model,
        codingAgentId: record.codingAgentId,
      });
      return { workspaceId: task.workspaceId, chatId: task.chatId, sessionId: task.sessionId };
    } catch (err) {
      if (err instanceof TaskConflictError) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Task already running for this chat pane",
        });
      }
      throw err;
    }
  }),
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionsRouter = t.router({
  list: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      // Resolve the agent from the chat pane if chatId is provided
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const chatSession = getChat(chatId);
      const agent = await getOrCreateAgent(chatId, workspace.worktree.path, chatSession?.agent);

      if (!agent.supportedFeatures.sessionListing || !agent.listSessions) {
        return { sessions: [], supported: false };
      }

      // Each agent's listSessions() already scopes to the workspace
      // directory — no additional filtering needed.  This shows all
      // sessions for the agent type, including ones created outside Band.
      const allSessions = await agent.listSessions(workspace.worktree.path);
      return { sessions: allSessions, supported: true };
    }),

  messages: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        sessionId: z.string(),
        // Buffer cursor: pagination through the in-memory ring buffer.
        beforeEventId: z.number().optional(),
        // JSONL cursor: pagination through the on-disk session history.
        // Index is in the full message list; the server returns messages
        // [max(0, beforeMessageIndex - limit), beforeMessageIndex).
        beforeMessageIndex: z.number().int().nonnegative().optional(),
        limit: z.number().min(1).max(200).default(100).optional(),
      }),
    )
    .query(async ({ input }) => {
      const pageSize = input.limit ?? 100;

      // Try in-memory session buffer first (only for non-JSONL pagination).
      // When the client is paginating via beforeMessageIndex we're explicitly
      // requesting an older JSONL page and must skip the buffer.
      if (input.beforeMessageIndex === undefined) {
        const events = input.beforeEventId
          ? getSessionEventsBefore(input.sessionId, input.beforeEventId, pageSize)
          : getSessionEventsTail(input.sessionId, pageSize);

        if (events.length > 0) {
          const bufferMessages = convertEventsToUIMessages(events);
          const firstEventId = events[0].id;
          const lastEventId = events[events.length - 1].id;

          // Check if there are more events before the first one we returned
          const older = getSessionEventsBefore(input.sessionId, firstEventId, 1);
          const hasMoreInBuffer = older.length > 0;

          if (hasMoreInBuffer || input.beforeEventId) {
            // More buffer pages available, or this is already a pagination
            // request — return buffer page only.
            return {
              messages: bufferMessages,
              firstEventId,
              lastEventId,
              firstMessageIndex: null,
              hasMore: hasMoreInBuffer,
            };
          }

          // We're at the start of the buffer with no older buffer pages.
          // Check if JSONL history exists (e.g. from before a server restart).
          // If it does, use JSONL as the sole history source — it contains the
          // complete conversation including any tasks whose events are also in
          // the buffer. Merging them would cause duplicates.
          // The buffer's lastEventId is still returned so that resumeStream()
          // can gap-fill from the correct point for any in-flight task.
          try {
            const workspace = resolveWorkspace(input.workspaceId);
            if (workspace) {
              const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
              const jsonl = await loadJsonlPage({
                chatId,
                workspacePath: workspace.worktree.path,
                sessionId: input.sessionId,
                pageSize,
                beforeMessageIndex: undefined,
              });
              // Only switch to the JSONL response when JSONL actually has
              // messages — otherwise the buffer is the authoritative source
              // (e.g. agents that don't persist sessions to disk).
              if (jsonl && jsonl.messages.length > 0) {
                return {
                  messages: jsonl.messages,
                  firstEventId: null,
                  lastEventId,
                  firstMessageIndex: jsonl.firstMessageIndex,
                  hasMore: jsonl.hasMore,
                };
              }
            }
          } catch {
            // JSONL lookup failed — return buffer-only results
          }

          return {
            messages: bufferMessages,
            firstEventId,
            lastEventId,
            firstMessageIndex: null,
            hasMore: false,
          };
        }
      }

      // Fallback: no buffer at all (cold path) or explicit JSONL pagination
      // — convert agent's JSONL-based history server-side, sliced to the
      // most recent `pageSize` messages.
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const jsonl = await loadJsonlPage({
        chatId,
        workspacePath: workspace.worktree.path,
        sessionId: input.sessionId,
        pageSize,
        beforeMessageIndex: input.beforeMessageIndex,
      });
      if (!jsonl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Session listing not supported" });
      }
      return {
        messages: jsonl.messages,
        firstEventId: null,
        lastEventId: null,
        firstMessageIndex: jsonl.firstMessageIndex,
        hasMore: jsonl.hasMore,
      };
    }),
});

/**
 * Load a page of session history from the agent's JSONL transcript.
 *
 * The first call (no `beforeMessageIndex`) requests the last `pageSize`
 * messages via `{ tail: pageSize }`. Older pages use `{ offset, limit }`
 * derived from the previous response's `firstMessageIndex`. Adapters
 * over-fetch by one message (the "+1 trick") so the response carries an
 * accurate `hasMore` without requiring a separate `total` count.
 *
 * Returns `null` when the agent does not support session listing.
 */
async function loadJsonlPage(opts: {
  chatId: string;
  workspacePath: string;
  sessionId: string;
  pageSize: number;
  beforeMessageIndex: number | undefined;
}): Promise<{ messages: UIMessage[]; firstMessageIndex: number; hasMore: boolean } | null> {
  const chatSession = getChat(opts.chatId);
  const agent = await getOrCreateAgent(opts.chatId, opts.workspacePath, chatSession?.agent);
  if (!agent.supportedFeatures.sessionListing || !agent.getSessionMessages) {
    return null;
  }

  // Translate the cursor model used by the tRPC endpoint into the agent's
  // tail/offset/limit options. `beforeMessageIndex` is the index *after*
  // the slice, so the slice is `[max(0, before - pageSize), before)`.
  const queryOpts =
    opts.beforeMessageIndex !== undefined
      ? {
          offset: Math.max(0, opts.beforeMessageIndex - opts.pageSize),
          limit: opts.beforeMessageIndex - Math.max(0, opts.beforeMessageIndex - opts.pageSize),
        }
      : { tail: opts.pageSize };

  const {
    messages: slice,
    hasMore,
    firstOffset,
  } = await agent.getSessionMessages(opts.sessionId, opts.workspacePath, queryOpts);

  const messages = convertHistoryToUIMessages(
    slice as {
      role: "user" | "assistant";
      id: string;
      content: {
        type: "text" | "tool_use" | "tool_result";
        text?: string;
        toolCallId?: string;
        toolName?: string;
        displayTitle?: string;
        input?: unknown;
        output?: string;
        isError?: boolean;
      }[];
    }[],
  );
  return { messages, firstMessageIndex: firstOffset, hasMore };
}

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
    return getWorkspaceStatus(input.workspaceId);
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
      const status = upsertWorkspaceStatus(input.workspaceId, input.agent);

      // Emit update directly to SSE listeners
      emit({ kind: "update", status });

      return { ok: true };
    }),

  clearNeedsAttention: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => {
      const existing = getWorkspaceStatus(input.workspaceId);
      if (existing?.agent?.status !== "needs_attention") {
        if (existing) {
          emit({ kind: "update", status: existing });
        }
        return { ok: true };
      }
      const status = upsertWorkspaceStatus(input.workspaceId, { status: "waiting" });
      emit({ kind: "update", status });
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

    opts.signal?.addEventListener("abort", () => {
      unsubscribe();
      resolve?.();
    });

    try {
      while (!opts.signal?.aborted) {
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
      reloadSchedules();
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
      reloadSchedules();
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
      reloadSchedules();
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

      const cronChat = getOrCreateDefaultChat(workspaceId);
      try {
        const task = submitTask({ workspaceId, chatId: cronChat.id, prompt: job.prompt });
        return { taskId: task.id, workspaceId };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this chat pane",
          });
        }
        throw err;
      }
    }),
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const skillsRouter = t.router({
  list: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        return { skills: [] };
      }

      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const chatSession = getChat(chatId);
      const agent = await getOrCreateAgent(chatId, workspace.worktree.path, chatSession?.agent);
      if (agent.listSkills) {
        const skills = await agent.listSkills();
        return { skills };
      }

      return { skills: [] };
    }),
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const modesRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(async ({ input }) => {
      const agent = await createMetadataAgent(input.agentId);
      if (agent.listModes) {
        return { modes: agent.listModes() };
      }
      return { modes: [] };
    }),
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const modelsRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(async ({ input }) => {
      const agent = await createMetadataAgent(input.agentId);
      const models = agent.listModels ? await agent.listModels() : [];
      // Include the agent's configured default model from Band settings
      const settings = loadSettings();
      const agentDef = getAgentDefinition(settings, input.agentId);
      return { models, defaultModel: agentDef.model };
    }),

  /** List all agents with their models — used by the combined agent/model selector. */
  listAll: publicProcedure.query(async () => {
    const settings = loadSettings();
    const codingAgents = settings.codingAgents ?? [];
    const defaultAgentId = settings.defaultCodingAgent ?? codingAgents[0]?.id ?? "";

    const agents = await Promise.all(
      codingAgents.map(async (def) => {
        try {
          const agent = await createMetadataAgent(def.id);
          const models = agent.listModels ? await agent.listModels() : [];
          return {
            agentId: def.id,
            agentType: def.type,
            agentLabel: def.label,
            models,
            defaultModel: def.model,
          };
        } catch {
          return {
            agentId: def.id,
            agentType: def.type,
            agentLabel: def.label,
            models: [],
            defaultModel: def.model,
          };
        }
      }),
    );

    return { agents, defaultAgentId };
  }),
});

// ---------------------------------------------------------------------------
// Chat Layout (split pane tree persistence)
// ---------------------------------------------------------------------------

const chatLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: getChatLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      saveChatLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Chats (multi-pane chat management)
// ---------------------------------------------------------------------------

const chatsRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { chats: listChats(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const chat = createChat(input.workspaceId, {
        id: input.id,
        name: input.name,
        agent: input.agent,
        model: input.model,
        mode: input.mode,
      });
      return { chat };
    }),

  get: publicProcedure.input(z.object({ chatId: z.string() })).query(async ({ input }) => {
    const chat = getChat(input.chatId);
    if (!chat) return { chat: null };

    const workspace = resolveWorkspace(chat.workspaceId);

    // Lazy-resolve case: row has no cached summary yet (post-migration, or
    // a fresh chat with no activeSessionId). Block once on the first read
    // so the client can render a meaningful tab title without waiting for
    // a separate sessions.list. Subsequent reads are pure SQLite.
    if (workspace && (!chat.activeSessionId || chat.activeSessionSummary === undefined)) {
      const resolved = await ensureActiveSessionSummary(input.chatId, workspace.worktree.path);
      if (resolved) {
        return { chat: resolved };
      }
    }

    // Hot path: cached values returned immediately. Kick off a
    // background refresh so the next read picks up any drift (e.g. the
    // user renamed the session via /rename). Errors are swallowed; the
    // refresh will be retried on the next request.
    if (workspace) {
      scheduleActiveSessionRefresh(input.chatId, workspace.worktree.path);
    }

    return { chat };
  }),

  update: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        name: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { chatId, ...updates } = input;
      const chat = updateChat(chatId, updates);
      return { chat };
    }),

  remove: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    removeChat(input.chatId);
    return { ok: true };
  }),

  setActiveSession: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string(),
        sessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Lazily ensure the server-side chat record exists. The client
      // generates chatIds locally, so setActiveSession may be called
      // before the first message is sent (which normally creates the record).
      let chat = getChat(input.chatId);
      if (!chat) {
        chat = createChat(input.workspaceId, { id: input.chatId, name: "Chat" });
      }

      if (!input.sessionId) {
        updateChatActiveSession(input.chatId, undefined);
        return { ok: true };
      }

      // Resolve the summary inline so the persisted row carries a usable
      // tab title from the moment the client switches sessions. If
      // getSessionInfo fails or returns undefined (the JSONL doesn't exist
      // yet for a freshly-created session), persist NULL — the next
      // chats.get's background refresh will catch up.
      const workspace = resolveWorkspace(input.workspaceId);
      let summary: string | undefined;
      let lastModified: number | undefined;
      if (workspace) {
        try {
          const agent = await getOrCreateAgent(input.chatId, workspace.worktree.path, chat.agent);
          const info = await agent.getSessionInfo?.(input.sessionId, workspace.worktree.path);
          summary = info?.summary;
          lastModified = info?.lastModified;
        } catch (err) {
          log.warn(
            { chatId: input.chatId, sessionId: input.sessionId, err },
            "setActiveSession: getSessionInfo failed",
          );
        }
      }

      updateChatActiveSession(input.chatId, {
        activeSessionId: input.sessionId,
        summary,
        lastModified,
      });
      return { ok: true };
    }),

  send: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string(),
        message: z.string(),
        sessionId: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // Lazily ensure the server-side chat record exists. The client
      // generates chatIds locally for instant rendering, so the first
      // message sent may arrive before a record is created.
      let chat = getChat(input.chatId);
      if (!chat) {
        chat = createChat(input.workspaceId, { id: input.chatId, name: "Chat" });
      }
      try {
        const task = submitTask({
          workspaceId: chat.workspaceId,
          chatId: chat.id,
          prompt: input.message,
          sessionId: input.sessionId,
        });
        return { taskId: task.id, sessionId: task.sessionId };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this chat pane",
          });
        }
        throw err;
      }
    }),

  stop: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    abortTask(input.chatId);
    updateChatStatus(input.chatId, "stopped");
    return { ok: true };
  }),

  resume: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    updateChatStatus(input.chatId, "idle");
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Browser Layout (split pane tree persistence)
// ---------------------------------------------------------------------------

const browserLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: getBrowserLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      saveBrowserLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Browsers (multi-tab browser management)
// ---------------------------------------------------------------------------

const browsersRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { browsers: listBrowsers(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // `createBrowser` registers the tab in both the in-memory registry
      // and the saved dockview layout (mirrors `createChat`); no separate
      // `addBrowserToLayout` call needed here.
      const browser = createBrowser(input.workspaceId, {
        id: input.id,
        name: input.name,
        url: input.url,
      });
      emit({ kind: "browser-created", workspaceId: input.workspaceId, browserId: browser.id });
      return { browser };
    }),

  get: publicProcedure.input(z.object({ browserId: z.string() })).query(({ input }) => {
    const browser = getBrowser(input.browserId);
    return { browser: browser ?? null };
  }),

  update: publicProcedure
    .input(
      z.object({
        browserId: z.string(),
        name: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { browserId, ...updates } = input;
      const browser = updateBrowser(browserId, updates);
      return { browser };
    }),

  navigate: publicProcedure
    .input(z.object({ browserId: z.string(), url: z.string() }))
    .mutation(({ input }) => {
      updateBrowserUrl(input.browserId, input.url);
      return { ok: true };
    }),

  remove: publicProcedure.input(z.object({ browserId: z.string() })).mutation(({ input }) => {
    const browser = getBrowser(input.browserId);
    removeBrowser(input.browserId);
    if (browser?.workspaceId) {
      removeBrowserFromLayout(browser.workspaceId, input.browserId);
    }
    emit({
      kind: "browser-removed",
      workspaceId: browser?.workspaceId,
      browserId: input.browserId,
    });
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Queue (persisted queued messages)
// ---------------------------------------------------------------------------

const queueRouter = t.router({
  push: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional(), text: z.string() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      pushQueuedMessage(chatId, input.text);
      return { ok: true, messages: getQueuedMessages(chatId) };
    }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        messages: z.array(z.string()),
      }),
    )
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      setQueuedMessages(chatId, input.messages);
      return { ok: true };
    }),

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const messages = getQueuedMessages(chatId);
      return { messages };
    }),

  remove: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional(), text: z.string() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      removeQueuedMessage(chatId, input.text);
      return { ok: true, messages: getQueuedMessages(chatId) };
    }),

  shift: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const text = shiftQueuedMessage(chatId);
      return { text };
    }),

  clear: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      clearQueuedMessages(chatId);
      return { ok: true };
    }),

  stream: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .subscription(async function* (opts) {
      const chatId = opts.input.chatId ?? getOrCreateDefaultChat(opts.input.workspaceId).id;

      type Update = { messages: string[] };
      const queue: Update[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = subscribeQueue((id, messages) => {
        if (id !== chatId) return;
        queue.push({ messages });
        resolve?.();
      });

      opts.signal?.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      // Emit current state immediately so the client is in sync
      yield { messages: getQueuedMessages(chatId) };

      // Discard notifications that arrived between listener registration
      // and the initial yield — the initial yield already covers them.
      queue.length = 0;

      try {
        while (!opts.signal?.aborted) {
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
// Terminal Layout (split pane tree persistence)
// ---------------------------------------------------------------------------

const terminalLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: getTerminalLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      saveTerminalLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const terminalRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { terminals: listTerminals(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        command: z.string().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const terminalId = input.id ?? randomUUID();
      // `spawnTerminal` registers the session and writes to the saved
      // dockview layout (mirrors `createChat` / `createBrowser`); no
      // separate `addTerminalToLayout` call needed here.
      const session = await spawnTerminal(input.workspaceId, terminalId, {
        command: input.command,
        cwd: input.cwd,
        env: input.env,
      });
      emit({ kind: "terminal-created", workspaceId: input.workspaceId, terminalId });
      return { terminalId, workspaceId: input.workspaceId, pid: session.pty.pid };
    }),

  send: publicProcedure
    .input(z.object({ terminalId: z.string(), data: z.string() }))
    .mutation(({ input }) => {
      const ok = writeToTerminal(input.terminalId, input.data);
      if (!ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Terminal not found: ${input.terminalId}`,
        });
      }
      return { ok: true };
    }),

  output: publicProcedure
    .input(z.object({ terminalId: z.string(), lines: z.number().int().positive().optional() }))
    .query(({ input }) => {
      const output = getScrollback(input.terminalId, input.lines ?? undefined);
      if (output == null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Terminal not found: ${input.terminalId}`,
        });
      }
      return { output };
    }),

  kill: publicProcedure.input(z.object({ terminalId: z.string() })).mutation(({ input }) => {
    const session = getTerminalSession(input.terminalId);
    const workspaceId = session?.workspaceId;
    killTerminal(input.terminalId);
    if (workspaceId) {
      removeTerminalFromLayout(workspaceId, input.terminalId);
      emit({ kind: "terminal-killed", workspaceId, terminalId: input.terminalId });
    }
    return { ok: true };
  }),

  stream: publicProcedure
    .input(
      z.object({
        terminalId: z.string(),
        replay: z.boolean().optional().default(true),
      }),
    )
    .subscription(async function* (opts) {
      const { terminalId, replay } = opts.input;

      // Check if terminal exists
      const session = getTerminalSession(terminalId);
      if (!session) {
        yield { type: "error" as const, data: `Terminal not found: ${terminalId}` };
        return;
      }

      // Replay buffered scrollback first
      if (replay && session.scrollback.length > 0) {
        yield { type: "output" as const, data: session.scrollback };
      }

      // Stream live output
      const queue: string[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = subscribeTerminalOutput(terminalId, (data: string) => {
        queue.push(data);
        resolve?.();
      });

      opts.signal?.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      try {
        while (!opts.signal?.aborted) {
          while (queue.length > 0) {
            yield { type: "output" as const, data: queue.shift()! };
          }

          // Check if terminal is still alive
          if (!getTerminalSession(terminalId)) {
            yield { type: "exit" as const };
            return;
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
  chatLayout: chatLayoutRouter,
  chats: chatsRouter,
  browserLayout: browserLayoutRouter,
  browsers: browsersRouter,
  statuses: statusesRouter,
  status: statusRouter,
  cronjobs: cronjobsRouter,
  skills: skillsRouter,
  modes: modesRouter,
  models: modelsRouter,
  queue: queueRouter,
  terminal: terminalRouter,
  terminalLayout: terminalLayoutRouter,
});

export type AppRouter = typeof appRouter;
