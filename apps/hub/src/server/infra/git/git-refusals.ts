import type { GitOpResult } from "@band-app/shared/git-op-result";
import { execGit } from "./git-client";

/** How many file names a refusal message lists before "and N more". */
const MAX_LISTED_FILES = 3;

type Refusal = Extract<GitOpResult, { ok: false }>;

/**
 * Map a failed `git pull --rebase` to a refusal when git declined because of
 * the working tree or a missing upstream, or `null` for a genuine failure
 * (network, auth, a conflict mid-rebase) the caller should rethrow.
 */
export async function pullRefusal(err: unknown, cwd: string): Promise<Refusal | null> {
  const stderr = errorText(err);
  if (/There is no tracking information for the current branch/i.test(stderr)) {
    return {
      ok: false,
      reason: "no-upstream",
      message: "Pull skipped: this branch has no upstream branch yet. Push it first.",
    };
  }
  // Rebase refuses up front on any tracked change ("cannot pull with rebase:
  // You have unstaged changes" / "Your index contains uncommitted changes");
  // merge and the rebase checkout refuse when a change would be overwritten,
  // and list the files, one per tab-indented line.
  if (!/cannot pull with rebase|would be overwritten by/i.test(stderr)) return null;
  const listed = stderr
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim())
    .filter(Boolean);
  const files = listed.length > 0 ? listed : await changedTrackedFiles(cwd);
  const which = files.length > 0 ? ` (${formatFileList(files)})` : "";
  // A plain `git stash` leaves untracked files in place, so they get their own advice.
  const advice = /untracked working tree files would be overwritten/i.test(stderr)
    ? "move or delete these untracked files first"
    : "commit or stash your local changes first";
  return { ok: false, reason: "local-changes", message: `Pull skipped: ${advice}${which}.` };
}

/**
 * Map a failed `git push` to a refusal when the remote rejected it as
 * non-fast-forward, or `null` for a genuine failure the caller should
 * rethrow.
 */
export function pushRefusal(err: unknown): Refusal | null {
  const stderr = errorText(err);
  if (!/\[rejected\]/.test(stderr) || !/non-fast-forward|fetch first/i.test(stderr)) {
    return null;
  }
  return {
    ok: false,
    reason: "behind-remote",
    message: "Push rejected: the remote branch has commits you don't have. Pull first.",
  };
}

export const NOTHING_TO_COMMIT: Refusal = {
  ok: false,
  reason: "nothing-to-commit",
  message: "Nothing to commit: the working tree has no changes.",
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tracked files with staged or unstaged changes, from `git status`. */
async function changedTrackedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await execGit(["status", "--porcelain", "--untracked-files=no"], cwd);
    return out
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

function formatFileList(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  const rest = files.length - MAX_LISTED_FILES;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
