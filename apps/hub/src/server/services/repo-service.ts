import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitRunner, type Host } from "@band-app/host-api";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { TRPCError } from "@trpc/server";
import {
  type RepoKind,
  RepoQueries,
  type RepoState,
  reconcileKindForRepo,
  type WorktreeState,
} from "../infra/db/queries/repos";
import { WorktreeStatusQueries } from "../infra/db/queries/worktree-statuses";
import type { WorktreeAgentInfo } from "../infra/events/status-event-bus";
import { hostRegistry } from "../infra/host/registry";
import { GIT_SPAWN_CONCURRENCY, mapLimited } from "./_utils/map-limited";
import { refreshRemoteWorktrees } from "./_utils/remote-worktrees";
import { ephemeralLifecycleService, type WorktreeLifecycle } from "./ephemeral-lifecycle-service";
import {
  type RepoAvatarInfo,
  type RepoAvatarService,
  repoAvatarService,
} from "./repo-avatar-service";
import { type SettingsService, settingsService } from "./settings-service";

/**
 * Business logic for managing Band repos — Phase 2 of the 3-tier
 * refactor (`docs/web-architecture.md`).
 *
 * Owns the lifecycle of `RepoState` rows: add, list, promote (plain →
 * git), reorder, label, remove. Each operation is a thin orchestration of
 * the infra adapters it depends on (`RepoQueries` for the DB,
 * the repo's host for the shell-out to git, `SettingsService` for the
 * label / worktrees-dir lookup) — no SQL or `execFile` calls live here.
 *
 * Cross-domain teardown (cronjob cleanup on repo removal, worktree
 * removal when a worktree's repo is deleted) stays in the router so
 * the composition is visible at the API surface. The service does its
 * own slice of the work and returns; the caller chains the rest. See
 * `docs/web-architecture.md` for the rationale.
 */
export class RepoService {
  constructor(
    private readonly queries: RepoQueries = new RepoQueries(),
    private readonly settings: SettingsService = settingsService,
    private readonly statusQueries: WorktreeStatusQueries = new WorktreeStatusQueries(),
    private readonly avatars: RepoAvatarService = repoAvatarService,
  ) {}

  /** Where a repo's main checkout is on the hub's machine, or `undefined` for an unknown repo. */
  findPath(name: string): string | undefined {
    return this.queries.findLocation(name)?.path;
  }

  /**
   * Snapshot of the repos table joined with the dashboard-facing
   * extras: `labels` from settings and per-worktree `worktreeId` /
   * `agent` from the worktree_statuses table. For git repos we
   * enrich each tracked worktree with the live `git worktree list`
   * output so the dashboard sees up-to-the-second branch / HEAD info
   * rather than the cached snapshot that `syncWorktrees` writes
   * every CI tick.
   *
   * Read-only: the inline `reconcileKindForRepo` call mutates the
   * in-memory snapshot so the response reflects on-disk reality, but
   * the DB is not written from here — tRPC queries shouldn't write,
   * and the next `syncWorktrees` tick persists the same change anyway.
   * See `runFirstTimeSetup` for the boot-time persistence path and
   * `branch-status-poller` for the recurring one.
   */
  async list(): Promise<{
    repos: Array<{
      name: string;
      path: string;
      defaultBranch: string;
      label: string | undefined;
      kind: RepoKind;
      /** Owner avatar when `origin` is on GitHub; `null` otherwise. */
      avatar: RepoAvatarInfo | null;
      worktrees: Array<{
        name: string;
        branch: string;
        path: string;
        head?: string;
        pinned: boolean;
        /** The remote host the worktree lives on. Absent for the hub's own machine. */
        hostId?: string;
        /** The project the worktree belongs to (plan step 6.1). Absent when it has none. */
        projectId?: string;
        /** Set while the worktree's ephemeral worker has exited (`sleeping`) or is coming back (`waking`). */
        lifecycle?: WorktreeLifecycle;
        worktreeId: string;
        // `WorktreeAgentInfo` is the per-worktree agent snapshot owned
        // by the infra status event-bus (`infra/events/status-event-bus.ts`).
        // The runtime expression below (`status?.agent ?? null`) discards
        // the `undefined` arm, so the wire type is `WorktreeAgentInfo |
        // null` — `NonNullable` isn't needed because the source type is
        // already non-undefined, but `| null` matches the null fallback.
        agent: WorktreeAgentInfo | null;
      }>;
    }>;
    labels: NonNullable<ReturnType<SettingsService["get"]>["labels"]>;
  }> {
    const repos = this.queries.loadAll();
    const settings = this.settings.get();
    const statuses = this.statusQueries.loadCurrent();
    const statusMap = new Map(statuses.map((s) => [s.worktreeId, s]));
    const lifecycles = ephemeralLifecycleService.states();

    // Inline, read-only kind re-detection via the shared helper.
    // Persistence lives in `syncWorktrees` (called on every branch-
    // status-poller tick and once at boot from `runFirstTimeSetup`) so
    // this query doesn't write to the DB — but the response still
    // needs to reflect on-disk reality, otherwise a freshly-booted
    // dashboard showing pre-migration "git" rows would render
    // incorrectly until the first poller tick fires AND the next 30 s
    // refetch lands. We discard the return value (not persisting) and
    // just rely on the helper to mutate `repo.kind` /
    // `repo.worktrees` in place.
    for (const repo of repos) {
      reconcileKindForRepo(repo);
    }

    // A few repos at a time: each runs `git worktree list` (plus, about
    // once a minute, the avatar's `git remote`, so up to twice
    // `GIT_SPAWN_CONCURRENCY` git calls), and the dashboard refetches this
    // every 30 s.
    const result = await mapLimited(repos, GIT_SPAWN_CONCURRENCY, async (repo) => {
      // Reads the memoised remote and the on-disk cache only; the GitHub
      // fetch happens when the browser requests `avatar.src`. Started
      // here so its `git remote` call overlaps `git worktree list`.
      const avatar = this.avatars.describe(repo).catch(() => null);
      // Plain repos have a single implicit worktree whose path equals
      // the repo path. They don't have a `.git` directory, so we skip
      // the `git worktree list` enrichment entirely and rely on the
      // worktree row that `add` synthesized into state.
      let worktrees = repo.worktrees;
      if (repo.kind === "git") {
        // state.json is the canonical "tracked worktrees" set — git's view
        // is just used to enrich each entry with current path/head. We
        // intersect the two so a worktree removed from state.json (e.g.
        // by worktrees.remove, which updates state.json synchronously and
        // defers the slow `git worktree remove` / `git branch -D` to a
        // background task) disappears from the list immediately, even
        // before the async cleanup has finished pruning the on-disk
        // worktree. Without this filter, the list reads stale data from
        // `git worktree list` and shows just-deleted worktrees until the
        // background cleanup completes.
        // Map by PATH (not branch) so we can preserve Band-owned metadata
        // git doesn't know about — the immutable `name` identity and the
        // `pinned` flag — when merging git's view with our tracked state.
        // Path is stable across a git branch switch; the branch is exactly
        // what changes. Keying by branch here would drop a just-switched
        // worktree from the list (and reset its `name`/`pinned`) in the
        // window before the next sync tick reconciles the tracked branch.
        // This mirrors the path-keyed merge in `sync-service.ts`.
        // Worktrees on a remote host are not in this machine's `git worktree
        // list`, so they pass through as tracked.
        const isRemote = (wt: { hostId?: string }) =>
          wt.hostId !== undefined && wt.hostId !== "local";
        const remoteWorktrees = repo.worktrees.filter(isRemote);
        const trackedByPath = new Map(
          repo.worktrees.filter((wt) => !isRemote(wt)).map((wt) => [wt.path, wt]),
        );
        try {
          const gitWorktrees = await hostRegistry.hostForRepo(repo.name).worktree.list(repo.path);
          const local: WorktreeState[] = gitWorktrees
            .filter((wt) => !wt.isBare && trackedByPath.has(wt.path))
            .map((wt) => {
              const tracked = trackedByPath.get(wt.path);
              return {
                // Carry the stable identity from the tracked row; fall back
                // to the branch for worktrees git knows about but state
                // doesn't.
                name: tracked?.name ?? wt.branch,
                branch: wt.branch,
                path: wt.path,
                head: wt.head,
                pinned: tracked?.pinned ?? false,
                ...(tracked?.projectId ? { projectId: tracked.projectId } : {}),
              };
            });
          worktrees = [
            ...local,
            ...(await refreshRemoteWorktrees(repo.name, repo.path, remoteWorktrees)).worktrees,
          ];
        } catch {
          // Fall back to tracked worktrees
        }
      }

      return {
        name: repo.name,
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        label: repo.label,
        kind: repo.kind,
        avatar: await avatar,
        worktrees: worktrees.map((wt) => {
          // Identity is by the immutable `name`, not the live branch.
          const worktreeId = toWorktreeId(repo.name, wt.name);
          const status = statusMap.get(worktreeId);
          const lifecycle = lifecycles.get(worktreeId);
          return {
            ...wt,
            worktreeId,
            ...(lifecycle ? { lifecycle } : {}),
            agent: status?.agent ?? null,
          };
        }),
      };
    });

    return { repos: result, labels: settings.labels ?? [] };
  }

  /**
   * Probe whether `path` (any absolute or relative directory) is a git
   * repo today. Used by the "Add repo" dialog to enable/disable the
   * `git init` checkbox. Read-only — never touches state.
   */
  checkPath(path: string): { isGitRepo: boolean } {
    const resolvedPath = resolve(path);
    const isGitRepo = existsSync(join(resolvedPath, ".git"));
    return { isGitRepo };
  }

  /**
   * Run `git init` in `path`. The "promote a plain folder to git" hook
   * used by the Add Repo dialog when the user opts in to git
   * features at the same time as registering the repo.
   */
  async gitInit(path: string): Promise<void> {
    const resolvedPath = resolve(path);
    await hostRegistry.hostForRepo(basename(resolvedPath)).git.exec(["init"], resolvedPath);
  }

  /**
   * Register a repo at `path`. Detects `kind` from the presence of
   * `.git`, seeds an initial worktree list (one synthetic `main`
   * worktree for plain repos, every existing branch for git
   * repos), validates that the optional `label` exists, and
   * persists. Returns the newly created `RepoState` for the router
   * to relay back to the client.
   */
  async add({ path, label }: { path: string; label?: string }): Promise<RepoState> {
    const repos = this.queries.loadAll();
    const name = basename(path);

    if (repos.some((p) => p.name === name)) {
      throw new Error(`Repo "${name}" already registered`);
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

    // Detect repo kind from the presence of `.git`. Plain (non-git)
    // folders skip the symbolic-ref / listWorktrees probes entirely and
    // get a single synthesized worktree pointing at the repo path —
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
    const kind: RepoKind = existsSync(join(resolvedPath, ".git")) ? "git" : "plain";

    let defaultBranch = "main";
    let worktrees: WorktreeState[] = [];

    if (kind === "git") {
      const branch = await currentBranch(hostRegistry.hostForRepo(name), resolvedPath);
      if (branch) defaultBranch = branch;

      try {
        const gitWorktrees = await hostRegistry.hostForRepo(name).worktree.list(resolvedPath);
        worktrees = gitWorktrees
          .filter((wt) => !wt.isBare)
          // Seed `name` = branch at registration; from here it's immutable
          // (sync updates `branch` only) so the id stays stable.
          .map((wt) => ({
            name: wt.branch,
            branch: wt.branch,
            path: wt.path,
            head: wt.head,
            pinned: false,
          }));
      } catch {
        // No worktrees
      }
    } else {
      // Plain repos get exactly one implicit worktree whose path is
      // the repo path. We use "main" as the synthetic branch name so
      // worktreeId stays deterministic (`{name}-main`), even though the
      // folder has no actual branch. UI gating prevents the user from
      // creating other worktrees or invoking branch/PR features.
      //
      // Use `resolvedPath` (not the input) so paths with trailing
      // slashes, `./` prefixes, or `..` segments are normalized — keeps
      // the stored worktree path consistent with the `.git` probe and
      // with the implicit assumption elsewhere that worktree paths are
      // canonical.
      worktrees = [{ name: "main", branch: "main", path: resolvedPath, pinned: false }];
    }

    const repo: RepoState = {
      name,
      // Store the canonical path so downstream consumers
      // (cronjob-scheduler, branch-status-poller, etc.) and the
      // self-heal loop in `list` can compare against
      // `existsSync(repo.path)` without false negatives from
      // unnormalized input.
      path: resolvedPath,
      defaultBranch,
      worktrees,
      label,
      kind,
      // For git repos, default to `true` so the first CI poll
      // still runs the GraphQL query — `syncWorktrees` writes the
      // real value on the next tick. For plain repos there's no
      // remote by construction, so set `false` directly: sync skips
      // plain repos (`kind !== "plain"` filter), so this initial
      // value sticks for the lifetime of the row. See issue #458.
      hasOrigin: kind === "git",
    };

    repos.push(repo);
    this.queries.saveAll(repos);

    return repo;
  }

  /**
   * Run `git init` inside a plain repo and flip its kind to "git".
   * The "promote to git" escape hatch from #427: lets a user start with
   * a plain folder and later opt into branches/PRs without re-adding the
   * repo. After promotion, the existing implicit worktree becomes
   * the repo's default-branch worktree (its path is already the
   * repo path, which matches git's convention for the main worktree).
   */
  async promoteToGit(name: string): Promise<{ ok: true; kind: RepoKind; defaultBranch: string }> {
    const repos = this.queries.loadAll();
    const repo = repos.find((p) => p.name === name);
    if (!repo) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Repo "${name}" not found` });
    }
    if (repo.kind === "git") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Repo "${name}" is already a git repo`,
      });
    }
    // Pre-flight: if the folder was moved/deleted between `add` and the
    // promote click, `git init` would surface a raw subprocess ENOENT
    // ("cannot change to '...'") with no diagnostic context. Bail with
    // a clear message instead so the user knows to re-add.
    if (!existsSync(repo.path)) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Repo path "${repo.path}" no longer exists. Remove the repo and re-add it.`,
      });
    }

    // `git init -b main` pins HEAD to refs/heads/main so the implicit
    // "main" worktree's branch matches the repo's HEAD regardless of
    // the user's `init.defaultBranch` config. Without this, a user
    // whose git defaults to "master" would end up with a worktreeId
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
    await hostRegistry.hostForRepo(repo.name).git.exec(["init", "-b", "main"], repo.path);

    repo.kind = "git";
    repo.defaultBranch = "main";
    this.queries.saveAll(repos);

    // Return the freshly mutated row's values rather than re-spelling the
    // literals — keeps the response sourced from state, which is the
    // convention every other method follows, and means a future change
    // to either side (e.g. honouring a config-file `init.defaultBranch`)
    // only has to update the mutation block above.
    return { ok: true, kind: repo.kind, defaultBranch: repo.defaultBranch };
  }

  /**
   * Remove a repo row (and its worktree children, by FK cascade).
   *
   * Repo-scoped cronjob cleanup (`cronjobService.removeForKey`) stays
   * in the API router so the cross-domain composition is visible at the
   * call site — see `docs/web-architecture.md` for the rationale.
   */
  remove(name: string): void {
    const repos = this.queries.loadAll();
    const filtered = repos.filter((p) => p.name !== name);
    this.queries.saveAll(filtered);
  }

  /**
   * Re-order the repo list to match the supplied `names` array. Any
   * repo not in `names` is sorted after the listed ones in its
   * existing relative order — matches the old `lib/state` behaviour
   * where the dashboard's drag-and-drop hands us the full ordering.
   */
  reorder(names: string[]): void {
    const repos = this.queries.loadAll();
    repos.sort((a, b) => {
      const ai = names.indexOf(a.name);
      const bi = names.indexOf(b.name);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });
    this.queries.saveAll(repos);
  }

  /**
   * Set (or clear, when `label` is `null`) the dashboard label for
   * `name`. Throws if the repo is missing — the dashboard sends
   * names from its own snapshot, so a miss here means the user's view
   * is stale and the client will refetch.
   */
  updateLabel({ name, label }: { name: string; label: string | null }): void {
    const repos = this.queries.loadAll();
    const repo = repos.find((p) => p.name === name);
    if (!repo) {
      throw new Error("Repo not found");
    }

    if (label === null || label === undefined) {
      delete repo.label;
    } else {
      repo.label = label;
    }
    this.queries.saveAll(repos);
  }

  /**
   * Resolve the worktrees directory the dashboard creates new
   * worktrees under. Exposed so consumers that already hold a
   * `RepoService` instance don't need a second `SettingsService`
   * import — the worktrees dir is fundamentally a repo-creation
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
 * Singleton consumed by the API tier. `RepoService` is stateless
 * aside from its infra dependencies, so one instance is safe across all
 * callers — and centralising the instance here means there's only one
 * place to update when a stateful field (cache, in-memory invalidation)
 * eventually lands.
 */
export const repoService = new RepoService();

/**
 * The short symbolic ref of HEAD (the current branch name), or `null` when
 * HEAD is detached or git fails. The caller falls back to `"main"`.
 */
async function currentBranch(host: Host, cwd: string): Promise<string | null> {
  try {
    const output = (await gitRunner(host)(["symbolic-ref", "--short", "HEAD"], cwd)).trim();
    return output || null;
  } catch {
    return null;
  }
}
