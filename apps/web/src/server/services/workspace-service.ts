import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@band-app/logger";
import { z } from "zod";
import { toWorkspaceId } from "@/dashboard";
import { removeWorkspaceBrowsers } from "../../lib/browser-manager";
import { getOrCreateDefaultChat, removeWorkspaceChats } from "../../lib/chat-manager";
import { DETACHED_BRANCH_PREFIX, execGit, gitCmd, listWorktrees } from "../../lib/git";
import { killWorkspaceServers } from "../../lib/lsp-manager";
import { loadProjectConfig } from "../../lib/project-config";
import { runSetup } from "../../lib/setup-runner";
import {
  bandHome,
  deleteWorkspaceStatus,
  loadState,
  type ProjectState,
  saveState,
  type WorktreeState,
  worktreesDir,
} from "../../lib/state";
// FRAGILE: ESM cycle leg — `lib/task-runner` imports `lib/workspace`,
// which imports `workspaceService` from this file. The cycle is safe only
// because every `workspaceService` reference is inside a function body
// (live binding). See `lib/workspace.ts` for the cycle note before
// capturing `submitTask` (or anything else here) at module load.
import { submitTask } from "../../lib/task-runner";
import { deleteWorkspaceTasks } from "../../lib/task-store";
import { emit } from "../../lib/watcher";
import { WorkspaceQueries } from "../infra/db/queries/workspaces";
// FRAGILE: ESM cycle leg #2 — `./cronjob-service` imports `submitTask`
// from `lib/task-runner`, which imports `lib/workspace`, which imports
// `workspaceService` from this file. Same live-binding constraint as the
// `submitTask` import above: keep every `cronjobService` reference inside
// a function body. Capturing `const cs = cronjobService;` at module load
// on this leg would silently get `undefined`.
import { cronjobService } from "./cronjob-service";
import { terminalService } from "./terminal-service";

const execFileAsync = promisify(execFile);
const log = createLogger("workspace-service");

/**
 * Resolved workspace shape (project row + worktree row) returned by
 * `WorkspaceService.resolve`. Mirrors the legacy `lib/workspace.ts`
 * `resolveWorkspace` return type so existing callers can be migrated to
 * the service without touching their use sites.
 */
export interface ResolvedWorkspace {
  project: ProjectState;
  worktree: WorktreeState;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `WorkspaceService.create`.
 *
 * Lives in the service tier (not the API router) so the service and any
 * future non-tRPC entry points (CLI, scripts) share a single source of
 * truth for the accepted shape — same pattern as `settingsUpdateInput`.
 */
export const workspaceCreateInput = z.object({
  project: z.string(),
  branch: z.string(),
  base: z.string().optional(),
  prompt: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  codingAgentId: z.string().optional(),
});
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInput>;

export const workspaceRemoveInput = z.object({
  project: z.string(),
  branch: z.string(),
});
export type WorkspaceRemoveInput = z.infer<typeof workspaceRemoveInput>;

export const workspaceSetPinnedInput = z.object({
  project: z.string(),
  branch: z.string(),
  pinned: z.boolean(),
});
export type WorkspaceSetPinnedInput = z.infer<typeof workspaceSetPinnedInput>;

export const workspaceGitInput = z.object({
  project: z.string(),
  branch: z.string(),
});
export type WorkspaceGitInput = z.infer<typeof workspaceGitInput>;

export const workspaceRunScriptInput = z.object({
  path: z.string(),
  scriptType: z.string(),
});
export type WorkspaceRunScriptInput = z.infer<typeof workspaceRunScriptInput>;

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Project named in the workspace mutation does not exist in state.
 *
 * Translated by the API tier (`throwAsTrpcError` in
 * `api/workspaces/router.ts`) into a plain `Error` rethrow that surfaces
 * as HTTP 500 — that's the legacy wire contract for these procedures
 * and the existing trpc integration tests pin it. The router comment
 * explains the rationale and the migration plan; a future PR can
 * promote the mapping to `NOT_FOUND` (and update the pinned tests) in
 * lock-step.
 */
export class ProjectNotFoundError extends Error {
  constructor(name: string) {
    super(`Project "${name}" not found`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * Branch named in the workspace mutation does not exist on the project.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(branch: string) {
    super(`Workspace "${branch}" not found`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Workspace mutation invoked on a plain (non-git) project. Plain projects
 * have a single implicit workspace at the project path and don't support
 * additional worktrees, branch operations, or pinning.
 */
export class PlainProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainProjectError";
  }
}

/**
 * Business logic for the workspace domain (Phase 3 of the 3-tier refactor —
 * issue #314).
 *
 * Service tier — depends on Infra (`WorkspaceQueries`, `lib/state` for the
 * shared project-state persistence, `lib/git` for git exec) plus a handful
 * of cross-domain helpers (`lib/chat-manager`, `cronjobService.removeForKey`,
 * …) for workspace-scoped cleanup on delete. Knows nothing about tRPC or
 * the API surface — all callers (routers, future CLI / scripts) funnel
 * through this class.
 *
 * Cross-cutting concerns parked in the legacy `lib/*` modules for now:
 *
 *   - **Projects table reads/writes.** `loadState` / `saveState` still
 *     co-manage the `projects` + `worktrees` tables via a whole-tree
 *     rewrite. That persistence model belongs to the projects domain and
 *     is owned by Phase 2 (`ProjectQueries`, issue #313). Once Phase 2
 *     lands, this service's create/remove paths will swap to direct
 *     `WorkspaceQueries.insert` / `WorkspaceQueries.remove` calls and the
 *     projects table will be touched only through `ProjectQueries`.
 *   - **Git wrappers.** `execGit` / `gitCmd` / `listWorktrees` live in
 *     `lib/git.ts` and will be lifted into `GitClient` by Phase 2. The
 *     service uses them directly today; the router-facing contract is
 *     unchanged.
 *   - **Workspace-scoped side-effect cleanup.** `removeWorkspaceChats`,
 *     `terminalService.killWorkspace`, `cronjobService.removeForKey`, etc.
 *     live in their own domain modules. Each will migrate to its own
 *     service in a later phase; the orchestration is centralized here for
 *     now so the remove flow remains atomic from the router's perspective.
 *
 * Stateless aside from its `queries` dependency, so a single shared
 * instance is safe across callers.
 */
export class WorkspaceService {
  constructor(private readonly queries: WorkspaceQueries = new WorkspaceQueries()) {}

  /**
   * Resolve a workspace ID to its parent project + worktree row.
   *
   * Mirrors the legacy `lib/workspace.ts::resolveWorkspace` so callers can
   * be migrated incrementally. Returns `null` when the workspace ID
   * doesn't match any worktree (the caller decides whether that's a 404
   * or a fall-through).
   *
   * NOTE: deliberately uses `loadState()` (full projects + worktrees walk)
   * rather than the targeted `WorkspaceQueries.findIdentity()` SQL lookup
   * that lives in the same PR. The return shape is `ResolvedWorkspace =
   * { project: ProjectState, worktree: WorktreeState }` — callers (e.g.
   * `gitPull`/`gitPush`) read `project.kind` to gate plain-project
   * rejections, and the legacy shim in `lib/workspace.ts` exposes the
   * same shape to existing consumers. `findIdentity()` only returns
   * `(project, branch, worktreePath)` — no `kind`, no full project row —
   * so swapping it in here would require a second `ProjectQueries`-tier
   * lookup we don't have yet (Phase 2 ships that surface). Once the
   * projects-domain queries land, this can drop to one `findIdentity()` +
   * one targeted project read. Call frequency is low (user-initiated
   * git pull/push only), so the O(n) JS walk is acceptable in the
   * interim.
   */
  resolve(workspaceId: string): ResolvedWorkspace | null {
    const state = loadState();
    for (const project of state.projects) {
      for (const worktree of project.worktrees) {
        if (toWorkspaceId(project.name, worktree.branch) === workspaceId) {
          return { project, worktree };
        }
      }
    }
    return null;
  }

  /**
   * Create a workspace (git worktree) for `(project, branch)`.
   *
   * Idempotent: returns the existing path when the branch is already a
   * worktree on the project. Rejects plain (non-git) projects with
   * `PlainProjectError` — they have a single implicit workspace at the
   * project path and don't support additional worktrees.
   *
   * On success:
   *   1. Creates the worktree on disk via `git worktree add` (with an
   *      optional base branch).
   *   2. Persists the new worktree row through `saveState`.
   *   3. Materialises the workspace's default chat pane.
   *   4. Kicks off the workspace's `.band/setup` script in the background.
   *      If a `prompt` was supplied, the task is submitted only after the
   *      setup script finishes (so the coding agent sees its dependencies
   *      installed). When there is no setup script, the task is dispatched
   *      synchronously.
   */
  create(input: WorkspaceCreateInput): { ok: true; path: string } {
    const state = loadState();
    const project = state.projects.find((p) => p.name === input.project);
    if (!project) {
      throw new ProjectNotFoundError(input.project);
    }

    // Plain projects have exactly one implicit workspace, created at
    // project-add time. Creating additional workspaces is meaningless
    // without git worktrees, so reject the call as a backstop — the UI
    // should already be hiding the "New workspace" button.
    if (project.kind === "plain") {
      throw new PlainProjectError(
        `Project "${input.project}" is a plain (non-git) folder and cannot have additional workspaces. Promote it to git (right-click the project → "Promote to git") to enable branches.`,
      );
    }

    const existing = project.worktrees.find((wt) => wt.branch === input.branch);
    if (existing) {
      return { ok: true, path: existing.path };
    }

    const wtDir = worktreesDir();
    const worktreePath = join(wtDir, input.project, input.branch);
    // Pre-create the `<project>` subdir under the worktrees root so the
    // first `workspaces.create` call on a freshly-installed Band has
    // somewhere to land. For slash-containing branch names (e.g.
    // `feature/my-feature` → `<wtDir>/<project>/feature/my-feature`)
    // we deliberately do NOT pre-create the in-between segments
    // (`feature/`): `git worktree add` itself creates every intermediate
    // directory under its target path, so an extra mkdir here would be
    // redundant. Verified against `git 2.x` — `git worktree add
    // /tmp/wt/feature/login -b feature/login` succeeds without the
    // parent existing.
    mkdirSync(join(wtDir, input.project), { recursive: true });

    const { command, env } = gitCmd();
    const args = ["worktree", "add"];
    if (input.base) {
      args.push("-b", input.branch, worktreePath, input.base);
    } else {
      args.push("-b", input.branch, worktreePath);
    }

    try {
      execFileSync(command, args, { cwd: project.path, env, encoding: "utf-8" });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }

    project.worktrees.push({ branch: input.branch, path: worktreePath, pinned: false });
    saveState(state);

    const workspaceId = toWorkspaceId(input.project, input.branch);

    // Materialize the default chat pane so the workspace surfaces a
    // ready-to-use UI even when the caller didn't pass a prompt.
    const defaultChat = getOrCreateDefaultChat(workspaceId);

    // If a prompt is provided, defer task submission until the setup
    // script completes so the agent has dependencies installed. When
    // there is no setup command, `runSetup` calls `onComplete`
    // synchronously, so the task is submitted immediately.
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

    runSetup(workspaceId, worktreePath, project.path, onSetupComplete);

    return { ok: true, path: worktreePath };
  }

  /**
   * Remove a workspace (git worktree) and its workspace-scoped state.
   *
   * Two-phase to keep the UI snappy:
   *
   *   1. **Fast path (synchronous):** drops the worktree row from state,
   *      deletes the workspace's prompt file / DB statuses / chats /
   *      browsers / terminals / LSPs / cronjobs / tasks, and emits a
   *      `remove` event so subscribers (the dashboard) can drop the card.
   *   2. **Background:** runs the `.band/teardown` script (if any), then
   *      `git worktree remove --force` + `git branch -D`. Failures are
   *      logged but never bubble back — by the time the user clicks
   *      "Delete", the workspace is already gone from their perspective
   *      and we don't want a stale `.git` to wedge the UI.
   *
   * Resolves the worktree path via `listWorktrees` rather than re-parsing
   * `git worktree list --porcelain` inline so detached-HEAD worktrees
   * (labelled `detached-<short-sha>` everywhere else in the app) round-
   * trip correctly through the remove flow — see the
   * `workspace-remove-detached.test.ts` regression test.
   */
  async remove(input: WorkspaceRemoveInput): Promise<{ ok: true }> {
    const state = loadState();
    const project = state.projects.find((p) => p.name === input.project);
    if (!project) {
      throw new ProjectNotFoundError(input.project);
    }

    // Plain projects can't have their (single, implicit) workspace
    // removed — the workspace is the project. The user must remove the
    // project entirely instead.
    if (project.kind === "plain") {
      throw new PlainProjectError(
        `Project "${input.project}" is a plain (non-git) project. Remove the project instead of the workspace.`,
      );
    }

    const { command, env: gitEnv } = gitCmd();

    // Resolve the worktree path via `listWorktrees` rather than re-parsing
    // porcelain inline — it applies the detached-HEAD → `detached-<sha>`
    // fallback that the rest of the app sees in `project.worktrees`, so
    // the dashboard's `input.branch` matches.
    const worktrees = await listWorktrees(project.path);
    const match = worktrees.find((wt) => wt.branch === input.branch);
    if (!match) {
      throw new WorkspaceNotFoundError(input.branch);
    }
    const worktreePath = match.path;

    // Capture teardown config before returning — the directory may be
    // removed by background cleanup before `loadProjectConfig` can read it.
    let teardownCmd: string | undefined;
    try {
      const config = loadProjectConfig(worktreePath, project.path);
      if (config?.teardown && typeof config.teardown === "string") {
        teardownCmd = config.teardown;
      }
    } catch {
      // Config may not exist
    }

    // ── Fast path: update state and emit immediately ──
    project.worktrees = project.worktrees.filter((wt) => wt.branch !== input.branch);
    saveState(state);

    const workspaceId = toWorkspaceId(input.project, input.branch);
    try {
      unlinkSync(join(bandHome(), "workspace-prompts", `${workspaceId}.json`));
    } catch {
      // Prompt file may not exist
    }
    deleteWorkspaceStatus(workspaceId);
    this.queries.deleteBranchStatus(workspaceId);

    // Clean up all chat panes and their agent processes. The service
    // tears down the saved layout as part of the same call (see
    // `ChatService.removeAllForWorkspace`) so a separate `deleteChatLayout`
    // step is no longer required here.
    removeWorkspaceChats(workspaceId);

    // Clean up all browser tabs + layout. Same contract as chats —
    // `BrowserService.removeAllForWorkspace` drops the layout row itself.
    removeWorkspaceBrowsers(workspaceId);

    // Kill any running terminal PTY sessions + layout
    terminalService.killWorkspace(workspaceId);
    terminalService.deleteLayout(workspaceId);

    // Kill any running language server processes
    killWorkspaceServers(workspaceId);

    // Clean up workspace-scoped cronjobs
    cronjobService.removeForKey(workspaceId);

    // Delete persisted task history for the workspace (issue #416).
    // Tasks aren't covered by a FK cascade because workspaces aren't a
    // first-class DB row, so the cleanup is explicit here next to the
    // other workspace-scoped removals. Task cleanup is best-effort — a
    // DB lock or WAL timeout must not abort the whole removal or
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
    const projPath = project.path;
    // Synthetic "detached-<short-sha>" labels generated by `listWorktrees`
    // for detached-HEAD worktrees do not correspond to a real git ref.
    // Trying to `git branch -D detached-abc1234` would error ("branch not
    // found") — the catch below swallows it cleanly, but skipping the
    // call up front keeps the background logs free of noise that's hard
    // to distinguish from a genuine problem.
    const branchToDelete = match.branch.startsWith(DETACHED_BRANCH_PREFIX) ? null : input.branch;
    setImmediate(() => {
      (async () => {
        // Run teardown script before removing worktree so it can access
        // project files.
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
          try {
            await rm(worktreePath, { recursive: true, force: true });
          } catch (err) {
            // Permission errors / EBUSY here leave the directory on disk;
            // log so a stale worktree path is traceable, then still try
            // `git worktree prune` to at least clean the index — matches
            // the existing best-effort pattern used for prune/branch -D.
            log.warn({ err, workspaceId, worktreePath }, "manual worktree rm failed");
          }
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
  }

  /**
   * Toggle a workspace's pinned flag.
   *
   * Pinning surfaces the workspace in the dashboard's "Pinned" section.
   * Rejects plain projects (they're already flat in the projects list and
   * a stray `pinned=true` strands the UI with an empty `worktrees` array;
   * the menu item is also hidden client-side as a first line of defence).
   */
  setPinned(input: WorkspaceSetPinnedInput): { ok: true } {
    const state = loadState();
    const project = state.projects.find((p) => p.name === input.project);
    if (!project) {
      throw new ProjectNotFoundError(input.project);
    }
    if (project.kind === "plain") {
      throw new PlainProjectError(
        `Project "${input.project}" is a plain (non-git) project. Pinning is not available.`,
      );
    }
    const worktree = project.worktrees.find((w) => w.branch === input.branch);
    if (!worktree) {
      throw new WorkspaceNotFoundError(input.branch);
    }
    worktree.pinned = input.pinned;
    saveState(state);
    return { ok: true };
  }

  /**
   * `git pull --rebase` inside the workspace's worktree.
   *
   * Swallows the specific "Cannot rebase onto multiple branches" exit
   * status that git produces when the fetch step has already fast-
   * forwarded the working tree — the pull effectively succeeded in that
   * case and a thrown error would surface as a red toast.
   */
  async gitPull(input: WorkspaceGitInput): Promise<{ ok: true }> {
    const workspaceId = toWorkspaceId(input.project, input.branch);
    const workspace = this.resolve(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(input.branch);
    }
    if (workspace.project.kind === "plain") {
      throw new PlainProjectError(
        `Project "${input.project}" is a plain (non-git) project. Git pull is not available.`,
      );
    }
    const cwd = workspace.worktree.path;
    try {
      await execGit(["pull", "--rebase"], cwd);
    } catch (e) {
      // git pull --rebase can exit non-zero with "Cannot rebase onto
      // multiple branches" when the fetch step already fast-forwarded the
      // working tree. The pull effectively succeeded, so swallow this
      // specific error.
      const msg = String(e);
      if (msg.includes("Cannot rebase onto multiple branches")) {
        return { ok: true };
      }
      throw e;
    }
    return { ok: true };
  }

  /**
   * `git push` inside the workspace's worktree. Falls back to
   * `git push --set-upstream origin <branch>` on first push when no
   * upstream is configured.
   *
   * The fallback only fires when git reports "no upstream branch" — all
   * other failures (auth, rejected push, network, …) rethrow immediately
   * so the real error surfaces to the caller instead of being masked by
   * a second failing push.
   */
  async gitPush(input: WorkspaceGitInput): Promise<{ ok: true }> {
    const workspaceId = toWorkspaceId(input.project, input.branch);
    const workspace = this.resolve(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(input.branch);
    }
    if (workspace.project.kind === "plain") {
      throw new PlainProjectError(
        `Project "${input.project}" is a plain (non-git) project. Git push is not available.`,
      );
    }
    const cwd = workspace.worktree.path;
    try {
      await execGit(["push"], cwd);
    } catch (err) {
      // git's "no upstream configured" error reads roughly:
      //   fatal: The current branch <name> has no upstream branch.
      // Anything else — auth, rejected push, network — should bubble up
      // unchanged so the user sees the real cause instead of a misleading
      // second-push failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/has no upstream branch/i.test(msg)) {
        throw err;
      }
      await execGit(["push", "--set-upstream", "origin", input.branch], cwd);
    }
    return { ok: true };
  }

  /**
   * Execute a `.band/<scriptType>` shell script in the given directory.
   *
   * Used by the dashboard's "Run script" actions on a workspace
   * (e.g. `on-create`, `on-open`). Returns once the script exits 0;
   * rejects on a non-zero exit. The script is run via
   * `bash <scriptPath>` — execFile, not a shell-spawned command, so no
   * shell interpretation of `input.path` / `input.scriptType` is
   * possible.
   *
   * Missing-script case throws a generic `Error` (not a domain class) so
   * tRPC surfaces it as `INTERNAL_SERVER_ERROR` (500). The wire-level
   * contract is pinned by `workspaces.runScript returns error for missing
   * script` in `apps/web/tests/trpc.test.ts`; a 4xx mapping would be
   * semantically nicer but would break the existing test and any client
   * pattern-matching on status.
   */
  async runScript(input: WorkspaceRunScriptInput): Promise<{ ok: true }> {
    const scriptPath = join(input.path, ".band", input.scriptType);
    if (!existsSync(scriptPath)) {
      throw new Error(`Script "${input.scriptType}" not found`);
    }

    try {
      await execFileAsync("bash", [scriptPath], { cwd: input.path });
    } catch (err) {
      // Rewrap as a plain `Error` carrying just the message — preserves the
      // legacy router's behaviour, where the callback-style failure path
      // surfaced `new Error(err.message)` rather than the original
      // `ChildProcessError` (which would have leaked subprocess metadata
      // into the tRPC response body).
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }
}

/**
 * Shared singleton consumed by the API tier (workspaces router) and any
 * future non-tRPC entry points (CLI, scripts). `WorkspaceService` is
 * stateless aside from its `queries` dependency, so one instance is safe
 * across callers.
 */
export const workspaceService = new WorkspaceService();
