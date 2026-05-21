import { execGit, listWorktrees } from "./git";
import {
  loadState,
  type ProjectState,
  reconcileKindForProject,
  saveState,
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
    // If git fails for this project (e.g. path doesn't exist), skip it
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

  return mutated;
}
