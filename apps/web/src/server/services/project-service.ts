import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { toWorkspaceId } from "@/dashboard";
import {
  type ProjectKind,
  ProjectQueries,
  type ProjectState,
  reconcileKindForProject,
  type WorktreeState,
} from "../infra/db/queries/projects";
import { WorkspaceStatusQueries } from "../infra/db/queries/workspace-statuses";
import { GitClient } from "../infra/git/git-client";
import type { WorkspaceAgentInfo } from "../infra/events/status-event-bus";
import { type SettingsService, settingsService } from "./settings-service";

/**
 * Business logic for managing Band projects — Phase 2 of the 3-tier
 * refactor (`docs/web-architecture.md`).
 *
 * Owns the lifecycle of `ProjectState` rows: add, list, promote (plain →
 * git), reorder, label, remove. Each operation is a thin orchestration of
 * the infra adapters it depends on (`ProjectQueries` for the DB,
 * `GitClient` for the shell-out to git, `SettingsService` for the
 * label / worktrees-dir lookup) — no SQL or `execFile` calls live here.
 *
 * Cross-domain teardown (cronjob cleanup on project removal, worktree
 * removal when a workspace's project is deleted) stays in the router so
 * the composition is visible at the API surface. The service does its
 * own slice of the work and returns; the caller chains the rest. See
 * `docs/web-architecture.md` for the rationale.
 */
export class ProjectService {
  constructor(
    private readonly queries: ProjectQueries = new ProjectQueries(),
    private readonly git: GitClient = new GitClient(),
    private readonly settings: SettingsService = settingsService,
    private readonly statusQueries: WorkspaceStatusQueries = new WorkspaceStatusQueries(),
  ) {}

  /**
   * Snapshot of the projects table joined with the dashboard-facing
   * extras: `labels` from settings and per-worktree `workspaceId` /
   * `agent` from the workspace_statuses table. For git projects we
   * enrich each tracked worktree with the live `git worktree list`
   * output so the dashboard sees up-to-the-second branch / HEAD info
   * rather than the cached snapshot that `syncWorktrees` writes
   * every CI tick.
   *
   * Read-only: the inline `reconcileKindForProject` call mutates the
   * in-memory snapshot so the response reflects on-disk reality, but
   * the DB is not written from here — tRPC queries shouldn't write,
   * and the next `syncWorktrees` tick persists the same change anyway.
   * See `runFirstTimeSetup` for the boot-time persistence path and
   * `branch-status-poller` for the recurring one.
   */
  async list(): Promise<{
    projects: Array<{
      name: string;
      path: string;
      defaultBranch: string;
      label: string | undefined;
      kind: ProjectKind;
      worktrees: Array<{
        branch: string;
        path: string;
        head?: string;
        pinned: boolean;
        workspaceId: string;
        // `WorkspaceAgentInfo` is the per-workspace agent snapshot owned
        // by the infra status event-bus (`infra/events/status-event-bus.ts`).
        // The runtime expression below (`status?.agent ?? null`) discards
        // the `undefined` arm, so the wire type is `WorkspaceAgentInfo |
        // null` — `NonNullable` isn't needed because the source type is
        // already non-undefined, but `| null` matches the null fallback.
        agent: WorkspaceAgentInfo | null;
      }>;
    }>;
    labels: NonNullable<ReturnType<SettingsService["get"]>["labels"]>;
  }> {
    const projects = this.queries.loadAll();
    const settings = this.settings.get();
    const statuses = this.statusQueries.loadCurrent();
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
    for (const project of projects) {
      reconcileKindForProject(project);
    }

    const result = await Promise.all(
      projects.map(async (project) => {
        // Plain projects have a single implicit workspace whose path equals
        // the project path. They don't have a `.git` directory, so we skip
        // the `git worktree list` enrichment entirely and rely on the
        // workspace row that `add` synthesized into state.
        let worktrees = project.worktrees;
        if (project.kind === "git") {
          // state.json is the canonical "tracked workspaces" set — git's view
          // is just used to enrich each entry with current path/head. We
          // intersect the two so a workspace removed from state.json (e.g.
          // by workspaces.remove, which updates state.json synchronously and
          // defers the slow `git worktree remove` / `git branch -D` to a
          // background task) disappears from the list immediately, even
          // before the async cleanup has finished pruning the on-disk
          // worktree. Without this filter, the list reads stale data from
          // `git worktree list` and shows just-deleted workspaces until the
          // background cleanup completes.
          const trackedBranches = new Set(project.worktrees.map((wt) => wt.branch));
          // Map by branch so we can preserve metadata (e.g. `pinned`) that git
          // doesn't know about when merging git's view with our tracked state.
          const trackedByBranch = new Map(project.worktrees.map((wt) => [wt.branch, wt]));
          try {
            const gitWorktrees = await this.git.listWorktrees(project.path);
            worktrees = gitWorktrees
              .filter((wt) => !wt.isBare && trackedBranches.has(wt.branch))
              .map((wt) => ({
                branch: wt.branch,
                path: wt.path,
                head: wt.head,
                pinned: trackedByBranch.get(wt.branch)?.pinned ?? false,
              }));
          } catch {
            // Fall back to tracked worktrees
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

    return { projects: result, labels: settings.labels ?? [] };
  }

  /**
   * Probe whether `path` (any absolute or relative directory) is a git
   * repo today. Used by the "Add project" dialog to enable/disable the
   * `git init` checkbox. Read-only — never touches state.
   */
  checkPath(path: string): { isGitRepo: boolean } {
    const resolvedPath = resolve(path);
    const isGitRepo = existsSync(join(resolvedPath, ".git"));
    return { isGitRepo };
  }

  /**
   * Run `git init` in `path`. The "promote a plain folder to git" hook
   * used by the Add Project dialog when the user opts in to git
   * features at the same time as registering the project.
   */
  async gitInit(path: string): Promise<void> {
    const resolvedPath = resolve(path);
    await this.git.init(resolvedPath);
  }

  /**
   * Register a project at `path`. Detects `kind` from the presence of
   * `.git`, seeds an initial worktree list (one synthetic `main`
   * workspace for plain projects, every existing branch for git
   * projects), validates that the optional `label` exists, and
   * persists. Returns the newly created `ProjectState` for the router
   * to relay back to the client.
   */
  async add({ path, label }: { path: string; label?: string }): Promise<ProjectState> {
    const projects = this.queries.loadAll();
    const name = basename(path);

    if (projects.some((p) => p.name === name)) {
      throw new Error(`Project "${name}" already registered`);
    }

    if (label) {
      const settings = this.settings.get();
      const validIds = (settings.labels ?? []).map((l) => l.id);
      if (!validIds.includes(label)) {
        throw new Error(
          `Label "${label}" does not exist. Valid labels: ${validIds.join(", ") || "(none)"}`,
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
    const resolvedPath = resolve(path);
    const kind: ProjectKind = existsSync(join(resolvedPath, ".git")) ? "git" : "plain";

    let defaultBranch = "main";
    let worktrees: WorktreeState[] = [];

    if (kind === "git") {
      const branch = await this.git.currentBranch(resolvedPath);
      if (branch) defaultBranch = branch;

      try {
        const gitWorktrees = await this.git.listWorktrees(resolvedPath);
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
      // Use `resolvedPath` (not the input) so paths with trailing
      // slashes, `./` prefixes, or `..` segments are normalized — keeps
      // the stored workspace path consistent with the `.git` probe and
      // with the implicit assumption elsewhere that workspace paths are
      // canonical.
      worktrees = [{ branch: "main", path: resolvedPath, pinned: false }];
    }

    const project: ProjectState = {
      name,
      // Store the canonical path so downstream consumers
      // (cronjob-scheduler, branch-status-poller, etc.) and the
      // self-heal loop in `list` can compare against
      // `existsSync(project.path)` without false negatives from
      // unnormalized input.
      path: resolvedPath,
      defaultBranch,
      worktrees,
      label,
      kind,
      // For git projects, default to `true` so the first CI poll
      // still runs the GraphQL query — `syncWorktrees` writes the
      // real value on the next tick. For plain projects there's no
      // remote by construction, so set `false` directly: sync skips
      // plain projects (`kind !== "plain"` filter), so this initial
      // value sticks for the lifetime of the row. See issue #458.
      hasOrigin: kind === "git",
    };

    projects.push(project);
    this.queries.saveAll(projects);

    return project;
  }

  /**
   * Run `git init` inside a plain project and flip its kind to "git".
   * The "promote to git" escape hatch from #427: lets a user start with
   * a plain folder and later opt into branches/PRs without re-adding the
   * project. After promotion, the existing implicit workspace becomes
   * the project's default-branch worktree (its path is already the
   * project path, which matches git's convention for the main worktree).
   */
  async promoteToGit(
    name: string,
  ): Promise<{ ok: true; kind: ProjectKind; defaultBranch: string }> {
    const projects = this.queries.loadAll();
    const project = projects.find((p) => p.name === name);
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Project "${name}" not found` });
    }
    if (project.kind === "git") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Project "${name}" is already a git project`,
      });
    }
    // Pre-flight: if the folder was moved/deleted between `add` and the
    // promote click, `git init` would surface a raw subprocess ENOENT
    // ("cannot change to '...'") with no diagnostic context. Bail with
    // a clear message instead so the user knows to re-add.
    if (!existsSync(project.path)) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project path "${project.path}" no longer exists. Remove the project and re-add it.`,
      });
    }

    // `git init -b main` pins HEAD to refs/heads/main so the implicit
    // "main" workspace's branch matches the repo's HEAD regardless of
    // the user's `init.defaultBranch` config. Without this, a user
    // whose git defaults to "master" would end up with a workspaceId
    // (`{name}-main`) that doesn't correspond to any real branch.
    // `git init` is idempotent — if `.git` somehow appeared between
    // the initial `add` probe and now, this is a no-op rather than
    // an error.
    //
    // The on-disk `.git` is created BEFORE saveAll persists `kind:
    // "git"`. If the process crashes in this window, the next `list`
    // call will self-heal (see the kind re-detection loop there): the
    // folder has `.git` so the recorded kind flips to "git"
    // automatically. So the non-atomic ordering is intentional and
    // self-correcting; don't reorder.
    await this.git.init(project.path, "main");

    project.kind = "git";
    project.defaultBranch = "main";
    this.queries.saveAll(projects);

    // Return the freshly mutated row's values rather than re-spelling the
    // literals — keeps the response sourced from state, which is the
    // convention every other method follows, and means a future change
    // to either side (e.g. honouring a config-file `init.defaultBranch`)
    // only has to update the mutation block above.
    return { ok: true, kind: project.kind, defaultBranch: project.defaultBranch };
  }

  /**
   * Remove a project row (and its worktree children, by FK cascade).
   *
   * Project-scoped cronjob cleanup (`cronjobService.removeForKey`) stays
   * in the API router so the cross-domain composition is visible at the
   * call site — see `docs/web-architecture.md` for the rationale.
   */
  remove(name: string): void {
    const projects = this.queries.loadAll();
    const filtered = projects.filter((p) => p.name !== name);
    this.queries.saveAll(filtered);
  }

  /**
   * Re-order the project list to match the supplied `names` array. Any
   * project not in `names` is sorted after the listed ones in its
   * existing relative order — matches the old `lib/state` behaviour
   * where the dashboard's drag-and-drop hands us the full ordering.
   */
  reorder(names: string[]): void {
    const projects = this.queries.loadAll();
    projects.sort((a, b) => {
      const ai = names.indexOf(a.name);
      const bi = names.indexOf(b.name);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });
    this.queries.saveAll(projects);
  }

  /**
   * Set (or clear, when `label` is `null`) the dashboard label for
   * `name`. Throws if the project is missing — the dashboard sends
   * names from its own snapshot, so a miss here means the user's view
   * is stale and the client will refetch.
   */
  updateLabel({ name, label }: { name: string; label: string | null }): void {
    const projects = this.queries.loadAll();
    const project = projects.find((p) => p.name === name);
    if (!project) {
      throw new Error("Project not found");
    }

    if (label === null || label === undefined) {
      delete project.label;
    } else {
      project.label = label;
    }
    this.queries.saveAll(projects);
  }

  /**
   * Resolve the worktrees directory the dashboard creates new
   * workspaces under. Exposed so consumers that already hold a
   * `ProjectService` instance don't need a second `SettingsService`
   * import — the worktrees dir is fundamentally a project-creation
   * concern.
   */
  worktreesDir(): string {
    // Delegate to the settings service so the worktrees-dir resolution
    // stays a single source of truth — same code path the legacy
    // `lib/state.worktreesDir()` shim calls through.
    return this.settings.worktreesDir();
  }
}

/**
 * Singleton consumed by the API tier. `ProjectService` is stateless
 * aside from its infra dependencies, so one instance is safe across all
 * callers — and centralising the instance here means there's only one
 * place to update when a stateful field (cache, in-memory invalidation)
 * eventually lands.
 */
export const projectService = new ProjectService();
