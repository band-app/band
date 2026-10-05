import { gitRunner } from "@band-app/host-api";
import { getRepoInfo } from "@band-app/host-local/git/git-client";
import { hostRegistry } from "../infra/host/registry";
import { refreshRemoteWorktrees } from "./_utils/remote-worktrees";
import {
  loadState,
  type RepoState,
  reconcileKindForRepo,
  saveState,
  setRepoHasOrigin,
  type WorktreeState,
} from "./state";

/**
 * Bound for concurrent per-repo git probes inside `syncWorktrees`.
 *
 * Each repo spawns 1–2 short-lived git subprocesses (`worktree list`,
 * `symbolic-ref refs/remotes/origin/HEAD`, occasionally `remote set-head`).
 * Running all 28+ at once on a Mac with many repos spikes fork/exec
 * pressure and can starve other boot-path work (the bundle import on the
 * web server, the LSP scan in dev). Eight at a time saturates the IO
 * pipeline for git-on-local-disk without overwhelming the scheduler;
 * see issue #472 boot-path discussion for measured timings.
 */
const REPO_SYNC_BATCH_SIZE = 8;

/**
 * Worktree paths `worktrees.remove` has taken out of state that git may still
 * list, with how many removals hold each: the worktree itself is removed in
 * the background after the mutation returns. A sync that saw one would add
 * the worktree back.
 */
const removingWorktrees = new Map<string, number>();

/**
 * Paths among {@link removingWorktrees} whose removal has saved state. A sync
 * that loaded state before that save drops their rows before its own save, so
 * it can't write them back.
 */
const removedWorktrees = new Set<string>();

/** A worktree removal in progress; see {@link SyncService.beginWorktreeRemoval}. */
export interface WorktreeRemoval {
  /** Call right after saving state without the row. */
  commit(): void;
  /** Call once git no longer lists the worktree, or when the removal fails. */
  end(): void;
}

/**
 * Rows `worktrees.create` saved while a sync was running, by path. That sync
 * may have loaded state before the save and listed worktrees before
 * `git worktree add` finished, so it puts these back before its own save.
 * An entry lasts until every sync running at the save has finished.
 */
const addedWorktrees = new Map<string, { repo: string; row: WorktreeState }>();

/** Syncs in progress; each may hold a state snapshot from before a removal or a create. */
const syncsInFlight = new Set<Promise<void>>();

/**
 * Detect the remote's default branch from the local origin/HEAD ref.
 * Returns null if the ref doesn't exist (e.g. origin/HEAD was never set).
 */
async function detectRemoteDefaultBranch(repo: RepoState): Promise<string | null> {
  const repoPath = repo.path;
  const execGit = gitRunner(hostRegistry.hostForRepo(repo.name));
  try {
    const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath)).trim();
    // ref is like "refs/remotes/origin/main" — extract the branch name
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  } catch {
    // origin/HEAD not set — try to auto-detect it (one-time network call)
    try {
      await execGit(["remote", "set-head", "origin", "--auto"], repoPath);
      const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath)).trim();
      const prefix = "refs/remotes/origin/";
      if (ref.startsWith(prefix)) {
        return ref.slice(prefix.length);
      }
    } catch {
      // No remote or network unavailable — skip
    }
  }
  return null;
}

export function syncWorktrees(): Promise<void> {
  const sync = runSync();
  syncsInFlight.add(sync);
  const done = () => {
    syncsInFlight.delete(sync);
  };
  sync.then(done, done);
  return sync;
}

async function runSync(): Promise<void> {
  const state = loadState();
  let changed = false;

  // ----- Step 1: Self-heal `kind` against the filesystem -----
  //
  // The schema migration for #427 defaulted every pre-existing row to
  // `kind: "git"` regardless of whether the folder actually had a `.git`
  // directory — so a repo added before this PR shipped, sitting in a
  // plain folder, would otherwise stay incorrectly tagged. Same
  // reconciliation also catches a user who ran `git init` (or `rm -rf
  // .git`) in the folder outside the dashboard.
  //
  // The actual fix-up logic lives in `reconcileKindForRepo`
  // (state.ts) so the inline read-only re-detection inside
  // `repos.list` can call the exact same code path. Here we just
  // propagate any mutations to `changed` so saveState fires at the
  // end of this function — `repos.list` discards the return value
  // since queries shouldn't write to the DB.
  for (const repo of state.repos) {
    if (reconcileKindForRepo(repo)) {
      changed = true;
    }
  }

  // ----- Step 2: Reconcile git worktrees -----
  //
  // Each git repo's reconcile (`listWorktrees` + the
  // `detectRemoteDefaultBranch` probe) is independent — they touch
  // different `repo` objects in-memory and spawn their own git
  // subprocesses against different paths. The pre-#472 loop ran them
  // sequentially, so on a 28-repo host this serialised ~400 ms of
  // git fork/exec wait time for no reason. Fan out with a bounded
  // batch size to overlap I/O without spawning 50+ subprocesses at
  // once (which spiked fork pressure on Macs with many repos).

  const gitRepos = state.repos.filter((p) => p.kind !== "plain");
  for (let i = 0; i < gitRepos.length; i += REPO_SYNC_BATCH_SIZE) {
    const batch = gitRepos.slice(i, i + REPO_SYNC_BATCH_SIZE);
    const results = await Promise.all(batch.map(reconcileOneRepo));
    for (const mutated of results) {
      if (mutated) changed = true;
    }
  }

  if (changed) {
    for (const repo of state.repos) {
      repo.worktrees = repo.worktrees.filter((wt) => !removedWorktrees.has(wt.path));
    }
    for (const { repo: name, row } of addedWorktrees.values()) {
      if (removingWorktrees.has(row.path)) continue;
      const repo = state.repos.find((p) => p.name === name);
      if (repo && !repo.worktrees.some((wt) => wt.path === row.path)) {
        repo.worktrees.push(row);
      }
    }
    saveState(state);
  }
}

/**
 * Reconcile a single git-kind repo against the on-disk worktrees and
 * the remote's default branch. Returns `true` if anything mutated on
 * the in-memory `repo` object — caller is responsible for the
 * persistence decision (one `saveState` after all batches have run).
 *
 * Safe to call concurrently across distinct `repo` objects: every
 * mutation here targets `repo.*` fields, never the shared `state`
 * container. The two outbound git subprocesses are independent across
 * repos, so concurrency is the whole point.
 */
async function reconcileOneRepo(repo: RepoState): Promise<boolean> {
  let mutated = false;

  let diskWorktrees: WorktreeState[];
  let remoteWorktrees: WorktreeState[] = [];
  try {
    const gitWorktrees = await hostRegistry.hostForRepo(repo.name).worktree.list(repo.path);
    // Preserve Band-owned metadata (the immutable `name` identity and the
    // `pinned` flag) across a sync. We key by PATH, not branch: the worktree
    // path is stable across a git branch switch, but the branch is exactly
    // what changes — matching by branch would fail to find the existing row
    // after a switch and would (a) lose the pin state and (b) reset `name`,
    // which must never move. `name` falls back to the current branch for
    // worktrees created outside Band (first time we see them), matching the
    // create-time invariant that `name === branch` initially.
    // Worktrees on remote hosts belong to those hosts. Git on this machine
    // can't list them, so a sync must not drop them.
    const isRemote = (wt: WorktreeState) => wt.hostId !== undefined && wt.hostId !== "local";
    remoteWorktrees = repo.worktrees.filter(isRemote);
    // A path tracked as a remote worktree is not a local one, even when this
    // machine's git can see it (a worker that shares the hub's disk).
    const remotePaths = new Set(remoteWorktrees.map((wt) => wt.path));
    const existingByPath = new Map(
      repo.worktrees.filter((wt) => !isRemote(wt)).map((wt) => [wt.path, wt]),
    );
    // A worktree being removed is neither added nor dropped: the removal
    // saves after every sync that could have loaded its row, and git may list
    // it until the background `git worktree remove` is done.
    diskWorktrees = gitWorktrees
      .filter(
        (wt) =>
          !wt.isBare &&
          !remotePaths.has(wt.path) &&
          (!removingWorktrees.has(wt.path) ||
            (existingByPath.has(wt.path) && !removedWorktrees.has(wt.path))),
      )
      .map((wt) => {
        const existing = existingByPath.get(wt.path);
        return {
          name: existing?.name ?? wt.branch,
          branch: wt.branch,
          path: wt.path,
          head: wt.head,
          pinned: existing?.pinned ?? false,
        };
      });
  } catch {
    // If git fails for this repo (e.g. path was deleted, NFS mount is
    // gone), it has no usable origin — clear `hasOrigin` so the CI poller
    // stops including its worktrees in the batched GraphQL query. Without
    // this, a "ghost" repo keeps its schema-default `hasOrigin: true`
    // and the poller wastes a `getRepoInfo` subprocess on every CI tick
    // forever. See issue #458 review feedback.
    if (repo.hasOrigin) {
      setRepoHasOrigin(repo.name, false);
      repo.hasOrigin = false;
    }
    return false;
  }

  const localWorktrees = repo.worktrees.filter((wt) => !remoteWorktrees.includes(wt));
  const existingSet = new Set(localWorktrees.map((wt) => `${wt.branch}\0${wt.path}`));
  const diskSet = new Set(diskWorktrees.map((wt) => `${wt.branch}\0${wt.path}`));

  if (
    existingSet.size !== diskSet.size ||
    Array.from(existingSet).some((key) => !diskSet.has(key))
  ) {
    repo.worktrees = [...diskWorktrees, ...remoteWorktrees];
    mutated = true;
  }

  const remote = await refreshRemoteWorktrees(repo.name, repo.path, repo.worktrees);
  if (remote.changed) {
    repo.worktrees = remote.worktrees;
    mutated = true;
  }

  // Sync default branch with remote's HEAD
  const remoteBranch = await detectRemoteDefaultBranch(repo);
  if (remoteBranch && remoteBranch !== repo.defaultBranch) {
    repo.defaultBranch = remoteBranch;
    mutated = true;
  }

  // Sync `hasOrigin` so the CI poller can skip origin-less repos
  // without re-probing on every tick (issue #458). This is the same
  // probe `branch-status-poller` would have run inline — moving it
  // here piggy-backs on the existing sync cadence (30 s / 3 min / 10
  // min) and gives the poller a property read instead of a subprocess.
  //
  // We persist via the focused `setRepoHasOrigin` UPDATE rather than
  // returning a mutation flag and rolling into the caller's full-tree
  // `saveState`. The whole-tree rewrite would race with concurrent
  // `worktrees.create` traffic — a stale in-memory copy from before the
  // create would clobber the just-saved worktree row. The targeted
  // UPDATE leaves the worktrees table alone. The in-memory `repo`
  // object is mutated too so the rest of the sync (and any caller that
  // re-reads the state object) sees the fresh value.
  const hasOrigin =
    (await getRepoInfo(repo.path, gitRunner(hostRegistry.hostForRepo(repo.name)))) !== null;
  if (hasOrigin !== repo.hasOrigin) {
    // DB write first, in-memory mirror second. If `setRepoHasOrigin`
    // throws (SQLite locked, disk full), the in-memory value stays in
    // sync with what's actually persisted; the next sync tick will try
    // again rather than the two diverging.
    //
    // Swallow the throw rather than letting it propagate. `reconcileOneRepo`
    // runs inside `Promise.all` in `syncWorktrees`; an unhandled rejection
    // here aborts the entire batch and skips the trailing `saveState` for
    // every repo's worktree/defaultBranch reconciliation. A failed
    // `hasOrigin` write is recoverable on the next sync tick; losing the
    // rest of the batch isn't.
    try {
      setRepoHasOrigin(repo.name, hasOrigin);
      repo.hasOrigin = hasOrigin;
    } catch {
      // Next sync tick retries — see comment above.
    }
  }

  return mutated;
}

/**
 * Class wrapper around `syncWorktrees` (issue #535 follow-up). The class
 * delegates to the existing function so the underlying `loadState` /
 * `saveState` orchestration stays in one place. New code should depend
 * on `syncService`; existing callers keep using the function export.
 */
export class SyncService {
  async syncWorktrees(): Promise<void> {
    return syncWorktrees();
  }

  /**
   * Call right after saving state with a new worktree row, so a sync already
   * running can't save its older snapshot over it.
   */
  commitWorktreeAdd(repo: string, row: WorktreeState): void {
    if (syncsInFlight.size === 0) return;
    const entry = { repo, row };
    addedWorktrees.set(row.path, entry);
    void Promise.allSettled(syncsInFlight).then(() => {
      if (addedWorktrees.get(row.path) === entry) addedWorktrees.delete(row.path);
    });
  }

  /**
   * Stop syncs from adding `path` until `end`, once git no longer lists it.
   * Resolves after every sync already running has finished, so none of them
   * drops the row before the removal loads state. Syncs that start later and
   * load state before `commit` drop the row before they save.
   */
  async beginWorktreeRemoval(path: string): Promise<WorktreeRemoval> {
    removingWorktrees.set(path, (removingWorktrees.get(path) ?? 0) + 1);
    await Promise.allSettled(syncsInFlight);
    let ended = false;
    return {
      commit() {
        if (!ended) removedWorktrees.add(path);
      },
      end() {
        if (ended) return;
        ended = true;
        const holders = (removingWorktrees.get(path) ?? 1) - 1;
        if (holders > 0) {
          removingWorktrees.set(path, holders);
        } else {
          removingWorktrees.delete(path);
          removedWorktrees.delete(path);
        }
      },
    };
  }
}

export const syncService = new SyncService();
