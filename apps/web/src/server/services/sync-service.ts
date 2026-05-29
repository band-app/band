import { execGit, getRepoInfo, listWorktrees } from "../infra/git/git-client";
import {
  loadState,
  type ProjectState,
  reconcileKindForProject,
  saveState,
  setProjectHasOrigin,
  type WorktreeState,
} from "./state";

/**
 * Bound for concurrent per-project git probes inside `syncWorktrees`.
 *
 * Each project spawns 1–2 short-lived git subprocesses (`worktree list`,
 * `symbolic-ref refs/remotes/origin/HEAD`, occasionally `remote set-head`).
 * Running all 28+ at once on a Mac with many projects spikes fork/exec
 * pressure and can starve other boot-path work (the bundle import on the
 * web server, the LSP scan in dev). Eight at a time saturates the IO
 * pipeline for git-on-local-disk without overwhelming the scheduler;
 * see issue #472 boot-path discussion for measured timings.
 */
const PROJECT_SYNC_BATCH_SIZE = 8;

/**
 * Detect the remote's default branch from the local origin/HEAD ref.
 * Returns null if the ref doesn't exist (e.g. origin/HEAD was never set).
 */
async function detectRemoteDefaultBranch(projectPath: string): Promise<string | null> {
  try {
    const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], projectPath)).trim();
    // ref is like "refs/remotes/origin/main" — extract the branch name
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  } catch {
    // origin/HEAD not set — try to auto-detect it (one-time network call)
    try {
      await execGit(["remote", "set-head", "origin", "--auto"], projectPath);
      const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], projectPath)).trim();
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

export async function syncWorktrees(): Promise<void> {
  const state = loadState();
  let changed = false;

  // ----- Step 1: Self-heal `kind` against the filesystem -----
  //
  // The schema migration for #427 defaulted every pre-existing row to
  // `kind: "git"` regardless of whether the folder actually had a `.git`
  // directory — so a project added before this PR shipped, sitting in a
  // plain folder, would otherwise stay incorrectly tagged. Same
  // reconciliation also catches a user who ran `git init` (or `rm -rf
  // .git`) in the folder outside the dashboard.
  //
  // The actual fix-up logic lives in `reconcileKindForProject`
  // (state.ts) so the inline read-only re-detection inside
  // `projects.list` can call the exact same code path. Here we just
  // propagate any mutations to `changed` so saveState fires at the
  // end of this function — `projects.list` discards the return value
  // since queries shouldn't write to the DB.
  for (const project of state.projects) {
    if (reconcileKindForProject(project)) {
      changed = true;
    }
  }

  // ----- Step 2: Reconcile git worktrees -----
  //
  // Each git project's reconcile (`listWorktrees` + the
  // `detectRemoteDefaultBranch` probe) is independent — they touch
  // different `project` objects in-memory and spawn their own git
  // subprocesses against different paths. The pre-#472 loop ran them
  // sequentially, so on a 28-project host this serialised ~400 ms of
  // git fork/exec wait time for no reason. Fan out with a bounded
  // batch size to overlap I/O without spawning 50+ subprocesses at
  // once (which spiked fork pressure on Macs with many projects).

  const gitProjects = state.projects.filter((p) => p.kind !== "plain");
  for (let i = 0; i < gitProjects.length; i += PROJECT_SYNC_BATCH_SIZE) {
    const batch = gitProjects.slice(i, i + PROJECT_SYNC_BATCH_SIZE);
    const results = await Promise.all(batch.map(reconcileOneProject));
    for (const mutated of results) {
      if (mutated) changed = true;
    }
  }

  if (changed) {
    saveState(state);
  }
}

/**
 * Reconcile a single git-kind project against the on-disk worktrees and
 * the remote's default branch. Returns `true` if anything mutated on
 * the in-memory `project` object — caller is responsible for the
 * persistence decision (one `saveState` after all batches have run).
 *
 * Safe to call concurrently across distinct `project` objects: every
 * mutation here targets `project.*` fields, never the shared `state`
 * container. The two outbound git subprocesses are independent across
 * projects, so concurrency is the whole point.
 */
async function reconcileOneProject(project: ProjectState): Promise<boolean> {
  let mutated = false;

  let diskWorktrees: WorktreeState[];
  try {
    const gitWorktrees = await listWorktrees(project.path);
    // Preserve the `pinned` flag for branches that still exist —
    // syncWorktrees runs on a timer, and replacing the tracked
    // worktrees with git's view would otherwise wipe pin state on
    // every sync that adds/removes a worktree.
    const pinnedByBranch = new Map(project.worktrees.map((wt) => [wt.branch, wt.pinned]));
    diskWorktrees = gitWorktrees
      .filter((wt) => !wt.isBare)
      .map((wt) => ({
        branch: wt.branch,
        path: wt.path,
        head: wt.head,
        pinned: pinnedByBranch.get(wt.branch) ?? false,
      }));
  } catch {
    // If git fails for this project (e.g. path was deleted, NFS mount is
    // gone), it has no usable origin — clear `hasOrigin` so the CI poller
    // stops including its workspaces in the batched GraphQL query. Without
    // this, a "ghost" project keeps its schema-default `hasOrigin: true`
    // and the poller wastes a `getRepoInfo` subprocess on every CI tick
    // forever. See issue #458 review feedback.
    if (project.hasOrigin) {
      setProjectHasOrigin(project.name, false);
      project.hasOrigin = false;
    }
    return false;
  }

  const existingSet = new Set(project.worktrees.map((wt) => `${wt.branch}\0${wt.path}`));
  const diskSet = new Set(diskWorktrees.map((wt) => `${wt.branch}\0${wt.path}`));

  if (
    existingSet.size !== diskSet.size ||
    Array.from(existingSet).some((key) => !diskSet.has(key))
  ) {
    project.worktrees = diskWorktrees;
    mutated = true;
  }

  // Sync default branch with remote's HEAD
  const remoteBranch = await detectRemoteDefaultBranch(project.path);
  if (remoteBranch && remoteBranch !== project.defaultBranch) {
    project.defaultBranch = remoteBranch;
    mutated = true;
  }

  // Sync `hasOrigin` so the CI poller can skip origin-less projects
  // without re-probing on every tick (issue #458). This is the same
  // probe `branch-status-poller` would have run inline — moving it
  // here piggy-backs on the existing sync cadence (30 s / 3 min / 10
  // min) and gives the poller a property read instead of a subprocess.
  //
  // We persist via the focused `setProjectHasOrigin` UPDATE rather than
  // returning a mutation flag and rolling into the caller's full-tree
  // `saveState`. The whole-tree rewrite would race with concurrent
  // `workspaces.create` traffic — a stale in-memory copy from before the
  // create would clobber the just-saved worktree row. The targeted
  // UPDATE leaves the worktrees table alone. The in-memory `project`
  // object is mutated too so the rest of the sync (and any caller that
  // re-reads the state object) sees the fresh value.
  const hasOrigin = (await getRepoInfo(project.path)) !== null;
  if (hasOrigin !== project.hasOrigin) {
    // DB write first, in-memory mirror second. If `setProjectHasOrigin`
    // throws (SQLite locked, disk full), the in-memory value stays in
    // sync with what's actually persisted; the next sync tick will try
    // again rather than the two diverging.
    //
    // Swallow the throw rather than letting it propagate. `reconcileOneProject`
    // runs inside `Promise.all` in `syncWorktrees`; an unhandled rejection
    // here aborts the entire batch and skips the trailing `saveState` for
    // every project's worktree/defaultBranch reconciliation. A failed
    // `hasOrigin` write is recoverable on the next sync tick; losing the
    // rest of the batch isn't.
    try {
      setProjectHasOrigin(project.name, hasOrigin);
      project.hasOrigin = hasOrigin;
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
}

export const syncService = new SyncService();
