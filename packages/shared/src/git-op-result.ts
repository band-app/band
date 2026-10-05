/**
 * Result of a worktree git pull, push or commit, shared by the server and
 * the dashboard.
 *
 * Git refusing an operation for an ordinary reason (local changes in the way
 * of a pull, a push the remote rejects as non-fast-forward, nothing to
 * commit) is a normal outcome, so the server returns it as `ok: false` with a
 * plain-words `message` instead of throwing. The dashboard shows that message
 * as an informational notice. Anything else still throws and shows as an
 * error.
 */

export type GitRefusalReason =
  /** Pull: uncommitted changes would be overwritten or block the rebase. */
  | "local-changes"
  /** Pull: the branch has no upstream to pull from. */
  | "no-upstream"
  /** Push: the remote branch has commits the local branch doesn't. */
  | "behind-remote"
  /** Commit: the working tree has no changes. */
  | "nothing-to-commit";

export type GitOpResult = { ok: true } | { ok: false; reason: GitRefusalReason; message: string };
