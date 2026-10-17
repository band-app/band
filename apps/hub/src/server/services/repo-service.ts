import { existsSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";

import { gitRunner, type Host } from "@band-app/host-api";
import type { ContinuedFrom, Divergence } from "@band-app/shared/continuation";
import { parseRemoteUrl } from "@band-app/shared/remote-url";
import { checkpointsEnabledFor, isHostAllowed } from "@band-app/shared/repo-hosts";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { TRPCError } from "@trpc/server";

import { RepoConflictError, RepoInputError, RepoOutsideRootsError } from "../errors";
import {
  type RepoKind,
  RepoQueries,
  type RepoState,
  reconcileKindForRepo,
  type WorktreeState,
} from "../infra/db/queries/repos";
import { CheckpointQueries } from "../infra/db/queries/worktree-checkpoints";
import { WorktreeStatusQueries } from "../infra/db/queries/worktree-statuses";
import type { WorktreeAgentInfo } from "../infra/events/status-event-bus";
import { isLocalHostEnabled } from "../infra/host/local-host-enabled";
import { hostRegistry } from "../infra/host/registry";
import { forgetCheckpoints } from "./_utils/checkpoint-store";
import { GIT_SPAWN_CONCURRENCY, mapLimited } from "./_utils/map-limited";
import { refreshRemoteWorktrees } from "./_utils/remote-worktrees";
import {
  assertHostAllowed,
  hostNamesOf,
  listedWorktrees,
  mainMissingOf,
  primaryHostOf,
} from "./_utils/repo-host-policy";
import { ephemeralLifecycleService, type WorktreeLifecycle } from "./ephemeral-lifecycle-service";
import {
  type RepoAvatarInfo,
  type RepoAvatarService,
  repoAvatarService,
} from "./repo-avatar-service";
import { type SettingsService, settingsService } from "./settings-service";
import { pruneMissing } from "./sync-service";
import { tokenService } from "./token-service";
import { vaultService } from "./vault-service";

/** Whether `path` is one of `roots` or inside one. Trailing slashes are ignored, so `/` covers everything. */
function isInsideRoots(path: string, roots: string[]): boolean {
  const trim = (p: string) => p.replace(/\/+$/, "");
  const at = trim(path);
  return roots.some((root) => {
    const r = trim(root);
    return at === r || at.startsWith(`${r}/`);
  });
}

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
/** What `addFromWorker` answers: the repo, plus the clone it registered when the repo already existed. */
export type AddedFromWorker = RepoState & {
  existed?: true;
  clone?: { hostId: string; hostName: string; path: string };
};

export class RepoService {
  private readonly checkpointQueries = new CheckpointQueries();

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
      /** The folder on the hub's own machine, or "" when the hub holds no checkout. */
      path: string;
      /** The remote the repo is identified by, without credentials. Absent for a plain folder or a repo with no remote. */
      remoteUrl: string | undefined;
      /** Where each host keeps the repo: the folder on the hub's machine and on each worker that has it. */
      clones: Array<{ hostId: string; path: string }>;
      defaultBranch: string;
      label: string | undefined;
      kind: RepoKind;
      /** Whether the repo is a meta repo, where work in other repos is started from. */
      meta: boolean;
      /** The hosts the repo may run on, or null for every host. */
      allowedHostIds: string[] | null;
      /** The host whose default-branch checkout is listed as a worktree, once one is known. */
      primaryHostId: string | null;
      /** Set when no host lists a default-branch checkout: the primary host, whose clone is not on it. */
      mainMissing: { hostId: string } | null;
      /** Whether the hub keeps checkpoints of this repo's worktrees (the stored choice, else the default). */
      checkpointsEnabled: boolean;
      /** The stored choice, or null when the repo follows the default. */
      checkpointsSetting: boolean | null;
      /** Whether a worktree whose host is offline continues on another host without asking. */
      autoContinue: boolean;
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
        /** True when the repo is no longer allowed on this worktree's host. The worktree is kept and still opens. */
        hostNotAllowed?: boolean;
        /** Set while the worktree's ephemeral worker has exited (`sleeping`) or is coming back (`waking`). */
        lifecycle?: WorktreeLifecycle;
        /** Set when this copy was restored on another host. The value is the replacement's worktree id. */
        supersededBy?: string;
        /** Set on a copy a continuation created: where the work came from. */
        continuedFrom?: ContinuedFrom;
        /** Set on a superseded copy once its host is back: whether it holds changes the continuation missed. */
        divergence?: Divergence;
        /** When the hub took the newest checkpoint of this worktree, or null when it has none. */
        lastCheckpointAt: number | null;
        worktreeId: string;
        // `WorktreeAgentInfo` is the per-worktree agent snapshot owned
        // by the infra status event-bus (`infra/events/status-event-bus.ts`).
        // The runtime expression below (`status?.agent ?? null`) discards
        // the `undefined` arm, so the wire type is `WorktreeAgentInfo |
        // null` — `NonNullable` isn't needed because the source type is
        // already non-undefined, but `| null` matches the null fallback.
        agent: WorktreeAgentInfo | null;
        /** Where the worktree was started from, or null for top-level work. */
        origin: WorktreeOriginInfo | null;
        /** Ids of the worktrees started from this one, on any repo and host. */
        children: string[];
      }>;
    }>;
    labels: NonNullable<ReturnType<SettingsService["get"]>["labels"]>;
  }> {
    const repos = this.queries.loadAll();
    const settings = this.settings.get();
    const statuses = this.statusQueries.loadCurrent();
    const statusMap = new Map(statuses.map((s) => [s.worktreeId, s]));
    const lifecycles = ephemeralLifecycleService.states();
    const lastCheckpoints = this.checkpointQueries.latestTimes();
    const hostPaths = this.queries.allHostPaths();
    const links = originLinks(repos);

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
      if (repo.kind === "git" && (!repo.path || !isLocalHostEnabled())) {
        // No checkout on the hub's machine: its worktrees are on workers.
        try {
          worktrees = (await refreshRemoteWorktrees(repo.name, repo.path, repo.worktrees))
            .worktrees;
        } catch {
          // Fall back to tracked worktrees
        }
      } else if (repo.kind === "git") {
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
                ...(tracked?.sortIndex === undefined ? {} : { sortIndex: tracked.sortIndex }),
                ...(tracked?.pinSortIndex === undefined
                  ? {}
                  : { pinSortIndex: tracked.pinSortIndex }),
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

      // The dashboard lists every 30 s, which is the scan that notices a vanished folder.
      pruneMissing(repo.name, worktrees);

      return {
        name: repo.name,
        path: repo.path,
        remoteUrl: repo.remoteUrl,
        clones: [...(hostPaths.get(repo.name) ?? new Map<string, string>())].map(
          ([hostId, path]) => ({ hostId, path }),
        ),
        defaultBranch: repo.defaultBranch,
        label: repo.label,
        kind: repo.kind,
        meta: repo.meta ?? false,
        allowedHostIds: repo.allowedHostIds ?? null,
        primaryHostId: primaryHostOf({ ...repo, worktrees }),
        mainMissing: mainMissingOf({ ...repo, worktrees }),
        checkpointsEnabled: checkpointsEnabledFor(repo.checkpointsEnabled, repo.allowedHostIds),
        checkpointsSetting: repo.checkpointsEnabled ?? null,
        autoContinue: repo.autoContinue ?? false,
        avatar: await avatar,
        // The default-branch checkout of every host but the primary one is a hidden cache.
        worktrees: listedWorktrees({ ...repo, worktrees }).map((wt) => {
          // Identity is by the immutable `name`, not the live branch.
          const worktreeId = toWorktreeId(repo.name, wt.name, wt.hostId);
          const status = statusMap.get(worktreeId);
          const lifecycle = lifecycles.get(worktreeId);
          return {
            ...wt,
            worktreeId,
            ...(isHostAllowed(repo.allowedHostIds, wt.hostId) ? {} : { hostNotAllowed: true }),
            ...(lifecycle ? { lifecycle } : {}),
            lastCheckpointAt: lastCheckpoints.get(worktreeId) ?? null,
            agent: status?.agent ?? null,
            origin: links.origins.get(worktreeId) ?? null,
            children: links.children.get(worktreeId) ?? [],
          };
        }),
      };
    });

    return { repos: result, labels: settings.labels ?? [] };
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
    if (!isLocalHostEnabled()) {
      throw new RepoInputError(
        "This hub does not use its own machine (BAND_LOCAL_HOST=off). Add the repo from a worker or by URL.",
      );
    }
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

    // The remote is the repo's identity, so a path-based add reads it from the checkout.
    const inspected =
      kind === "git"
        ? await hostRegistry.local.repos.inspect(resolvedPath).catch(() => null)
        : null;
    const remote = inspected?.remoteUrl ? parseRemoteUrl(inspected.remoteUrl) : null;
    if (remote && repos.some((p) => p.remoteKey === remote.key)) {
      const other = repos.find((p) => p.remoteKey === remote.key);
      throw new Error(`Repo "${other?.name}" already uses the remote ${remote.url}`);
    }

    const repo: RepoState = {
      name,
      ...(remote ? { remoteUrl: remote.url, remoteKey: remote.key } : {}),
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
    if (remote) await hostRegistry.local.repos.map(remote.url, resolvedPath);

    return repo;
  }

  /**
   * Adds the repo that a folder on a host holds. The host reads the folder's `origin` URL and
   * default branch, the hub stores those, and the host's mapping and the hub's cache both record
   * that the folder is where this host keeps the repo, so no worktree there clones it again.
   * A folder with no git repository, or one with no `origin`, is added without a remote and
   * stays on that one host. A folder outside the host's roots needs `addRoot`, which the UI
   * sends after the user confirmed.
   */
  async addFromWorker(input: {
    hostId: string;
    path: string;
    label?: string;
    name?: string;
    addRoot?: boolean;
    /** Hosts the repo is limited to. Default: only the host the folder is on. `null` means every host. */
    allowedHostIds?: string[] | null;
    /** The host that lists the default branch. Default: the host the folder is on. */
    primaryHostId?: string;
  }): Promise<AddedFromWorker> {
    if (input.hostId === "local" && !isLocalHostEnabled()) {
      throw new RepoInputError("This hub does not use its own machine. Choose a worker.");
    }
    let host: Host;
    try {
      host = hostRegistry.hostById(input.hostId);
    } catch {
      throw new RepoInputError(`Unknown host "${input.hostId}"`);
    }
    const inspected = await host.repos.inspect(input.path).catch((err: unknown) => {
      throw new RepoInputError(err instanceof Error ? err.message : String(err));
    });
    const remote = inspected.remoteUrl ? parseRemoteUrl(inspected.remoteUrl) : null;
    if (inspected.remoteUrl && !remote) {
      throw new RepoInputError(`The origin URL of ${inspected.path} is not one Band can clone.`);
    }

    const repos = this.queries.loadAll();
    const existing = remote ? repos.find((r) => r.remoteKey === remote.key) : undefined;
    // A folder on a host the repo is not allowed on is not recorded as a place the repo lives.
    if (existing) assertHostAllowed(existing.name, input.hostId);
    if (input.hostId !== "local") {
      const { roots } = await host.info();
      if (!isInsideRoots(inspected.path, roots)) {
        if (!input.addRoot) throw new RepoOutsideRootsError(inspected.path, roots);
        await host.repos.addRoot(inspected.path);
      }
    }
    let repo = existing;
    if (!repo) {
      const name = this.pickName(
        repos,
        input.name ?? remote?.name ?? posix.basename(inspected.path),
        remote?.owner,
      );
      this.checkLabel(input.label);
      const kind: RepoKind = inspected.isGit ? "git" : "plain";
      const onLocal = input.hostId === "local";
      let worktrees: WorktreeState[] = [];
      if (kind === "git") {
        const listed = await host.worktree.list(inspected.path).catch(() => []);
        worktrees = listed
          .filter((wt) => !wt.isBare)
          .map((wt) => ({
            name: wt.branch,
            branch: wt.branch,
            path: wt.path,
            head: wt.head,
            pinned: false,
            ...(onLocal ? {} : { hostId: input.hostId }),
          }));
      } else {
        worktrees = [
          {
            name: "main",
            branch: "main",
            path: inspected.path,
            pinned: false,
            ...(onLocal ? {} : { hostId: input.hostId }),
          },
        ];
      }
      repo = {
        name,
        path: onLocal ? inspected.path : "",
        ...(remote ? { remoteUrl: remote.url, remoteKey: remote.key } : {}),
        defaultBranch: inspected.defaultBranch ?? "main",
        worktrees,
        label: input.label,
        kind,
        hasOrigin: kind === "git" && remote !== null,
        ...this.initialHostPolicy(input.hostId, input.allowedHostIds, input.primaryHostId),
      };
      // The awaits above may have let another change reach the database, so save a fresh tree.
      const fresh = this.queries.loadAll();
      if (fresh.some((r) => r.name === repo?.name || (remote && r.remoteKey === remote.key))) {
        throw new RepoConflictError(`Repo "${repo.name}" was added while this request ran`);
      }
      fresh.push(repo);
      this.queries.saveAll(fresh);
    }
    this.queries.setHostPath(repo.name, input.hostId, inspected.path);
    if (remote) await host.repos.map(remote.url, inspected.path);
    if (existing && inspected.isGit) {
      await this.recordCloneWorktrees(existing.name, input.hostId, inspected.path, host);
    }
    const saved = this.queries.loadAll().find((r) => r.name === repo?.name) ?? repo;
    if (!existing) return saved;
    const hostName = hostNamesOf([input.hostId])[0] ?? input.hostId;
    return {
      ...saved,
      existed: true as const,
      clone: { hostId: input.hostId, hostName, path: inspected.path },
    };
  }

  /**
   * Records the worktrees a newly registered clone holds, so a repo added again from another
   * worker shows that worker's checkouts (its default branch in particular). A branch that has a
   * listed worktree on another host is skipped, because a branch lives on one host.
   */
  private async recordCloneWorktrees(
    repoName: string,
    hostId: string,
    path: string,
    host: Host,
  ): Promise<void> {
    const listed = await host.worktree.list(path).catch(() => []);
    const fresh = this.queries.loadAll();
    const repo = fresh.find((r) => r.name === repoName);
    if (!repo) return;
    const onThisHost = (wt: { hostId?: string }) => (wt.hostId || "local") === hostId;
    let changed = false;
    for (const wt of listed) {
      if (wt.isBare || !wt.branch) continue;
      if (repo.worktrees.some((r) => r.branch === wt.branch && onThisHost(r))) continue;
      const isDefault = wt.branch === repo.defaultBranch;
      if (!isDefault && repo.worktrees.some((r) => r.branch === wt.branch)) continue;
      repo.worktrees.push({
        name: wt.branch,
        branch: wt.branch,
        path: wt.path,
        head: wt.head,
        pinned: false,
        ...(hostId === "local" ? {} : { hostId }),
      });
      changed = true;
    }
    if (changed) this.queries.saveAll(fresh);
  }

  /**
   * Adds a repo by its remote URL. The hub keeps only the URL and the default branch, and a
   * worker clones the repo the first time a worktree for it lands there. Without `defaultBranch`
   * it is read with `git ls-remote --symref` on a host (the local one, else the first online
   * worker), or from the GitHub API when the vault holds a token for the host.
   */
  async addByUrl(input: {
    remoteUrl: string;
    defaultBranch?: string;
    name?: string;
    label?: string;
    /** Hosts the repo is limited to. Default: every host. */
    allowedHostIds?: string[] | null;
    /** The host that lists the default branch. Default: the first host that clones the repo. */
    primaryHostId?: string;
  }): Promise<RepoState> {
    const remote = parseRemoteUrl(input.remoteUrl);
    if (!remote) {
      throw new RepoInputError(
        "That is not a git remote URL. Use https://host/owner/repo or git@host:owner/repo.",
      );
    }
    const repos = this.queries.loadAll();
    const dup = repos.find((r) => r.remoteKey === remote.key);
    if (dup) throw new RepoConflictError(`Repo "${dup.name}" already uses ${remote.url}`);
    this.checkLabel(input.label);
    const defaultBranch =
      input.defaultBranch?.trim() || (await this.resolveDefaultBranch(remote.url));
    const repo: RepoState = {
      name: this.pickName(repos, input.name ?? remote.name, remote.owner),
      path: "",
      remoteUrl: remote.url,
      remoteKey: remote.key,
      defaultBranch,
      worktrees: [],
      label: input.label,
      kind: "git",
      hasOrigin: true,
      ...this.initialHostPolicy(undefined, input.allowedHostIds, input.primaryHostId),
    };
    // Resolving the branch can take a while, so save a fresh tree.
    const fresh = this.queries.loadAll();
    if (fresh.some((r) => r.name === repo.name || r.remoteKey === remote.key)) {
      throw new RepoConflictError(`Repo "${repo.name}" was added while this request ran`);
    }
    fresh.push(repo);
    this.queries.saveAll(fresh);
    return repo;
  }

  /**
   * Boot step for installs that predate repos by URL. A repo registered by path has no remote
   * yet: read its `origin` from the hub's own checkout, store it, and put the folder into the
   * local host's mapping, so a worktree for the repo on a worker clones by URL and the local
   * host knows it holds the repo already. Safe to run on every boot.
   */
  async backfillRemotes(): Promise<void> {
    if (!isLocalHostEnabled()) return;
    for (const repo of this.queries.loadAll()) {
      if (!repo.path || repo.kind !== "git") continue;
      try {
        let url = repo.remoteUrl;
        if (!repo.remoteKey) {
          const inspected = await hostRegistry.local.repos.inspect(repo.path);
          const remote = inspected.remoteUrl ? parseRemoteUrl(inspected.remoteUrl) : null;
          if (!remote) continue;
          this.queries.setRemote(repo.name, remote.url, remote.key);
          url = remote.url;
        }
        if (url) {
          const mapped = (await hostRegistry.local.repos.list()).some(
            (m) => m.key === parseRemoteUrl(url as string)?.key && m.path === repo.path,
          );
          if (!mapped) await hostRegistry.local.repos.map(url, repo.path);
        }
      } catch {
        // A checkout that is gone or unreadable keeps no remote. Sync reports it.
      }
    }
  }

  /**
   * What `addFromWorker` would add for a folder, without adding it: the host's reading of the
   * folder (git or not, `origin` URL, default branch), whether it is inside the host's roots, and
   * the repo that already uses the same remote. The add-repo dialog shows this before confirming.
   */
  async inspectOnHost(hostId: string, path: string) {
    if (hostId === "local" && !isLocalHostEnabled()) {
      throw new RepoInputError("This hub does not use its own machine. Choose a worker.");
    }
    let host: Host;
    try {
      host = hostRegistry.hostById(hostId);
    } catch {
      throw new RepoInputError(`Unknown host "${hostId}"`);
    }
    const inspected = await host.repos.inspect(path).catch((err: unknown) => {
      throw new RepoInputError(err instanceof Error ? err.message : String(err));
    });
    let roots: string[] = [];
    let insideRoots = true;
    if (hostId !== "local") {
      roots = (await host.info()).roots;
      insideRoots = isInsideRoots(inspected.path, roots);
    }
    const remote = inspected.remoteUrl ? parseRemoteUrl(inspected.remoteUrl) : null;
    const repos = this.queries.loadAll();
    const existing = remote ? repos.find((r) => r.remoteKey === remote.key) : undefined;
    return {
      path: inspected.path,
      isGit: inspected.isGit,
      remoteUrl: remote?.url ?? null,
      cloneable: inspected.remoteUrl ? remote !== null : true,
      defaultBranch: inspected.defaultBranch ?? null,
      name: this.pickName(repos, remote?.name ?? posix.basename(inspected.path), remote?.owner),
      insideRoots,
      roots,
      existingRepo: existing?.name ?? null,
    };
  }

  /**
   * What `addByUrl` would add for a URL, without adding it: the normalized URL, the repo name and
   * the remote's default branch, read the same way `addByUrl` reads it.
   */
  async resolveRemote(remoteUrl: string) {
    const remote = parseRemoteUrl(remoteUrl);
    if (!remote) {
      throw new RepoInputError(
        "That is not a git remote URL. Use https://host/owner/repo or git@host:owner/repo.",
      );
    }
    const existing = this.queries.loadAll().find((r) => r.remoteKey === remote.key);
    if (existing) throw new RepoConflictError(`Repo "${existing.name}" already uses ${remote.url}`);
    const defaultBranch = await this.resolveDefaultBranch(remote.url);
    return { url: remote.url, name: remote.name, defaultBranch };
  }

  /** Lists a folder on a host for the picker. */
  browse(hostId: string, path: string | undefined) {
    let host: Host;
    try {
      host = hostRegistry.hostById(hostId);
    } catch {
      throw new RepoInputError(`Unknown host "${hostId}"`);
    }
    return host.fs.browse(path);
  }

  private checkLabel(label: string | undefined): void {
    if (!label) return;
    const validIds = (this.settings.get().labels ?? []).map((l) => l.id);
    if (!validIds.includes(label)) {
      throw new RepoInputError(
        `Label "${label}" does not exist. Valid labels: ${validIds.join(", ") || "(none)"}`,
      );
    }
  }

  /** The name for a new repo: the wanted one, else prefixed with the owner when that is taken by another repo. */
  private pickName(repos: RepoState[], wanted: string, owner: string | undefined): string {
    if (!repos.some((r) => r.name === wanted)) return wanted;
    const prefixed = owner ? `${owner.replace(/\//g, "-")}-${wanted}` : undefined;
    if (prefixed && !repos.some((r) => r.name === prefixed)) return prefixed;
    for (let n = 2; ; n++) {
      if (!repos.some((r) => r.name === `${wanted}-${n}`)) return `${wanted}-${n}`;
    }
  }

  /** Reads the remote's default branch from a host, then the GitHub API, else asks the caller to name it. */
  private async resolveDefaultBranch(url: string): Promise<string> {
    const asked = parseRemoteUrl(url);
    const hostIds = [
      ...(isLocalHostEnabled() ? ["local"] : []),
      ...tokenService
        .listHosts()
        .filter((h) => h.id !== "local" && h.status === "online")
        .map((h) => h.id),
    ];
    let failure = "no host is available to ask";
    for (const hostId of hostIds) {
      try {
        const { stdout } = await hostRegistry
          .hostById(hostId)
          .exec("git", ["ls-remote", "--symref", "--", url, "HEAD"], { timeoutMs: 60_000 });
        const match = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
        if (match) return match[1];
        failure = "the remote did not report a default branch";
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }
    if (asked?.host) {
      const viaApi = await githubDefaultBranch(asked.host, asked.owner, asked.name).catch(
        () => null,
      );
      if (viaApi) return viaApi;
    }
    throw new RepoInputError(
      `Could not read the default branch of ${asked?.url ?? url} (${failure}). Pass the branch.`,
    );
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
   * The host policy a new repo starts with. A repo added from a worker is limited to that worker
   * and it is the primary. A repo added by URL runs anywhere, and its primary is set when the
   * first host clones it. A caller's choice wins and is checked like `setHostPolicy` checks it.
   */
  private initialHostPolicy(
    fromHostId: string | undefined,
    allowed: string[] | null | undefined,
    primary: string | undefined,
  ): Pick<RepoState, "allowedHostIds" | "primaryHostId"> {
    const allowedHostIds = allowed === undefined ? (fromHostId ? [fromHostId] : null) : allowed;
    const primaryHostId = primary ?? fromHostId;
    this.checkHostPolicy(allowedHostIds, primaryHostId);
    return {
      ...(allowedHostIds ? { allowedHostIds } : {}),
      ...(primaryHostId && isHostAllowed(allowedHostIds, primaryHostId) ? { primaryHostId } : {}),
    };
  }

  /** Throws `RepoInputError` unless the hosts exist, the list is not empty and the primary is on it. */
  private checkHostPolicy(
    allowed: readonly string[] | null | undefined,
    primary: string | null | undefined,
  ): void {
    const known = new Set(tokenService.listHosts(1000).map((h) => h.id));
    if (allowed) {
      if (allowed.length === 0) {
        throw new RepoInputError("Choose at least one host, or all hosts.");
      }
      const unknown = allowed.find((id) => !known.has(id));
      if (unknown) throw new RepoInputError(`Unknown host "${unknown}"`);
    }
    if (primary) {
      if (!known.has(primary)) throw new RepoInputError(`Unknown host "${primary}"`);
      if (!isHostAllowed(allowed, primary)) {
        throw new RepoInputError(`The primary host "${primary}" must be one of the allowed hosts.`);
      }
    }
  }

  /**
   * Limits a repo to some hosts (`null` for all) and/or names the host that lists its
   * default-branch checkout (`null` to let the hub pick). A field left out is unchanged.
   * Worktrees already on a host that is no longer allowed stay and are flagged in `list`.
   */
  setHostPolicy(
    name: string,
    policy: { allowedHostIds?: string[] | null; primaryHostId?: string | null },
  ): void {
    const current = this.queries.findHostPolicy(name);
    if (!current) throw new RepoInputError(`Unknown repo "${name}"`);
    const allowed =
      policy.allowedHostIds === undefined ? current.allowedHostIds : policy.allowedHostIds;
    let primary = policy.primaryHostId === undefined ? current.primaryHostId : policy.primaryHostId;
    // Narrowing the hosts drops a stored primary that is no longer allowed, unless the caller named a new one.
    if (policy.primaryHostId === undefined && primary && !isHostAllowed(allowed, primary)) {
      primary = null;
    }
    this.checkHostPolicy(allowed, primary);
    const wasOn = this.checkpointsOn(name);
    this.queries.setHostPolicy(name, { allowedHostIds: allowed, primaryHostId: primary });
    this.forgetCheckpointsIfTurnedOff(name, wasOn);
  }

  /** Whether the hub keeps checkpoints for `name` now: the stored setting, else the default for its hosts. */
  private checkpointsOn(name: string): boolean {
    return checkpointsEnabledFor(
      this.queries.findCheckpointsEnabled(name) ?? null,
      this.queries.findHostPolicy(name)?.allowedHostIds ?? null,
    );
  }

  /** A repo that keeps no checkpoints keeps nothing on the hub, so a change that turns them off deletes the stored ones. */
  private forgetCheckpointsIfTurnedOff(name: string, wasOn: boolean): void {
    if (!wasOn || this.checkpointsOn(name)) return;
    for (const id of this.checkpointQueries.worktreeIdsForRepo(name)) forgetCheckpoints(id);
  }

  /** Turns checkpoints on the hub on or off for `name`, or back to the default with `null`. */
  setCheckpointsEnabled(name: string, enabled: boolean | null): void {
    const wasOn = this.checkpointsOn(name);
    if (!this.queries.setCheckpointsEnabled(name, enabled)) {
      throw new RepoInputError(`Unknown repo "${name}"`);
    }
    this.forgetCheckpointsIfTurnedOff(name, wasOn);
  }

  /** Turns "continue on another host automatically" on or off for `name`, or back to the default (off) with `null`. */
  setAutoContinue(name: string, enabled: boolean | null): void {
    if (!this.queries.setAutoContinue(name, enabled)) {
      throw new RepoInputError(`Unknown repo "${name}"`);
    }
  }

  /** Marks or unmarks `name` as a meta repo. */
  setMeta(name: string, meta: boolean): void {
    if (!this.queries.setMeta(name, meta)) throw new RepoInputError(`Unknown repo "${name}"`);
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

/** The default branch from the GitHub API, using a vault git credential for the host when there is one. */
async function githubDefaultBranch(
  host: string,
  owner: string,
  name: string,
): Promise<string | null> {
  if (host !== "github.com") return null;
  const credential = vaultService.findGitCredential({
    host,
    path: `${owner}/${name}`,
    repo: null,
    peek: true,
  });
  if (!credential) return null;
  const base = (process.env.BAND_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/repos/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${credential.password}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "band-hub",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { default_branch?: unknown };
  return typeof body.default_branch === "string" ? body.default_branch : null;
}

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

/** Where a worktree was started from, as `repos.list` reports it. */
export interface WorktreeOriginInfo {
  worktreeId: string;
  chatId?: string;
  terminalId?: string;
  /** True when the origin worktree no longer exists. The ids stay so a view can say "parent removed". */
  removed: boolean;
  /** The origin worktree's repo and branch while it exists. */
  repo?: string;
  branch?: string;
}

/** Each worktree's origin, and the worktrees that were started from each one, over every repo and host. */
function originLinks(repos: RepoState[]): {
  origins: Map<string, WorktreeOriginInfo>;
  children: Map<string, string[]>;
} {
  const known = new Map<string, { repo: string; branch: string }>();
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      known.set(toWorktreeId(repo.name, wt.name, wt.hostId), {
        repo: repo.name,
        branch: wt.branch,
      });
    }
  }
  const origins = new Map<string, WorktreeOriginInfo>();
  const children = new Map<string, string[]>();
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (!wt.origin) continue;
      const id = toWorktreeId(repo.name, wt.name, wt.hostId);
      const parent = known.get(wt.origin.worktreeId);
      origins.set(id, {
        ...wt.origin,
        removed: parent === undefined,
        ...(parent ? { repo: parent.repo, branch: parent.branch } : {}),
      });
      if (parent)
        children.set(wt.origin.worktreeId, [...(children.get(wt.origin.worktreeId) ?? []), id]);
    }
  }
  return { origins, children };
}
