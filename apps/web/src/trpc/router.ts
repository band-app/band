import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@band-app/logger";
import { initTRPC, TRPCError } from "@trpc/server";
import { rgPath } from "@vscode/ripgrep";
import { Cron } from "croner";
import { z } from "zod";
import { formatFileLocation, toWorkspaceId } from "@/dashboard";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/active-workspace";
import {
  createMetadataAgent,
  createWorkspaceAgent,
  getOrCreateAgent,
  replaceAgent,
} from "../lib/agent-pool";
import { getPollerActivity, setPollerActivity } from "../lib/branch-status-poller";
import {
  type ClearRange,
  clearHistory,
  deleteHistoryEntry,
  listHistory,
  recordVisit,
  searchHistory,
  updateVisitMeta,
} from "../lib/browser-history-store";
import {
  type EnsureViewEvent,
  markTargetDestroyed,
  onEnsureView,
  resolveTargetReady,
} from "../lib/browser-host";
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
  InvalidLabelsError,
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
import {
  getOrCreateCronjobChat,
  reloadSchedules,
  resolveCronjobWorkspaceId,
  stopJobsForKey,
} from "../lib/cronjob-scheduler";
import {
  deleteCronjobFile,
  generateCronjobId,
  listAllCronjobs,
  loadCronjobFile,
  saveCronjobFile,
} from "../lib/cronjob-store";
import type { CronjobDefinition } from "../lib/cronjob-types";
import { duBytes } from "../lib/disk-usage";
import { subscribeToFileChanges } from "../lib/file-watcher";
import { FormatterError, formatFile } from "../lib/formatter";
import { fuzzyScore } from "../lib/fuzzy-score";
import { DETACHED_BRANCH_PREFIX, execGit, gitCmd, listWorktrees } from "../lib/git";
import { checkHooks, installHooks } from "../lib/hooks";
import { killWorkspaceServers } from "../lib/lsp-manager";
import { hasPendingInputForWorkspace, resolvePendingInput } from "../lib/pending-inputs";
import { checkPrereqs, shellPath } from "../lib/process-utils";
import { loadProjectConfig } from "../lib/project-config";
import {
  clearQueuedMessages,
  getQueuedMessages,
  pushQueuedMessage,
  type QueuedMessage,
  removeQueuedMessage,
  setQueuedMessages,
  shiftQueuedMessage,
  subscribeQueue,
  toWireQueuedMessages,
  updateQueuedMessage,
} from "../lib/queued-message-store";
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
  type ProjectKind,
  reconcileKindForProject,
  saveSettings,
  saveState,
  upsertWorkspaceStatus,
  worktreesDir,
} from "../lib/state";
import { abortTask, cancelTask, getTask, submitTask, TaskConflictError } from "../lib/task-runner";
import { deleteWorkspaceTasks, listTasks, loadTask } from "../lib/task-store";
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
import { saveUploadedFiles, saveUploadedFilesDetailed } from "../lib/upload-utils";
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

    // Inline, read-only kind re-detection via the shared helper.
    // Persistence lives in `syncWorktrees` (called on every branch-
    // status-poller tick and once at boot from `runFirstTimeSetup`) so
    // this query doesn't write to the DB — but the response still
    // needs to reflect on-disk reality, otherwise a freshly-booted
    // dashboard showing pre-migration "git" rows would render
    // incorrectly until the first poller tick fires AND the next 30 s
    // refetch lands. We discard the return value (not persisting) and
    // just rely on the helper to mutate `project.kind` /
    // `project.worktrees` in place.
    for (const project of state.projects) {
      reconcileKindForProject(project);
    }

    const projects = await Promise.all(
      state.projects.map(async (project) => {
        // Plain projects have a single implicit workspace whose path equals
        // the project path. They don't have a `.git` directory, so we skip
        // the `git worktree list` enrichment entirely and rely on the
        // workspace row that `projects.add` synthesized into state.
        let worktrees = project.worktrees;
        if (project.kind === "git") {
          // state.json is the canonical "tracked workspaces" set — git's view
          // is just used to enrich each entry with current path/head. We
          // intersect the two so a workspace removed from state.json (e.g.
          // by workspaces.remove, which updates state.json synchronously and
          // defers the slow `git worktree remove` / `git branch -D` to a
          // background task) disappears from the list immediately, even
          // before the async cleanup has finished pruning the on-disk
          // worktree. Without this filter, `projects.list` reads stale data
          // from `git worktree list` and shows just-deleted workspaces until
          // the background cleanup completes.
          const trackedBranches = new Set(project.worktrees.map((wt) => wt.branch));
          // Map by branch so we can preserve metadata (e.g. `pinned`) that git
          // doesn't know about when merging git's view with our tracked state.
          const trackedByBranch = new Map(project.worktrees.map((wt) => [wt.branch, wt]));
          try {
            const gitWorktrees = await listWorktrees(project.path);
            worktrees = gitWorktrees
              .filter((wt) => !wt.isBare && trackedBranches.has(wt.branch))
              .map((wt) => ({
                branch: wt.branch,
                path: wt.path,
                head: wt.head,
                pinned: trackedByBranch.get(wt.branch)?.pinned ?? false,
              }));
          } catch {
            // Fall back to state.json worktrees
          }
        }

        return {
          name: project.name,
          path: project.path,
          defaultBranch: project.defaultBranch,
          label: project.label,
          kind: project.kind,
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

      // Detect project kind from the presence of `.git`. Plain (non-git)
      // folders skip the symbolic-ref / listWorktrees probes entirely and
      // get a single synthesized workspace pointing at the project path —
      // this is the whole point of #427: lower the barrier for adding a
      // scratch directory, design docs, or any folder that hasn't been
      // `git init`-ed.
      //
      // Note: `existsSync(.git)` returns true for both directories AND
      // files. Git submodules and secondary worktrees embed a `.git` file
      // (rather than a directory) that points at the parent repo, and
      // we want those classified as "git" too — so a directory-only
      // check would be wrong here.
      const resolvedPath = resolve(input.path);
      const kind: ProjectKind = existsSync(join(resolvedPath, ".git")) ? "git" : "plain";

      let defaultBranch = "main";
      let worktrees: { branch: string; path: string; head?: string; pinned: boolean }[] = [];

      if (kind === "git") {
        try {
          const env = { ...process.env };
          if (env.PATH) {
            env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
          }
          const output = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
            cwd: resolvedPath,
            env,
            encoding: "utf-8",
          }).trim();
          if (output) defaultBranch = output;
        } catch {
          // Fall back to "main"
        }

        try {
          const gitWorktrees = await listWorktrees(resolvedPath);
          worktrees = gitWorktrees
            .filter((wt) => !wt.isBare)
            .map((wt) => ({ branch: wt.branch, path: wt.path, head: wt.head, pinned: false }));
        } catch {
          // No worktrees
        }
      } else {
        // Plain projects get exactly one implicit workspace whose path is
        // the project path. We use "main" as the synthetic branch name so
        // workspaceId stays deterministic (`{name}-main`), even though the
        // folder has no actual branch. UI gating prevents the user from
        // creating other workspaces or invoking branch/PR features.
        //
        // Use `resolvedPath` (not `input.path`) so paths with trailing
        // slashes, `./` prefixes, or `..` segments are normalized — keeps
        // the stored workspace path consistent with the `.git` probe and
        // with the implicit assumption elsewhere that workspace paths are
        // canonical.
        worktrees = [{ branch: "main", path: resolvedPath, pinned: false }];
      }

      const project = {
        name,
        // Store the canonical path so downstream consumers
        // (cronjob-scheduler, branch-status-poller, etc.) and the
        // self-heal loop in projects.list can compare against
        // `existsSync(project.path)` without false negatives from
        // unnormalized input.
        path: resolvedPath,
        defaultBranch,
        worktrees,
        label: input.label ?? undefined,
        kind,
        // For git projects, default to `true` so the first CI poll
        // still runs the GraphQL query — `syncWorktrees` writes the
        // real value on the next tick. For plain projects there's no
        // remote by construction, so set `false` directly: sync skips
        // plain projects (`kind !== "plain"` filter), so this initial
        // value sticks for the lifetime of the row. See issue #458.
        hasOrigin: kind === "git",
      };

      state.projects.push(project);
      saveState(state);

      return project;
    }),

  /**
   * Run `git init` inside a plain project and flip its kind to "git".
   * The "promote to git" escape hatch from #427: lets a user start with a
   * plain folder and later opt into branches/PRs without re-adding the
   * project. After promotion, the existing implicit workspace becomes the
   * project's default-branch worktree (its path is already the project
   * path, which matches git's convention for the main worktree).
   */
  promoteToGit: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      const state = loadState();
      const project = state.projects.find((p) => p.name === input.name);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Project "${input.name}" not found`,
        });
      }
      if (project.kind === "git") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.name}" is already a git project`,
        });
      }
      // Pre-flight: if the folder was moved/deleted between `projects.add`
      // and the promote click, `execGit` would surface a raw subprocess
      // ENOENT ("cannot change to '...'") with no diagnostic context.
      // Bail with a clear message instead so the user knows to re-add.
      if (!existsSync(project.path)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Project path "${project.path}" no longer exists. Remove the project and re-add it.`,
        });
      }

      // `git init -b main` pins HEAD to refs/heads/main so the implicit
      // "main" workspace's branch matches the repo's HEAD regardless of
      // the user's `init.defaultBranch` config. Without this, a user whose
      // git defaults to "master" would end up with a workspaceId
      // (`{name}-main`) that doesn't correspond to any real branch.
      // `git init` is idempotent — if `.git` somehow appeared between the
      // initial `projects.add` probe and now, this is a no-op rather than
      // an error.
      //
      // The on-disk `.git` is created BEFORE saveState persists `kind:
      // "git"`. If the process crashes in this window, the next
      // `projects.list` will self-heal (see the kind re-detection loop
      // there): the folder has `.git` so the recorded kind flips to
      // "git" automatically. So the non-atomic ordering is intentional
      // and self-correcting; don't reorder.
      await execGit(["init", "-b", "main"], project.path);

      project.kind = "git";
      project.defaultBranch = "main";
      saveState(state);

      return { ok: true, kind: project.kind, defaultBranch: project.defaultBranch };
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

      // Plain projects have exactly one implicit workspace, created at
      // project-add time. Creating additional workspaces is meaningless
      // without git worktrees, so reject the call as a backstop — the UI
      // should already be hiding the "New workspace" button.
      if (proj.kind === "plain") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.project}" is a plain (non-git) folder and cannot have additional workspaces. Promote it to git (right-click the project → "Promote to git") to enable branches.`,
        });
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

      proj.worktrees.push({ branch: input.branch, path: worktreePath, pinned: false });
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
    .mutation(async ({ input }) => {
      const state = loadState();
      const proj = state.projects.find((p) => p.name === input.project);
      if (!proj) {
        throw new Error(`Project "${input.project}" not found`);
      }

      // Plain projects can't have their (single, implicit) workspace
      // removed — the workspace is the project. The user must remove the
      // project entirely instead.
      if (proj.kind === "plain") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.project}" is a plain (non-git) project. Remove the project instead of the workspace.`,
        });
      }

      const { command, env: gitEnv } = gitCmd();

      // Resolve the worktree path via `listWorktrees` rather than re-parsing
      // `git worktree list --porcelain` inline. `listWorktrees` applies the
      // detached-HEAD → `detached-<short-sha>` fallback that the rest of the
      // app sees in `proj.worktrees` and that the dashboard sends back here
      // as `input.branch`. Re-parsing porcelain without the fallback would
      // leave `currentBranch === ""` for detached worktrees and fall through
      // to the "Workspace not found" throw below, breaking the "Delete
      // workspace" context-menu action on every detached-HEAD card.
      const worktrees = await listWorktrees(proj.path);
      const match = worktrees.find((wt) => wt.branch === input.branch);
      if (!match) {
        throw new Error(`Workspace "${input.branch}" not found`);
      }
      const worktreePath = match.path;

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

      // Delete persisted task history for the workspace (issue #416).
      // Tasks aren't covered by a FK cascade because workspaces aren't a
      // first-class DB row, so the cleanup is explicit here next to the
      // other workspace-scoped removals. Task cleanup is best-effort —
      // a DB lock or WAL timeout must not abort the whole removal or
      // suppress the `emit` below, otherwise the dashboard would keep
      // showing the just-deleted workspace.
      try {
        const deletedTasks = deleteWorkspaceTasks(workspaceId);
        if (deletedTasks > 0) {
          log.info({ workspaceId, count: deletedTasks }, "deleted workspace tasks on removal");
        }
      } catch (err) {
        log.error({ workspaceId, err }, "failed to delete workspace tasks on removal");
      }

      // Notify subscribers (dashboard status stream) that this workspace is gone
      emit({ kind: "remove", workspaceId });

      // ── Background cleanup: slow git/fs operations ──
      const projPath = proj.path;
      // Synthetic "detached-<short-sha>" labels generated by
      // `listWorktrees` for detached-HEAD worktrees do not correspond to a
      // real git ref. Trying to `git branch -D detached-abc1234` would error
      // ("branch not found") — the catch below swallows it cleanly, but
      // skipping the call up front keeps the background logs free of
      // noise that's hard to distinguish from a genuine problem.
      const branchToDelete = match.branch.startsWith(DETACHED_BRANCH_PREFIX) ? null : input.branch;
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

          if (branchToDelete) {
            try {
              await execFileAsync(command, ["branch", "-D", branchToDelete], {
                cwd: projPath,
                env: gitEnv,
                encoding: "utf-8",
              });
            } catch {
              // Branch may already be deleted
            }
          }
        })().catch((err) => {
          log.error({ err, workspaceId }, "background workspace cleanup failed");
        });
      });

      return { ok: true };
    }),

  setPinned: publicProcedure
    .input(z.object({ project: z.string(), branch: z.string(), pinned: z.boolean() }))
    .mutation(({ input }) => {
      const state = loadState();
      const proj = state.projects.find((p) => p.name === input.project);
      if (!proj) {
        throw new Error(`Project "${input.project}" not found`);
      }
      // Plain (non-git) projects don't surface in the Pinned section —
      // they're already flat at the project level — so pinning has no
      // visible effect and accidentally leaving `pinned=true` strands the
      // UI with an empty `worktrees` array. Reject the call as a backstop;
      // the UI also omits the menu item.
      if (proj.kind === "plain") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.project}" is a plain (non-git) project. Pinning is not available.`,
        });
      }
      const wt = proj.worktrees.find((w) => w.branch === input.branch);
      if (!wt) {
        throw new Error(`Workspace "${input.branch}" not found`);
      }
      wt.pinned = input.pinned;
      saveState(state);
      return { ok: true };
    }),

  gitPull: publicProcedure
    .input(z.object({ project: z.string(), branch: z.string() }))
    .mutation(async ({ input }) => {
      const workspaceId = toWorkspaceId(input.project, input.branch);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      if (workspace.project.kind === "plain") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.project}" is a plain (non-git) project. Git pull is not available.`,
        });
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
      if (workspace.project.kind === "plain") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project "${input.project}" is a plain (non-git) project. Git push is not available.`,
        });
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

// ---------------------------------------------------------------------------
// Workspace diff helpers
// ---------------------------------------------------------------------------

/**
 * Branch names accepted by diff/revert procedures. Forbids leading `-` so the
 * value can't be interpreted by git as a flag (e.g. `--upload-pack=`, `--exec=`)
 * when it lands in `git merge-base <branch> HEAD` or `git checkout <branch> -- file`.
 * The trpc server is local-only, but `execFile` doesn't pass through a shell, so
 * a leading-dash check is enough to close the only realistic injection vector.
 */
const compareBranchSchema = z
  .string()
  .min(1)
  .regex(/^[^-]/, "branch name must not start with '-'")
  .optional();

const EMPTY_TREE_ARGS = ["hash-object", "-t", "tree", "/dev/null"];

/**
 * The canonical SHA of git's empty *tree* object — built into git
 * itself (every git version exposes this hash whether or not any
 * objects have been created locally). We use it as the `mergeBase`
 * sentinel for non-git workspaces so the field always carries a real
 * 40-char SHA shape, which a downstream consumer that does string
 * validation (length / hex check) on `mergeBase` won't choke on.
 *
 * Note this is a tree, not a commit — `git diff` accepts either, but
 * callers that strictly expect a commit-ish (e.g. `git merge-base
 * <sha> HEAD`) will reject it. The DiffView guards against ever
 * passing this through for a plain project via its `isPlain` check;
 * other potential consumers should treat this as "empty diff,
 * intentionally" rather than a usable commit reference.
 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface DiffContext {
  /** Resolved compare branch — defaults to project default. */
  compareBranch: string;
  /** Current branch name, or `defaultBranch` if HEAD is detached / unborn. */
  headBranch: string;
  /** Commit/tree to diff against. */
  mergeBase: string;
}

/**
 * Resolves the `(headBranch, mergeBase, compareBranch)` triple shared by
 * `getDiff`, `getDiffSummary`, and `revertFile`. Falls back to the empty tree
 * when the workspace has no commits yet (so brand-new repos don't 500).
 */
async function resolveDiffContext(
  cwd: string,
  defaultBranch: string,
  diffMode: "uncommitted" | "branch",
  compareBranchInput: string | undefined,
): Promise<DiffContext> {
  const compareBranch =
    diffMode === "uncommitted" ? defaultBranch : (compareBranchInput ?? defaultBranch);

  let headBranch: string;
  try {
    headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
  } catch {
    headBranch = defaultBranch;
  }

  let mergeBase: string;
  if (diffMode === "uncommitted") {
    try {
      mergeBase = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  } else {
    try {
      mergeBase = (await execGit(["merge-base", compareBranch, "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  }

  return { compareBranch, headBranch, mergeBase };
}

/** Parses the trailing summary line of `git diff --stat`. */
function parseDiffStatSummary(statOutput: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const statLines = statOutput.trim().split("\n");
  const summaryLine = statLines[statLines.length - 1] || "";

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
  };
}

/** Builds the `path -> status code` map from `git diff --name-status`. */
function parseFileStatuses(nameStatusOutput: string): Record<string, string> {
  const fileStatuses: Record<string, string> = {};
  for (const line of nameStatusOutput.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const statusCode = parts[0][0];
    if (statusCode === "R" && parts[2]) {
      fileStatuses[parts[2]] = "R";
    } else if (parts[1]) {
      fileStatuses[parts[1]] = statusCode;
    }
  }
  return fileStatuses;
}

/** Reads an untracked file as the lines that would appear in a synthesized diff. */
async function readUntrackedFileLines(cwd: string, file: string): Promise<string[] | null> {
  try {
    const content = await readFile(join(cwd, file), "utf-8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  } catch {
    // Skip binary or unreadable files
    return null;
  }
}

const workspaceRouter = t.router({
  getTerminalConfig: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) return { config: null };
      const config = loadWorkspaceTerminalConfig(workspace.worktree.path, workspace.project.path);
      return { config };
    }),

  /**
   * Format the supplied `content` using Prettier as if it were the file at
   * `filePath` inside `workspaceId`. The procedure is pure — it does not
   * read or write the file on disk. The client passes in the live editor
   * buffer and applies the returned `formatted` string back to the editor.
   * Persistence is the caller's responsibility via `workspace.saveFile`.
   *
   * Returns `{ skipped: true, reason }` when Prettier has no parser for
   * the file's extension (or it's covered by `.prettierignore`). Editors
   * fire this off Shift+Alt+F without checking the file type first, so a
   * soft skip is the right outcome for unsupported files rather than a
   * surfaced error.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts) — same
   * pattern as the rest of `workspaceRouter`.
   */
  formatFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string().min(1),
        // 1 MB ceiling — covers every realistic source file (the largest
        // human-authored .ts in the world is well under 500 KB) and stops a
        // pathological caller from blocking the event loop with a multi-MB
        // string while Prettier churns on it.
        content: z.string().max(1_000_000),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace ${input.workspaceId} not found`,
        });
      }
      try {
        return await formatFile(workspace.worktree.path, input.filePath, input.content);
      } catch (err) {
        if (err instanceof FormatterError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err.message,
            cause: err,
          });
        }
        throw err;
      }
    }),

  /**
   * Subscribe to external file-system changes inside a single workspace.
   * The watcher is started on demand for that workspace and torn down when
   * the last subscriber disconnects, so we don't keep OS watch handles
   * open on every worktree the user has ever added (see issue #384).
   *
   * Yields one event per coalesced (parentDir) change; `path` is the
   * workspace-relative parent directory ("" for the worktree root). The
   * FileBrowser uses it as a cache invalidation key.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts), so no
   * per-procedure guard is needed — consistent with the rest of
   * `workspaceRouter`.
   */
  fileChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .subscription(async function* (opts) {
      // We rely on the tRPC adapter supplying a cancellation signal — both
      // the WebSocket and HTTP transports we use today set it on every
      // subscription. Fail loud if a future adapter omits it rather than
      // silently parking this generator forever.
      if (!opts.signal) {
        throw new Error(
          "workspace.fileChanges requires a cancellable subscription (opts.signal missing)",
        );
      }
      const signal = opts.signal;

      const queue: { path: string }[] = [];
      let resolve: (() => void) | null = null;
      // Set to true if the underlying watcher dies — the generator then
      // finishes cleanly so the client sees the stream complete instead
      // of waiting forever for an event from a dead handle.
      let watcherClosed = false;

      const unsubscribe = subscribeToFileChanges(opts.input.workspaceId, (path) => {
        if (path === null) {
          watcherClosed = true;
        } else {
          queue.push({ path });
        }
        resolve?.();
      });

      // Only unpark the generator here; the watcher tear-down lives in
      // `finally` so we don't risk a double-unsubscribe if abort fires
      // before the loop's last cleanup.
      const onAbort = () => resolve?.();
      signal.addEventListener("abort", onAbort);

      try {
        while (!signal.aborted && !watcherClosed) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (signal.aborted || watcherClosed) break;
          await new Promise<void>((r) => {
            resolve = r;
            // Close the race where abort/watcher-close fires between
            // `resolve = null` and entering this executor: in that
            // window the upstream `resolve?.()` was a no-op, so wake
            // immediately ourselves.
            if (signal.aborted || watcherClosed) r();
          });
          resolve = null;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    }),

  listBranches: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;

      let headBranch: string | null = null;
      try {
        headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      } catch {
        // No commits yet — leave headBranch null
      }

      let branches: string[] = [];
      try {
        const output = await execGit(
          ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
          cwd,
        );
        branches = output
          .trim()
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean);
      } catch (err) {
        log.error(
          `listBranches: for-each-ref failed for ${cwd}: ${err instanceof Error ? err.message : err}`,
        );
      }

      // Drop the current branch (you don't compare against yourself) and pin
      // the default branch to the front. When you're on the default branch,
      // skip the re-add — comparing main↔main is a no-op and confusing.
      const filtered = branches.filter((b) => b !== headBranch);
      if (defaultBranch !== headBranch) {
        const idx = filtered.indexOf(defaultBranch);
        if (idx >= 0) {
          filtered.splice(idx, 1);
        }
        filtered.unshift(defaultBranch);
      }

      return {
        branches: filtered,
        defaultBranch,
        headBranch: headBranch ?? defaultBranch,
      };
    }),

  getDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;
      const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
        cwd,
        defaultBranch,
        input.diffMode ?? "branch",
        input.compareBranch,
      );

      const diffArgs = ["diff"];
      if (input.contextLines !== undefined) {
        diffArgs.push(`-U${input.contextLines}`);
      }
      diffArgs.push(mergeBase);
      let diff = await execGit(diffArgs, cwd);

      const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
      const stats = parseDiffStatSummary(statOutput);

      const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
      const fileStatuses = parseFileStatuses(nameStatusOutput);

      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      for (const file of untrackedFiles) {
        const lines = await readUntrackedFileLines(cwd, file);
        if (lines === null) continue;
        diff += `diff --git a/${file} b/${file}\n`;
        diff += "new file mode 100644\n";
        diff += "--- /dev/null\n";
        diff += `+++ b/${file}\n`;
        diff += `@@ -0,0 +1,${lines.length} @@\n`;
        diff += lines.map((l) => `+${l}`).join("\n");
        diff += "\n";
        stats.filesChanged++;
        stats.insertions += lines.length;
        fileStatuses[file] = "U";
      }

      return {
        diff,
        stats,
        // `compareBranch` is the branch we diffed against (the user's pick, or
        // the project default). `defaultBranch` is the project default. They
        // diverge once a non-default branch is picked.
        compareBranch,
        defaultBranch,
        headBranch,
        fileStatuses,
      };
    }),

  getDiffSummary: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      // Plain (non-git) projects have no diff to compute. Return an empty
      // summary instead of throwing so the UI can show a calm message
      // rather than a raw git error — see #427.
      //
      // Also short-circuit when the worktree's `.git` is missing on disk
      // regardless of the recorded kind. The kind field can lag reality
      // (e.g. a project added before the migration shipped, or a folder
      // whose `.git` was deleted from a terminal) — in either case
      // running `execGit(...)` would surface as a raw error in the
      // Changes view. The next `projects.list` self-heals kind, but
      // until then we still want a graceful empty diff.
      const hasGit = existsSync(join(workspace.worktree.path, ".git"));
      if (workspace.project.kind === "plain" || !hasGit) {
        const defaultBranch = workspace.project.defaultBranch;
        return {
          stats: { filesChanged: 0, insertions: 0, deletions: 0 },
          compareBranch: defaultBranch,
          defaultBranch,
          headBranch: defaultBranch,
          fileStatuses: {},
          mergeBase: EMPTY_TREE_SHA,
        };
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;
      const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
        cwd,
        defaultBranch,
        input.diffMode ?? "branch",
        input.compareBranch,
      );

      const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
      const stats = parseDiffStatSummary(statOutput);

      const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
      const fileStatuses = parseFileStatuses(nameStatusOutput);

      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      for (const file of untrackedFiles) {
        const lines = await readUntrackedFileLines(cwd, file);
        if (lines === null) continue;
        stats.filesChanged++;
        stats.insertions += lines.length;
        fileStatuses[file] = "U";
      }

      return {
        stats,
        compareBranch,
        defaultBranch,
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
        compareBranch: compareBranchSchema,
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

      // Reuse the shared resolver so the reference commit matches what
      // getDiff/getDiffSummary computed — otherwise revert can drift.
      const { mergeBase: ref } = await resolveDiffContext(
        cwd,
        workspace.project.defaultBranch,
        diffMode,
        input.compareBranch,
      );

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

  gitPull: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["pull", "--rebase"], cwd);
      } catch (e) {
        // git pull --rebase can exit non-zero with "Cannot rebase onto multiple
        // branches" when the fetch step already fast-forwarded the working
        // tree. The pull effectively succeeded, so swallow that specific case
        // — same behaviour as the project-keyed `workspaces.gitPull` endpoint.
        const msg = String(e);
        if (msg.includes("Cannot rebase onto multiple branches")) {
          return { ok: true };
        }
        throw new Error(e instanceof Error ? e.message : msg);
      }
      return { ok: true };
    }),

  gitPush: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["push"], cwd);
      } catch {
        // First push may need to set upstream. Resolve the live HEAD branch
        // rather than trusting a stale state.json entry — the worktree may
        // have been renamed via `git branch -m` and the project record not
        // yet refreshed.
        let headBranch: string;
        try {
          headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
        } catch {
          headBranch = workspace.worktree.branch;
        }
        try {
          await execGit(["push", "--set-upstream", "origin", headBranch], cwd);
        } catch (e2) {
          throw new Error(e2 instanceof Error ? e2.message : String(e2));
        }
      }
      return { ok: true };
    }),

  gitCommit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        message: z.string().min(1, "commit message is required"),
        body: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;

      // Stage everything (tracked + untracked) so the commit reflects the
      // diff the user just reviewed in the Changes view.
      await execGit(["add", "-A"], cwd);

      // Pass title + body as separate `-m` args so git formats them with the
      // standard blank-line separator between subject and body.
      const args = ["commit", "-m", input.message];
      const body = input.body?.trim();
      if (body) {
        args.push("-m", body);
      }
      try {
        await execGit(args, cwd);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }
      return { ok: true };
    }),

  generateCommitMessage: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;

      // Cheap pre-flight: refuse early if there are no pending changes so we
      // don't spin up an agent process just to have it report "nothing to
      // commit". `git status --porcelain` covers staged, unstaged, and
      // untracked files in one call.
      try {
        const status = await execGit(["status", "--porcelain"], cwd);
        if (!status.trim()) {
          throw new Error("No changes to summarise");
        }
      } catch (e) {
        // Re-throw the explicit "no changes" error; swallow other status
        // failures (e.g. unborn HEAD on a brand-new repo) and let the agent
        // figure it out.
        if (e instanceof Error && e.message === "No changes to summarise") {
          throw e;
        }
      }

      const settings = loadSettings();
      const agentDef = getAgentDefinition(settings);

      // The agent runs in the workspace's worktree and has Bash/Read tools,
      // so it can explore the changes directly — `git diff HEAD`,
      // `git status`, peek at related files, check recent commit style, etc.
      // This produces better messages than feeding a (potentially truncated)
      // serialised diff in the prompt.
      const prompt = [
        "You are running inside a git workspace. Write a commit message for the changes that are pending in this workspace right now.",
        "",
        "Steps:",
        "  1. Run `git status` and `git diff HEAD` (and `git diff --stat` if the diff is large) to understand what changed.",
        "  2. If helpful, read a few of the changed files or recent commits (`git log -5 --oneline`) to match the project's commit style.",
        "  3. Write a single commit message.",
        "",
        "Format:",
        "  - First line: a concise subject (≤ 72 chars), imperative mood, no trailing period.",
        "  - Then a blank line.",
        "  - Then a body that explains *why* the change is being made and any notable details.",
        "",
        "Output ONLY the final commit message as plain text — no markdown fences, no preamble, no commentary, no tool-call summaries. Do not modify any files.",
      ].join("\n");

      let agent: Awaited<ReturnType<typeof createWorkspaceAgent>>;
      try {
        agent = await createWorkspaceAgent(cwd, agentDef.id);
      } catch (e) {
        throw new Error(
          `Failed to start coding agent "${agentDef.label}": ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      // Track only text emitted by the *final* assistant turn — earlier
      // text deltas are usually narration around tool calls ("Let me check
      // the diff…") that we don't want in the commit message. Each
      // tool-result event resets the buffer so only post-tool prose
      // survives. `maxTurns` is generous enough for git status + diff +
      // optional log + final write-up.
      let lastTurnText = "";
      try {
        for await (const event of agent.runSession(prompt, undefined, {
          maxTurns: 8,
        })) {
          if (event.type === "text-delta") {
            lastTurnText += event.text;
          } else if (event.type === "tool-result") {
            lastTurnText = "";
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      } finally {
        agent.abort?.();
      }

      const cleaned = lastTurnText.trim();
      if (!cleaned) {
        throw new Error("Agent returned an empty response");
      }

      // Split into subject + body on the first blank line.
      const lines = cleaned.split("\n");
      const subject = (lines.shift() ?? "").trim();
      // Drop a leading blank line if present so the body doesn't start empty.
      while (lines.length > 0 && lines[0].trim() === "") {
        lines.shift();
      }
      const body = lines.join("\n").trim();

      return {
        message: subject,
        body,
        agentLabel: agentDef.label,
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

  createFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string().default(""),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      if (existsSync(target)) {
        throw new Error("A file or directory already exists at this path");
      }

      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new Error("Parent directory does not exist");
      }
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent is not a directory");
      }

      await writeFile(target, input.content, { encoding: "utf-8", flag: "wx" });

      return { ok: true };
    }),

  createDirectory: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      if (existsSync(target)) {
        throw new Error("A file or directory already exists at this path");
      }

      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new Error("Parent directory does not exist");
      }
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent is not a directory");
      }

      await mkdir(target);

      return { ok: true };
    }),

  deletePath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      // Refuse to delete the .git metadata folder — destroying it would
      // corrupt the worktree.
      const relative = target.slice(root.length + 1);
      if (relative === ".git" || relative.startsWith(".git/")) {
        throw new Error("Refusing to delete .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(target);
      } catch {
        throw new Error("Path does not exist");
      }

      // `rm` with `recursive` handles both files and directories. We pass
      // it unconditionally so callers don't need to know the entry kind.
      await rm(target, { recursive: true, force: false });

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
    }),

  renamePath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const fromTarget = resolve(join(root, input.fromPath));
      const toTarget = resolve(join(root, input.toPath));

      if (!fromTarget.startsWith(root) || fromTarget === root) {
        throw new Error("Invalid source path");
      }
      if (!toTarget.startsWith(root) || toTarget === root) {
        throw new Error("Invalid destination path");
      }
      if (fromTarget === toTarget) {
        throw new Error("Source and destination are the same");
      }

      // Block touching .git on either side — corrupting it would break
      // the entire worktree.
      const fromRel = fromTarget.slice(root.length + 1);
      const toRel = toTarget.slice(root.length + 1);
      if (
        fromRel === ".git" ||
        fromRel.startsWith(".git/") ||
        toRel === ".git" ||
        toRel.startsWith(".git/")
      ) {
        throw new Error("Refusing to rename .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(fromTarget);
      } catch {
        throw new Error("Source path does not exist");
      }

      if (existsSync(toTarget)) {
        throw new Error("A file or directory already exists at the destination");
      }

      const toParent = dirname(toTarget);
      if (!existsSync(toParent)) {
        throw new Error("Destination parent directory does not exist");
      }
      const toParentStat = await stat(toParent);
      if (!toParentStat.isDirectory()) {
        throw new Error("Destination parent is not a directory");
      }

      await rename(fromTarget, toTarget);

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
    }),

  copyPath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const fromTarget = resolve(join(root, input.fromPath));
      const toTarget = resolve(join(root, input.toPath));

      if (!fromTarget.startsWith(root) || fromTarget === root) {
        throw new Error("Invalid source path");
      }
      if (!toTarget.startsWith(root) || toTarget === root) {
        throw new Error("Invalid destination path");
      }
      if (fromTarget === toTarget) {
        throw new Error("Source and destination are the same");
      }

      // Block touching .git on either side — corrupting it would break
      // the entire worktree.
      const fromRel = fromTarget.slice(root.length + 1);
      const toRel = toTarget.slice(root.length + 1);
      if (
        fromRel === ".git" ||
        fromRel.startsWith(".git/") ||
        toRel === ".git" ||
        toRel.startsWith(".git/")
      ) {
        throw new Error("Refusing to copy .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(fromTarget);
      } catch {
        throw new Error("Source path does not exist");
      }

      // Block copying a directory into itself or any descendant — would
      // either fail mid-copy or produce an infinite tree.
      if (entryStat.isDirectory() && toTarget.startsWith(fromTarget + sep)) {
        throw new Error("Cannot copy a directory into itself");
      }

      if (existsSync(toTarget)) {
        throw new Error("A file or directory already exists at the destination");
      }

      const toParent = dirname(toTarget);
      if (!existsSync(toParent)) {
        throw new Error("Destination parent directory does not exist");
      }
      const toParentStat = await stat(toParent);
      if (!toParentStat.isDirectory()) {
        throw new Error("Destination parent is not a directory");
      }

      // `cp` with `recursive: true` handles both files and directories.
      // `errorOnExist: true` guards against the race between our
      // existsSync check above and the write.
      await cp(fromTarget, toTarget, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
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

      // ripgrep is preferred over `git grep` here because git grep only sees
      // files in the index. Band workspaces frequently contain untracked
      // files (agents create files that aren't yet `git add`-ed) and those
      // would otherwise be invisible to find-in-files. ripgrep respects
      // `.gitignore` by default, matching git grep's effective filter for
      // tracked files while also surfacing untracked-but-not-ignored ones.
      const args: string[] = [];
      if (!input.caseSensitive) args.push("--ignore-case");
      if (input.wholeWord) args.push("--word-regexp");
      if (!input.regex) args.push("--fixed-strings");
      args.push("--json");
      // Pass the cwd as an explicit search path. Without a path argument,
      // ripgrep reads from stdin when its stdin is not a tty — under
      // `spawn` (which defaults to a piped stdin) that hangs forever.
      args.push("--", input.query, "./");

      return await new Promise<{
        results: Array<{ file: string; line: number; content: string }>;
      }>((resolvePromise, rejectPromise) => {
        const results: Array<{ file: string; line: number; content: string }> = [];
        // `stdio: ['ignore', 'pipe', 'pipe']` also closes stdin so ripgrep
        // can't fall back into stdin-reading mode.
        const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;
        let killed = false;

        const finish = (value: typeof results) => {
          if (settled) return;
          settled = true;
          resolvePromise({ results: value });
        };

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          rejectPromise(err);
        };

        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          if (settled) return;
          stdoutBuf += chunk;
          // ripgrep --json emits one JSON object per line.
          while (true) {
            const nlIdx = stdoutBuf.indexOf("\n");
            if (nlIdx === -1) break;
            const line = stdoutBuf.slice(0, nlIdx);
            stdoutBuf = stdoutBuf.slice(nlIdx + 1);
            if (!line) continue;

            let event: {
              type?: string;
              data?: {
                path?: { text?: string };
                line_number?: number;
                lines?: { text?: string };
              };
            };
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            if (event.type !== "match") continue;
            const data = event.data;
            if (!data) continue;
            const rawFile = data.path?.text;
            const lineNumber = data.line_number;
            const rawContent = data.lines?.text;
            // Non-UTF-8 paths/lines come back as `bytes` (base64) instead of
            // `text`. Skip those — they're rare in workspaces and the UI
            // can't render them sensibly.
            if (!rawFile || typeof lineNumber !== "number" || rawContent === undefined) {
              continue;
            }
            // ripgrep prefixes paths with the search root we passed (`./`).
            // Strip that to match the workspace-relative paths returned by
            // `workspace.searchFiles` (`git ls-files`).
            const file = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile;
            const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
            results.push({ file, line: lineNumber, content });

            if (results.length >= input.limit) {
              killed = true;
              child.kill("SIGTERM");
              finish(results);
              return;
            }
          }
        });

        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => {
          stderrBuf += chunk;
        });

        child.on("error", (err) => {
          fail(err);
        });

        child.on("close", (code) => {
          if (settled) return;
          // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error.
          // Both 0 and 1 are valid "no failure" outcomes for our purposes.
          if (code === 0 || code === 1 || killed) {
            finish(results);
          } else {
            fail(new Error(`ripgrep exited with code ${code}: ${stderrBuf.trim()}`));
          }
        });
      });
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
// Host (external file operations — outside any workspace root)
// ---------------------------------------------------------------------------

/**
 * Read/write files identified by an absolute filesystem path, with no
 * workspace-root containment check. Backs the editor's "Open File…"
 * action: users pick a file via the desktop file picker and edit it
 * in a Band editor tab even though it sits outside the current
 * workspace.
 *
 * Security model:
 *   - The `band_token` cookie/header is enforced at the transport
 *     layer (see start-server.ts), so only the local desktop user
 *     can call these procedures.
 *   - These procedures intentionally bypass the workspace-relative
 *     path traversal guard used by `workspace.getFile` /
 *     `workspace.saveFile`. The renderer is expected to source paths
 *     from the OS file picker, but the server cannot prove that — a
 *     bearer of the token can call `host.saveFile` with any absolute
 *     path. This matches the existing trust boundary of the dashboard
 *     (which already gives the token holder read/write across every
 *     registered worktree) and is acceptable for a single-user
 *     personal-tool model.
 *   - Symlinks are rejected. `stat()` follows symlinks, so a symlink
 *     to `/etc/passwd` (or similar) would satisfy `isFile()` and we'd
 *     happily read/write the target. Open paths with `O_NOFOLLOW` so
 *     the kernel itself refuses to traverse a symlink, eliminating
 *     the TOCTOU window between an `lstat()` check and the subsequent
 *     read/write (an attacker swapping the file for a symlink between
 *     those two syscalls would otherwise slip through).
 *   - Inputs must be absolute paths to regular files. Directories,
 *     symlinks, sockets, devices, FIFOs are all rejected.
 *
 * Cross-platform note: `O_NOFOLLOW` is available on macOS/Linux (the
 * platforms Band's `package.json` declares); Windows lacks a direct
 * equivalent and is explicitly out of scope here.
 */
function mapFsError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new Error("File not found");
  if (code === "ELOOP") return new Error("Symbolic links are not allowed");
  if (code === "EACCES" || code === "EPERM") return new Error("Permission denied");
  if (code === "EISDIR") return new Error("Cannot operate on a directory");
  return err as Error;
}

const hostRouter = t.router({
  readFile: publicProcedure
    .input(z.object({ absolutePath: z.string().min(1) }))
    .query(async ({ input }) => {
      const target = input.absolutePath;
      if (!isAbsolute(target)) {
        throw new Error("Absolute path required");
      }

      // O_RDONLY | O_NOFOLLOW: refuse to traverse a symlink. The kernel
      // returns ELOOP if the final path component is a symlink, which
      // we surface as "Symbolic links are not allowed" via mapFsError.
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (err) {
        throw mapFsError(err);
      }
      try {
        const stats = await fh.stat();
        if (stats.isDirectory()) {
          throw new Error("Cannot operate on a directory");
        }
        if (!stats.isFile()) {
          throw new Error("Not a regular file");
        }
        const size = stats.size;

        if (size > MAX_FILE_SIZE) {
          return { tooLarge: true as const, size };
        }

        // Sample the first 8KB to detect binary content before allocating
        // a buffer for the full file. For a binary file that's the whole
        // story; for a text file we then read the rest.
        const sampleLen = Math.min(8192, size);
        const sample = Buffer.alloc(sampleLen);
        if (sampleLen > 0) {
          await fh.read(sample, 0, sampleLen, 0);
          if (sample.includes(0)) {
            return { binary: true as const, size };
          }
        }

        const buffer = await fh.readFile();
        const ext = extname(target).toLowerCase();
        const language = LANG_MAP[ext];

        return {
          content: buffer.toString("utf-8"),
          size,
          language,
        };
      } finally {
        await fh.close();
      }
    }),

  saveFile: publicProcedure
    .input(
      z.object({
        absolutePath: z.string().min(1),
        // Match the read-side cap so a misbehaving client can't fill
        // disk via the save endpoint while the read endpoint refuses
        // anything that wide.
        content: z.string().max(MAX_FILE_SIZE),
      }),
    )
    .mutation(async ({ input }) => {
      const target = input.absolutePath;
      if (!isAbsolute(target)) {
        throw new Error("Absolute path required");
      }

      // O_WRONLY | O_TRUNC | O_NOFOLLOW: open the existing file
      // exclusively for writing (no symlink traversal, no follow-up
      // syscall window for an attacker to swap a symlink in). Crucially
      // we do NOT pass O_CREAT — saveFile is a write-back of an
      // existing file, not a create.
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(
          target,
          fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        );
      } catch (err) {
        throw mapFsError(err);
      }
      try {
        const stats = await fh.stat();
        if (stats.isDirectory()) {
          throw new Error("Cannot operate on a directory");
        }
        if (!stats.isFile()) {
          throw new Error("Not a regular file");
        }
        await fh.writeFile(input.content, "utf-8");
      } finally {
        await fh.close();
      }

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

  // The legacy `sessions.messages` query was the AI-SDK-shaped history
  // endpoint used by the old `loadMessages → reconnectToStream` dance in
  // ChatView. It has been replaced by the chat-events stream
  // (`GET /api/chats/:chatId/events`), which handles JSONL backfill +
  // live tail in a single subscription. See `docs/experiments/chat-event-log.md`.
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
  // Activity level controls how often the branch-status poller fires.
  // Driven by the Electron main process based on window focus + power state.
  // See `apps/desktop/src/main/services/activity-monitor.ts`.
  setActivity: publicProcedure
    .input(z.object({ activity: z.enum(["active", "idle", "background"]) }))
    .mutation(({ input }) => {
      setPollerActivity(input.activity);
      return { activity: input.activity };
    }),
  getActivity: publicProcedure.query(() => ({ activity: getPollerActivity() })),
  // Resources dashboard — server CPU/memory snapshot (cheap, instant).
  // `process.cpuUsage()` is cumulative since process start; the UI labels
  // it "Total CPU time" so callers don't read it as instantaneous load.
  resourcesServer: publicProcedure.query(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      cpu: {
        userMicros: cpu.user,
        systemMicros: cpu.system,
      },
    };
  }),
  // Resources dashboard — list every tracked git project + its
  // worktree paths *without* doing any disk walks. Instant: just
  // reads state + a single `git worktree list --porcelain` per
  // project (in parallel). The client uses this to paint rows
  // immediately, then fetches each project's size individually
  // via `resourcesProjectSize` so the slow `du` work is amortised
  // and observable per-row.
  resourcesProjects: publicProcedure.query(async () => {
    const state = loadState();
    const projects = await Promise.all(
      state.projects
        .filter((p) => p.kind === "git")
        .map(async (project) => {
          try {
            const list = await listWorktrees(project.path);
            // `listWorktrees` guarantees a non-empty branch for non-bare
            // worktrees: detached HEADs (mid-rebase, mid-bisect, or
            // explicit `git checkout <sha>`) are labelled with the
            // rebase head-name when available, otherwise
            // `detached-<short-sha>`. So every row here has a real
            // label and gets counted in the disk accounting.
            const worktrees = list
              .filter((wt) => !wt.isBare)
              .map((wt) => ({ branch: wt.branch, path: wt.path }));
            return {
              project: project.name,
              path: project.path,
              worktrees,
              error: undefined as string | undefined,
            };
          } catch (err) {
            return {
              project: project.name,
              path: project.path,
              worktrees: [] as { branch: string; path: string }[],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
    );
    return { projects };
  }),
  // Resources dashboard — measure disk usage for a single project.
  //
  // Slow: runs `du -sk` once per worktree, in parallel via
  // Promise.all. The client fan-outs are concurrency-limited so the
  // server doesn't see a thundering herd of `du` processes from a
  // single page open. Per-worktree errors are absorbed into the
  // response (sizeBytes 0, `error` populated) so a single broken
  // worktree doesn't fail the whole query.
  resourcesProjectSize: publicProcedure
    .input(z.object({ project: z.string() }))
    .query(async ({ input }) => {
      const state = loadState();
      const project = state.projects.find((p) => p.name === input.project && p.kind === "git");
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      let worktreePaths: { branch: string; path: string }[];
      try {
        const list = await listWorktrees(project.path);
        // See `resourcesProjects` above — `listWorktrees` already
        // gives every non-bare worktree a non-empty branch label.
        worktreePaths = list
          .filter((wt) => !wt.isBare)
          .map((wt) => ({ branch: wt.branch, path: wt.path }));
      } catch (err) {
        return {
          project: project.name,
          sizeBytes: 0,
          worktrees: [] as Array<{
            branch: string;
            path: string;
            sizeBytes: number;
            error?: string;
          }>,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const worktrees = await Promise.all(
        worktreePaths.map(async (wt) => {
          try {
            const sizeBytes = await duBytes(wt.path);
            return { branch: wt.branch, path: wt.path, sizeBytes };
          } catch (err) {
            return {
              branch: wt.branch,
              path: wt.path,
              sizeBytes: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      worktrees.sort((a, b) => b.sizeBytes - a.sizeBytes);
      const sizeBytes = worktrees.reduce((sum, wt) => sum + wt.sizeBytes, 0);
      return { project: project.name, sizeBytes, worktrees };
    }),
});

// ---------------------------------------------------------------------------
// Editor (CLI-driven file open + active-workspace tracking)
// ---------------------------------------------------------------------------

/**
 * `realpathSync` resolves symlinks but throws ENOENT for paths that don't
 * exist. We need the symlink-resolution part for paths that may or may not
 * exist (e.g. files the user wants to *open* that don't exist yet). Walk
 * up the path until we hit an ancestor that does exist, canonicalize that,
 * then re-append the trailing segments.
 *
 * Returns the input unchanged if no ancestor on disk can be canonicalized
 * (e.g. running on a filesystem mid-delete). Callers fall back to an
 * existence check on the returned value, which produces a clear "file not
 * found" error rather than a confusing IO failure.
 */
function canonicalizeMaybeMissing(p: string): string {
  if (existsSync(p)) {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
  const parts = p.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(sep) || sep;
    if (existsSync(prefix)) {
      try {
        const canonicalPrefix = realpathSync(prefix);
        // `path.join` collapses the duplicate separator that arises when
        // `canonicalPrefix === "/"` (which happens when the walk reaches
        // `i = 1` — `parts.slice(0, 1).join(sep)` is `""`, falling
        // through to `sep`). A naive `[..., ...].join(sep)` would
        // produce `//nonexistent/foo`; functionally equivalent on POSIX
        // but ugly in error messages.
        return join(canonicalPrefix, ...parts.slice(i));
      } catch {
        return p;
      }
    }
  }
  return p;
}

/**
 * Backs the `band open <filePath>` CLI command and the web UI's "I am the
 * currently focused workspace" hint.
 *
 * The web UI calls `editor.setActiveWorkspace` whenever its active workspace
 * changes; the CLI's `band open` reads the same value implicitly via the
 * `openFile` mutation's fallback (`input.workspaceId ?? getActiveWorkspace()`)
 * so the user doesn't need to name the workspace explicitly when firing a
 * file at "wherever I'm currently looking at." The actual open is funnelled
 * through `editor.openFile`, which:
 *   1. Resolves the target workspace (explicit `workspaceId` > active).
 *   2. Validates the file exists and is inside the workspace root —
 *      paths from the CLI can be absolute (resolved against the user's
 *      cwd) or workspace-relative.
 *   3. Emits an `open-file` SSE event so the React shell can navigate
 *      its router to the matching `code/<path>` route.
 *
 * Active-workspace tracking is process-local; the value resets when the
 * web server restarts. That's intentional — no UI mounted → no active
 * workspace, and the next focus event will repopulate it.
 *
 * Security / threat model:
 *   - The `band_token` cookie/header is enforced at the transport layer
 *     (see `start-server.ts`), gating both normal local-server requests
 *     and Band's public tunnel. Only token-bearers can call these
 *     procedures, same constraint as the rest of the router.
 *   - A token-bearer can poison the active-workspace atom via
 *     `setActiveWorkspace` and trigger `openFile` against any workspace
 *     the daemon manages. That's the existing trust boundary: a holder
 *     of the token is already trusted to read/write files via
 *     `workspace.*` and `host.*`, so opening one in the editor is a
 *     proper subset of what they can already do.
 *   - If the desktop ever ships a "share my tunnel without my token"
 *     mode, these (and every other) `publicProcedure` need re-auditing.
 */
const editorRouter = t.router({
  // Intentionally no `getActiveWorkspace` query — the only consumer is the
  // CLI's `band open`, which reads the value implicitly through the
  // `openFile` fallback in the same round-trip. Adding a separate query
  // doubles the cost for no benefit.

  setActiveWorkspace: publicProcedure
    .input(z.object({ workspaceId: z.string().nullable() }))
    .mutation(({ input }) => {
      setActiveWorkspace(input.workspaceId);
      return { ok: true };
    }),

  openFile: publicProcedure
    .input(
      z
        .object({
          /**
           * Workspace to open the file in. When omitted, falls back to the
           * dashboard's currently active workspace.
           */
          workspaceId: z.string().optional(),
          /**
           * Either an absolute filesystem path or a workspace-relative
           * path. Paths inside the workspace root open as normal editor
           * tabs (the renderer routes to the Files panel via the
           * `open-file` SSE event; see `dispatchOpenFileEvent`); paths
           * outside any workspace root open as external tabs (same
           * surface as desktop Cmd+O / "Open File…"). May include a
           * trailing line / column suffix in the standard
           * `path:line[:column]` / `path:line-lineEnd` notation.
           */
          filePath: z.string().min(1),
          line: z.number().int().positive().optional(),
          lineEnd: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
          /**
           * Whether the renderer should bring the dashboard window to the
           * foreground in addition to navigating to the file. Defaults to
           * true. Passed through verbatim on the SSE event; the plain web
           * build ignores it.
           */
          focus: z.boolean().optional(),
        })
        .refine((v) => !(v.lineEnd !== undefined && v.line === undefined), {
          message: "lineEnd requires line to be set",
          path: ["lineEnd"],
        })
        .refine((v) => !(v.column !== undefined && v.line === undefined), {
          message: "column requires line to be set",
          path: ["column"],
        })
        .refine((v) => !(v.line !== undefined && v.lineEnd !== undefined && v.line > v.lineEnd), {
          message: "lineEnd must be >= line",
          path: ["lineEnd"],
        }),
    )
    .mutation(({ input }) => {
      const targetWorkspaceId = input.workspaceId ?? getActiveWorkspace();
      if (!targetWorkspaceId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No active workspace. Open a workspace in the Band dashboard or pass --workspace.",
        });
      }

      const workspace = resolveWorkspace(targetWorkspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace '${targetWorkspaceId}' not found`,
        });
      }

      const root = workspace.worktree.path;

      // Resolve the path: absolute paths are taken as-is; relative
      // paths are resolved against the workspace root.
      const absoluteTarget = isAbsolute(input.filePath)
        ? resolve(input.filePath)
        : resolve(root, input.filePath);

      // Canonicalize the workspace root so symlinked path prefixes
      // (macOS's `/var/folders` → `/private/var/folders` in particular)
      // compare equal. The CLI canonicalizes the user's argument before
      // sending, so a stored worktree path under `/var/...` would
      // otherwise look "outside" its real location.
      let canonicalRoot = root;
      try {
        canonicalRoot = realpathSync(root);
      } catch {
        // worktree may have been deleted out from under us — leave as-is
      }

      // Canonicalize the user's path the same way. `realpathSync` fails
      // on missing files, so walk up to the deepest ancestor that does
      // exist, canonicalize that, then re-append the trailing segments.
      // That keeps the in-workspace check accurate for paths the user
      // wants to *create* as well, and sidesteps a confusing IO error
      // when the real problem is the file is just missing.
      const canonicalTarget = canonicalizeMaybeMissing(absoluteTarget);

      // `existsSync` is true for directories too. Without the `isFile`
      // guard, `band open /path/to/some-dir` would pass through to the
      // renderer as an external "file" and the editor would try to
      // open the directory as a text buffer. Also covers the
      // workspace-root edge case (`band open /path/to/workspace`):
      // a directory there short-circuits before the empty-splat
      // problem in the renderer.
      let targetStat: import("node:fs").Stats | null = null;
      try {
        targetStat = statSync(canonicalTarget);
      } catch {
        // ENOENT or another IO error — surfaced as "File not found"
        // below, same as a missing path.
      }
      if (!targetStat) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `File not found: ${input.filePath}`,
        });
      }
      if (!targetStat.isFile()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Not a file: ${input.filePath}`,
        });
      }

      // Segment-aware containment check (same invariant as the untitled
      // save flow in CodeBrowserView): a naive `startsWith` would treat
      // `/a/band-fork/x.ts` as inside `/a/band`.
      const normalizedRoot = canonicalRoot.replace(/\/+$/, "");
      const isInside =
        canonicalTarget === normalizedRoot || canonicalTarget.startsWith(`${normalizedRoot}${sep}`);

      // Two open modes share this procedure:
      //
      //   - In-workspace: emit a workspace-relative path so the renderer
      //     opens it in the workspace's Files panel (same flow as the
      //     file tree / Quick Open dialog).
      //   - External: file exists on disk but lives outside the active
      //     workspace's root. Pass the absolute path through verbatim
      //     so the FileViewer mounts it as an *external* tab
      //     (`isExternal: true`), reading via `readExternalFile` and
      //     skipping LSP / workspace-relative routing. Matches what
      //     desktop Cmd+O ("Open File…") does — `band open` is just a
      //     programmatic entrypoint into the same code path.
      let payloadPath: string;
      if (isInside) {
        const relativePath =
          canonicalTarget === normalizedRoot
            ? ""
            : canonicalTarget.slice(normalizedRoot.length + 1);
        // POSIX separators on the wire — tanstack-router and
        // `parseFileLocation` both work off `/`-separated paths.
        payloadPath = relativePath.split(sep).join("/");
      } else {
        payloadPath = canonicalTarget;
      }

      const formatted = formatFileLocation(payloadPath, input.line, {
        lineEnd: input.lineEnd,
        column: input.column,
      });

      emit({
        kind: "open-file",
        workspaceId: targetWorkspaceId,
        filePath: formatted,
        external: !isInside,
        focus: input.focus ?? true,
      });

      return {
        ok: true,
        workspaceId: targetWorkspaceId,
        filePath: formatted,
        external: !isInside,
      };
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
      // The agent is still blocked on an AskUserQuestion / ExitPlanMode
      // prompt — the user hasn't answered yet. Don't clear the indicator
      // just because they navigated to the workspace; the indicator must
      // stay on until the user actually answers (which calls
      // resolvePendingInput, and onUserInputNeeded then flips the status
      // back to "working").
      if (hasPendingInputForWorkspace(input.workspaceId)) {
        emit({ kind: "update", status: existing });
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

      const workspaceId = resolveCronjobWorkspaceId(job, input.key);
      if (!workspaceId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      // Issue #520: manual trigger uses the same `band:cronId`-labeled chat
      // as the scheduled fire so the user sees both paths converge on a
      // single dedicated conversation.
      const cronChat = getOrCreateCronjobChat(workspaceId, job);
      try {
        const task = submitTask({ workspaceId, chatId: cronChat.id, prompt: job.prompt });
        return { taskId: task.id, workspaceId, chatId: cronChat.id };
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
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const chat = createChat(input.workspaceId, {
          id: input.id,
          name: input.name,
          agent: input.agent,
          model: input.model,
          mode: input.mode,
          labels: input.labels,
          // tRPC is a user-facing surface — never allow callers to set
          // reserved `band:`-prefixed labels.
        });
        return { chat };
      } catch (err) {
        if (err instanceof InvalidLabelsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
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

  /**
   * Update one or more fields on an existing chat pane.
   *
   * Behavior contract:
   *   - `labels` replaces the **full** record. Pass `{}` to clear.
   *   - Returns `NOT_FOUND` (404) if `chatId` doesn't resolve. This is
   *     a behavior change from before issue #520, when this route
   *     returned `200 { chat: undefined }` on an unknown id. The
   *     previous silent-no-op was harmless for cosmetic edits but
   *     would let a `labels: {}` "clear" against a stale id succeed
   *     misleadingly, which is why the route now surfaces the error.
   *     Existing UI callers (`ChatView.tsx` `.catch(...)` handlers
   *     for mode/model changes) absorb the new 404 the same way they
   *     absorbed the silent 200; new callers should expect it.
   *   - Returns `BAD_REQUEST` (400) if `labels` violates validation
   *     rules in `validateLabels` (max 20 keys, key regex, value
   *     rules, reserved `band:` prefix).
   */
  update: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        name: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { chatId, ...updates } = input;
      try {
        const chat = updateChat(chatId, updates);
        if (!chat) {
          // Issue #520: `chats.update` previously returned 200 with
          // `chat: undefined` when the chatId didn't resolve. Harmless when
          // the route only touched cosmetic fields, but the new `labels`
          // semantic is "replace the whole record" — a silent no-op on a
          // typo'd id would let a caller believe their relabel succeeded.
          //
          // Existing UI callers (`ChatView.tsx`'s `trpc.chats.update.mutate`
          // for `mode` / `model` changes) wrap the call in `.catch` and log
          // — they used to absorb the silent success, and they'll now
          // absorb the 404 the same way. Intentional: the 404 is the
          // correct shape for a stale chatId; any new caller (CLI
          // `chats label` / `chats unlabel`) wants it surfaced.
          throw new TRPCError({ code: "NOT_FOUND", message: "Chat not found" });
        }
        return { chat };
      } catch (err) {
        if (err instanceof InvalidLabelsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
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
// Browser Host (CDP screencast experiment)
//
// The bridge between the web server and the desktop's BrowserViewManager.
// Workflow:
//   1. Web client opens /cdp?bandTabId=X (or hits /api/cdp/tabs/X/snapshot).
//   2. Server calls `ensureCdpTargetId(X)`. Cache miss → `onEnsureView`
//      listeners fire.
//   3. Desktop's React (subscribed to `browserHost.ensureView` below)
//      calls `browser_ensure` IPC, then `browser_get_cdp_target`, then
//      reports the cdpTargetId back via the `targetReady` mutation.
//   4. Server resolves the in-flight ensure promise, opens the upstream WS.
//   5. When the desktop later destroys the view (LRU, explicit close), it
//      reports via the `viewDestroyed` mutation, clearing the cache.
// ---------------------------------------------------------------------------

const browserHostRouter = t.router({
  // Diagnostic: the desktop's BrowserHostBridge calls this on mount so we
  // can confirm in the server log that the bridge component actually
  // executed. Drop once the experiment is stable.
  ping: publicProcedure.input(z.object({ where: z.string() })).mutation(({ input }) => {
    log.info("browserHost.ping from %s", input.where);
    return { ok: true };
  }),

  ensureView: publicProcedure.subscription(async function* (opts) {
    const queue: EnsureViewEvent[] = [];
    let resolve: (() => void) | null = null;

    const unsubscribe = onEnsureView((event) => {
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

  targetReady: publicProcedure
    .input(z.object({ bandTabId: z.string(), cdpTargetId: z.string() }))
    .mutation(({ input }) => {
      resolveTargetReady(input.bandTabId, input.cdpTargetId);
      return { ok: true };
    }),

  viewDestroyed: publicProcedure
    .input(z.object({ bandTabId: z.string() }))
    .mutation(({ input }) => {
      markTargetDestroyed(input.bandTabId);
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Browser history (persistent per-workspace visit log).
//
// Surfaced as `trpc.history.*` and consumed by:
//   - `BrowserPanel` listeners — call `record` on each committed
//     navigation and `updateMeta` when `page-title-updated` fires.
//   - `useBrowserPaneControls` — calls `search` to drive address-bar
//     autocomplete.
//   - `HistoryPopover` — calls `list` / `search` / `delete` / `clear`.
//
// Visits are upserted on (workspaceId, url) — see `browser-history-store`
// for the dedupe/frecency rules.
// ---------------------------------------------------------------------------

const clearRangeSchema = z.enum(["hour", "day", "week", "all"]);

// Caps on the size of strings we persist. No real navigable URL is
// longer than 2048 chars (browsers historically cap somewhere
// between 2 KB and 8 KB; 2048 is the conservative web-server
// default). Titles can be longer in theory but we'd never display
// more than a few hundred chars. faviconUrl is normally just an
// origin + `/favicon.ico`. These caps protect against a misbehaving
// renderer inflating the DB with megabyte-sized `data:` URIs.
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;

// Whitelist of URL schemes accepted for `faviconUrl`. The rendered
// `<img src={faviconUrl}>` in `HistoryPopover` /
// `AddressBarAutocomplete` would otherwise execute any scheme the
// renderer dreamt up — `data:image/...;base64,...` URIs would
// inflate the DB, and `javascript:` would be a renderer XSS vector
// (though the renderer is trusted; defence in depth still). Real
// favicons are always http(s) origin-relative.
const ALLOWED_FAVICON_SCHEMES = ["http:", "https:"] as const;
const faviconUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(
    (val) => {
      try {
        return ALLOWED_FAVICON_SCHEMES.includes(
          new URL(val).protocol as (typeof ALLOWED_FAVICON_SCHEMES)[number],
        );
      } catch {
        return false;
      }
    },
    { message: "faviconUrl must be a http(s) URL" },
  );

const historyRouter = t.router({
  record: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      const recorded = recordVisit({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true, recorded };
    }),

  updateMeta: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      updateVisitMeta({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true };
    }),

  list: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(({ input }) => {
      const entries = listHistory(input.workspaceId, {
        limit: input.limit,
        offset: input.offset,
      });
      return { entries };
    }),

  search: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(({ input }) => {
      const entries = searchHistory(input.workspaceId, input.query, input.limit ?? 8);
      return { entries };
    }),

  delete: publicProcedure
    // `positive()` rather than `nonnegative()` — autoincrement ids
    // start at 1. `workspaceId` scopes the delete so a caller that
    // knows a row id from a *different* workspace can't reach into
    // it.
    .input(z.object({ id: z.number().int().positive(), workspaceId: z.string().min(1) }))
    .mutation(({ input }) => {
      deleteHistoryEntry(input.id, input.workspaceId);
      return { ok: true };
    }),

  clear: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        range: clearRangeSchema,
      }),
    )
    .mutation(({ input }) => {
      const deleted = clearHistory(input.workspaceId, input.range satisfies ClearRange);
      return { deleted };
    }),
});

// ---------------------------------------------------------------------------
// Queue (persisted queued messages)
// ---------------------------------------------------------------------------

/**
 * Wire shape accepted from tRPC clients. `path` is optional on input
 * because external/CLI callers may enqueue a raw `data:` URL that the
 * server has not yet persisted — we resolve a path in that case
 * (see `resolveQueuedFiles` below). Clients that already have the file
 * on disk (the dashboard's drag-reorder, for example) MUST forward the
 * existing `path` through unchanged so it survives the round-trip.
 */
const queuedFileSchema = z.object({
  mediaType: z.string(),
  url: z.string(),
  path: z.string().optional(),
  filename: z.string().optional(),
});

type QueuedFileInput = z.infer<typeof queuedFileSchema>;

/**
 * Ensure every enqueued file has a persisted on-disk `path`. Two shapes
 * to handle:
 *
 *   1. The client already saved the bytes (e.g. dashboard reorder via
 *      `queue.set`) and forwards `path` + a `/api/uploads/...` URL —
 *      pass through unchanged.
 *   2. The client hands us a `data:` URL with no `path` (e.g. CLI-driven
 *      enqueue from raw base64) — persist via `saveUploadedFilesDetailed`
 *      and rebuild the file record with the fresh path + stable URL.
 *
 * Any other shape (no `path`, non-data URL — there's no way to recover
 * the disk path from a bare URL) is dropped with a log entry rather
 * than silently inserted in a half-broken state.
 */
/**
 * Reject client-supplied paths that aren't under `<HOME>/.band/uploads/`.
 * Without this, an authenticated caller (local UI, CLI, or anyone with
 * the band_token) could enqueue `path: "/home/user/.ssh/id_rsa"` — the
 * drain in `task-runner.ts` would inject the path verbatim into the
 * agent prompt as `I'm sharing these files with you:\n- /…/id_rsa`,
 * and the agent would happily read and stream the contents.
 *
 * Two-layer check:
 *   1. **String containment** — normalize with `path.resolve` (catches
 *      `…/uploads/../../etc/passwd`-style traversal) and verify the
 *      result lives under the uploads dir. Pure string op, never
 *      throws, doesn't depend on the file existing.
 *   2. **Symlink defence** — if the file exists, walk symlinks with
 *      `realpathSync` and re-check containment of the canonical form,
 *      so an attacker who can place `~/.band/uploads/evil → /etc/passwd`
 *      can't bypass with a path inside the uploads dir.
 *
 * Splitting the checks avoids a previous failure mode where
 * `realpathSync` threw ENOENT on a previously-valid path (the file
 * was deleted between enqueue and use) and the attachment was
 * silently dropped from a queue.set roundtrip — see review on #500.
 * Now: missing file with a path that PASSES the string-containment
 * check is accepted (the drain may then fail to read it, surfacing
 * the issue to the user); missing file with an out-of-bounds path is
 * rejected up front.
 */
function isPathWithinUploadDir(p: string): boolean {
  const uploadDir = join(bandHome(), "uploads");
  // Layer 1: string-only containment. Catches `/etc/passwd` and any
  // `…/uploads/../../etc/passwd`-shaped traversal.
  const normalized = resolve(p);
  if (normalized !== uploadDir && !normalized.startsWith(uploadDir + sep)) {
    return false;
  }
  // Layer 2: symlink defence — only meaningful when the file actually
  // exists. `realpathSync` walks the symlink chain and returns the
  // canonical path; we then re-check containment. ENOENT means the
  // file isn't there yet (or was deleted), in which case layer 1 has
  // already accepted the normalized path — defer to the caller (the
  // drain) to surface the read failure rather than silently dropping.
  try {
    const canonicalUploadDir = realpathSync(uploadDir);
    const canonicalPath = realpathSync(p);
    return (
      canonicalPath === canonicalUploadDir || canonicalPath.startsWith(canonicalUploadDir + sep)
    );
  } catch {
    return true;
  }
}

async function resolveQueuedFiles(
  chatId: string,
  files: QueuedFileInput[] | undefined,
): Promise<{ mediaType: string; url: string; path: string; filename?: string }[] | undefined> {
  if (!files || files.length === 0) return undefined;

  const resolved: { mediaType: string; url: string; path: string; filename?: string }[] = [];
  const needsSave: QueuedFileInput[] = [];
  const needsSaveIdx: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Derive path from URL when the client doesn't supply one. The
    // SSE wire shape strips `path` (it's server-internal), so the
    // dashboard's drag-reorder round-trip lands here with just
    // `url: "/api/uploads/<storedName>"`. Reconstructing the path
    // server-side keeps the wire small AND prevents a malicious
    // client from spoofing a path that doesn't match its URL.
    const uploadsUrlMatch = file.url.match(/^\/api\/uploads\/(.+)$/);
    const derivedPath =
      file.path ?? (uploadsUrlMatch ? join(bandHome(), "uploads", uploadsUrlMatch[1]) : undefined);

    if (derivedPath) {
      // Containment check — never trust a client-supplied path, even
      // a derived one (an attacker could send
      // `url: "/api/uploads/../../etc/passwd"`).
      if (!isPathWithinUploadDir(derivedPath)) {
        log.warn(
          { chatId, path: derivedPath, filename: file.filename },
          "queue: dropping file with path outside uploads directory",
        );
        continue;
      }
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: derivedPath,
        ...(file.filename !== undefined && { filename: file.filename }),
      });
      continue;
    }
    if (file.url.startsWith("data:")) {
      needsSave.push(file);
      // Record the slot in `resolved[]` (NOT the loop index `i`): when an
      // earlier entry is dropped (`log.warn` branch), `resolved` lags
      // `files` and `needsSaveIdx[k] = i` would point at the wrong slot,
      // silently corrupting one entry and orphaning another.
      needsSaveIdx.push(resolved.length);
      // Placeholder so we can splice into the right slot once saved.
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: "",
        filename: file.filename,
      });
      continue;
    }
    log.warn(
      { chatId, url: file.url, filename: file.filename },
      "queue: dropping file with no path and non-data URL — cannot recover disk path",
    );
  }

  if (needsSave.length > 0) {
    const saved = await saveUploadedFilesDetailed(needsSave);
    // The splicing loop below is index-aligned: `saved[k]` MUST
    // correspond to `needsSave[k]`. `saveUploadedFilesDetailed` skips
    // entries that fail its data-URL regex (compacted output) and
    // could in principle return fewer results than the input. A
    // mid-batch skip would then misalign every subsequent slot —
    // `saved[k]` would be written into a slot that belongs to a
    // different file, silently corrupting the queued payload. We
    // pre-filter for data-URL entries, so a mismatch here means an
    // upstream regression (malformed data URL slipping through). When
    // that happens, refuse to splice and let the placeholders fall
    // through to the `.filter((f) => f.path !== "")` pruning step
    // below — losing the saved-but-unmappable files is the right
    // trade-off vs. silently corrupting another file's metadata.
    if (saved.length !== needsSave.length) {
      log.error(
        { chatId, expected: needsSave.length, got: saved.length },
        "queue: saveUploadedFilesDetailed returned unexpected count — dropping data-URL files (cannot map 1:1)",
      );
    } else {
      for (let k = 0; k < saved.length; k++) {
        const target = needsSaveIdx[k];
        resolved[target] = {
          mediaType: saved[k].mediaType,
          url: `/api/uploads/${saved[k].storedName}`,
          path: saved[k].path,
          ...(saved[k].originalName !== undefined && { filename: saved[k].originalName }),
        };
      }
    }
  }

  const finalized = resolved.filter((f) => f.path !== "");
  return finalized.length > 0 ? finalized : undefined;
}

const queueRouter = t.router({
  push: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        text: z.string(),
        files: z.array(queuedFileSchema).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // If disk write fails (ENOSPC, permissions, etc.), degrade to a
      // text-only queue entry rather than reject the whole push with a
      // 500. Losing the attachment is annoying; losing the user's
      // typed message because their disk is full would be worse —
      // they'd have to retype it from scratch with no indication that
      // the text actually survived.
      let files: Awaited<ReturnType<typeof resolveQueuedFiles>>;
      try {
        files = await resolveQueuedFiles(chatId, input.files);
      } catch (err) {
        log.error(
          { chatId, err: err instanceof Error ? err.message : err },
          "queue.push: failed to persist file uploads; enqueuing text only",
        );
        files = undefined;
      }
      const message = pushQueuedMessage(chatId, { text: input.text, files });
      return {
        ok: true,
        message: toWireQueuedMessages([message])[0],
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        messages: z.array(
          z.object({
            id: z.string().optional(),
            text: z.string(),
            files: z.array(queuedFileSchema).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // Resolve files per message and tolerate per-message failures.
      // `Promise.all` would short-circuit on the first rejection and
      // leave any already-saved files orphaned on disk with no queue
      // entry referencing them. We log and drop the bad message's
      // files instead, so the reorder/set proceeds with the remaining
      // metadata intact.
      const messages = await Promise.all(
        input.messages.map(async (m) => {
          try {
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: await resolveQueuedFiles(chatId, m.files),
            };
          } catch (err) {
            log.error(
              { chatId, messageId: m.id, err: err instanceof Error ? err.message : err },
              "queue: failed to resolve files for queued message; dropping its files",
            );
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: undefined,
            };
          }
        }),
      );
      setQueuedMessages(chatId, messages);
      return { ok: true, messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      return { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  remove: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional(), id: z.string() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const removed = removeQueuedMessage(chatId, input.id);
      return {
        ok: true,
        removed,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  update: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        id: z.string(),
        text: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const updated = updateQueuedMessage(chatId, input.id, input.text);
      return {
        ok: true,
        updated,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  shift: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const message = shiftQueuedMessage(chatId);
      return { message: message ? toWireQueuedMessages([message])[0] : null };
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

      type Update = { messages: QueuedMessage[] };
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

      // Emit current state immediately so the client is in sync.
      // `toWireQueuedMessages` strips the server-only `path` field —
      // see queued-message-store.ts for why.
      yield { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };

      // Discard notifications that arrived between listener registration
      // and the initial yield — the initial yield already covers them.
      queue.length = 0;

      try {
        while (!opts.signal?.aborted) {
          while (queue.length > 0) {
            const update = queue.shift()!;
            yield { messages: toWireQueuedMessages(update.messages) };
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
  host: hostRouter,
  tunnel: tunnelRouter,
  prereqs: prereqsRouter,
  tasks: tasksRouter,
  sessions: sessionsRouter,
  services: servicesRouter,
  chat: chatRouter,
  chatLayout: chatLayoutRouter,
  chats: chatsRouter,
  editor: editorRouter,
  browserLayout: browserLayoutRouter,
  browsers: browsersRouter,
  browserHost: browserHostRouter,
  history: historyRouter,
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
