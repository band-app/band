/**
 * Git steps shared by the ephemeral sleep and by checkpoints. Both run on a worktree's host
 * through `Host.exec`, and neither changes the worktree's branch, index or files.
 */

import { posix } from "node:path";

import type { Host } from "@band-app/host-api";

/** Directory beside the worktrees, in the worker's first root, where the hub stages files. */
export const WIP_DIR = ".band-wip";

export const SNAPSHOT_BOT = {
  GIT_AUTHOR_NAME: "Band",
  GIT_AUTHOR_EMAIL: "band@localhost",
  GIT_COMMITTER_NAME: "Band",
  GIT_COMMITTER_EMAIL: "band@localhost",
};

export type GitRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

/** A runner for `git` in `cwd` on `host` that returns trimmed stdout. */
export function gitIn(host: Host, cwd: string): GitRunner {
  return async (args, env) => (await host.exec("git", args, { cwd, env })).stdout.trim();
}

export interface Snapshot {
  baseSha: string;
  /** The checked-out branch, or "" for a detached HEAD. */
  branch: string;
  /** The commit holding the working tree. Equals `baseSha` when the tree is clean. */
  snapshotSha: string;
  /** The tree of that commit. Two snapshots with the same base and tree hold the same files. */
  treeSha: string;
}

/**
 * Builds a snapshot commit of the working tree on top of HEAD in a temporary index, so the
 * branch, the real index and the files stay as they are. Ignored files are not part of it.
 * `label` goes into the commit message. With `seedIndex`, the temporary index starts as a copy
 * of the worktree's index, so git can trust its stat cache and hash only the files that changed.
 */
export async function buildSnapshot(
  host: Host,
  cwd: string,
  wipDir: string,
  worktreeId: string,
  label: string,
  seedIndex = false,
): Promise<Snapshot> {
  const git = gitIn(host, cwd);
  await host.fs.mkdir(wipDir, { recursive: true });
  const baseSha = await git(["rev-parse", "HEAD"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const indexFile = posix.join(wipDir, `${worktreeId}.index`);
  const env = { ...SNAPSHOT_BOT, GIT_INDEX_FILE: indexFile };
  await host.fs.rm(indexFile, { force: true });
  try {
    let treeSha: string | undefined;
    if (seedIndex) {
      try {
        const real = await git(["rev-parse", "--git-path", "index"]);
        await host.fs.copy(real.startsWith("/") ? real : posix.join(cwd, real), indexFile);
        await git(["add", "-A"], env);
        treeSha = await git(["write-tree"], env);
      } catch {
        // An unmerged index or a missing one: build from the head instead.
        await host.fs.rm(indexFile, { force: true }).catch(() => undefined);
        treeSha = undefined;
      }
    }
    if (treeSha === undefined) {
      await git(["read-tree", "HEAD"], env);
      await git(["add", "-A"], env);
      treeSha = await git(["write-tree"], env);
    }
    const snapshotSha =
      treeSha === (await git(["rev-parse", "HEAD^{tree}"]))
        ? baseSha
        : await git(["commit-tree", treeSha, "-p", baseSha, "-m", label], env);
    return { baseSha, branch: branch === "HEAD" ? "" : branch, snapshotSha, treeSha };
  } finally {
    await host.fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Puts a snapshot into a new worktree at `worktreePath`: the branch (or a detached HEAD) at
 * `baseSha`, the files of `snapshotSha` in the working tree, and the index back at the branch
 * head, so the edits show as uncommitted changes again. `repoPath` must hold both commits.
 */
export async function checkoutSnapshot(
  host: Host,
  repoPath: string,
  worktreePath: string,
  snapshot: { branch: string; baseSha: string; snapshotSha: string },
  options: {
    /**
     * Called with the branch's tip when this host's branch has commits the snapshot lacks, so the
     * caller can keep them under a ref. Without it that case throws. The branch is reset either way.
     */
    onDivergentTip?: (tip: string) => Promise<void>;
  } = {},
): Promise<void> {
  const git = gitIn(host, repoPath);
  await host.fs.mkdir(posix.dirname(worktreePath), { recursive: true });
  await git(["worktree", "prune"]);
  if (snapshot.branch) {
    // `-B` resets an existing branch, which would orphan commits this host has and the snapshot lacks.
    const tip = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${snapshot.branch}`,
    ]).catch(() => "");
    if (tip && tip !== snapshot.baseSha) {
      const ancestor = await git(["merge-base", "--is-ancestor", tip, snapshot.baseSha]).then(
        () => true,
        () => false,
      );
      if (!ancestor && options.onDivergentTip) await options.onDivergentTip(tip);
      else if (!ancestor) {
        throw new Error(
          `Branch ${snapshot.branch} on this host has commits that the checkpoint does not contain.`,
        );
      }
    }
  }
  await git(
    snapshot.branch
      ? ["worktree", "add", "-B", snapshot.branch, worktreePath, snapshot.baseSha]
      : ["worktree", "add", "--detach", worktreePath, snapshot.baseSha],
  );
  if (snapshot.snapshotSha !== snapshot.baseSha) {
    const inTree = gitIn(host, worktreePath);
    await inTree(["read-tree", "-u", "--reset", snapshot.snapshotSha]);
    await inTree(["reset", "-q"]);
  }
}

/**
 * Makes the checkout at `path` (a repo's own folder, such as the default branch) hold a snapshot:
 * the branch (or a detached HEAD) at `baseSha`, every local change and untracked file dropped,
 * and the snapshot's files back as uncommitted changes. Ignored files stay. The caller backs up
 * what the folder holds first, because this discards it.
 */
export async function resetCheckoutToSnapshot(
  host: Host,
  path: string,
  snapshot: { branch: string; baseSha: string; snapshotSha: string },
): Promise<void> {
  const git = gitIn(host, path);
  await git(
    snapshot.branch
      ? ["checkout", "-q", "-f", "-B", snapshot.branch, snapshot.baseSha]
      : ["checkout", "-q", "-f", "--detach", snapshot.baseSha],
  );
  await git(["reset", "-q", "--hard", snapshot.baseSha]);
  await git(["clean", "-q", "-fd"]);
  if (snapshot.snapshotSha !== snapshot.baseSha) {
    await git(["read-tree", "-u", "--reset", snapshot.snapshotSha]);
    await git(["reset", "-q"]);
  }
}
