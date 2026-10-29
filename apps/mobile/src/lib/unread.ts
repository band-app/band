/**
 * The unread mark on a worktree row. A person sets it, from here or from any other device, and it
 * stays until the worktree is opened or marked read. A finished or failed agent turn is the
 * automatic mark and shows as its own state, so a row has one dot.
 */

import { toWorktreeId } from "@band-app/shared/worktree-id";
import type { ShownState } from "./status-state.ts";

/** True when "Mark as read" is the action to offer: a manual mark or a finished or failed turn. */
export function hasUnreadMark(row: { unread: boolean; shown: ShownState }): boolean {
  return row.unread || row.shown === "done" || row.shown === "failed";
}

/** The label of the row action. */
export function unreadActionLabel(row: { unread: boolean; shown: ShownState }): string {
  return hasUnreadMark(row) ? "Mark as read" : "Mark as unread";
}

/** The `worktrees.setUnread` input for a row, with the host left out for the hub's own machine. */
export function unreadRequest(
  row: { id: string; hostId: string },
  unread: boolean,
): { worktreeId: string; unread: boolean; hostId?: string } {
  return {
    worktreeId: row.id,
    unread,
    ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
  };
}

interface UnreadRepo {
  name: string;
  worktrees: { name: string; hostId?: string; unread?: boolean }[];
}

/** `repos.list` with one worktree's mark changed, for the optimistic update. */
export function withUnread<R extends UnreadRepo>(
  repos: R[],
  worktreeId: string,
  unread: boolean,
): R[] {
  return repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((w) =>
      toWorktreeId(repo.name, w.name, w.hostId) === worktreeId ? { ...w, unread } : w,
    ),
  }));
}
