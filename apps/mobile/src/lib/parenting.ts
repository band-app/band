import { entriesOf, originDescendants } from "@band-app/shared/sidebar-tree";
import type { RepoLike, WorktreeRow } from "./worktree-list.ts";

export interface ParentCandidate {
  id: string;
  repo: string;
  name: string;
  groupId: string | null;
}

/** Every worktree except the row itself and the ones started from it, which would make a cycle. */
export function parentCandidates(
  repos: readonly RepoLike[],
  row: Pick<WorktreeRow, "id">,
): ParentCandidate[] {
  const entries = entriesOf([...repos]);
  const excluded = new Set([
    row.id,
    ...originDescendants(entries, row.id).map((e) => e.worktreeId),
  ]);
  return entries
    .filter((e) => !excluded.has(e.worktreeId))
    .map((e) => ({
      id: e.worktreeId,
      repo: e.repo.name,
      name: e.worktree.name,
      groupId: e.worktree.groupId ?? null,
    }));
}

/** The hub calls that make `parent` (null for none) the row's parent and keep it nested there. */
export function setParentRequests(
  row: Pick<WorktreeRow, "repo" | "name" | "hostId" | "id" | "groupId">,
  parent: Pick<ParentCandidate, "id" | "groupId"> | null,
): {
  origin: { repo: string; name: string; origin: string | null; hostId?: string };
  group: { worktreeId: string; groupId: string | null; withChildren: true } | null;
} {
  return {
    origin: {
      repo: row.repo,
      name: row.name,
      origin: parent?.id ?? null,
      ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
    },
    // A child shown under its parent has to be in the parent's group.
    group:
      parent && parent.groupId !== row.groupId
        ? { worktreeId: row.id, groupId: parent.groupId, withChildren: true }
        : null,
  };
}

/** The alert text for a refused Set parent / Remove parent: the hub's own message, else a generic one. */
export function setParentFailure(
  row: Pick<WorktreeRow, "name">,
  error: unknown,
): {
  title: string;
  message: string;
} {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    title: `Could not set the parent of ${row.name}`,
    message: message || "The hub refused the request.",
  };
}

/**
 * Clears a worktree's group — mobile's stand-in for dragging it to the web sidebar's top level.
 * The parent also clears, but only when it is itself grouped: a nested row must stay in its
 * parent's group, so leaving the group has to leave the parent too, or the row would be shown
 * nested under a parent in another group. Unlike the web drop, this never cascades to the row's
 * own children — they keep their group, matching how Remove parent stays a single-row action.
 */
export function removeFromGroupRequests(
  row: Pick<WorktreeRow, "repo" | "name" | "hostId" | "id" | "parentId">,
  parentGroupId: string | null,
): {
  origin: { repo: string; name: string; origin: null; hostId?: string } | null;
  group: { worktreeId: string; groupId: null };
} {
  return {
    origin:
      row.parentId && parentGroupId
        ? {
            repo: row.repo,
            name: row.name,
            origin: null,
            ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
          }
        : null,
    group: { worktreeId: row.id, groupId: null },
  };
}

/** The alert text for a refused Remove from group. */
export function removeFromGroupFailure(
  row: Pick<WorktreeRow, "name">,
  error: unknown,
): {
  title: string;
  message: string;
} {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    title: `Could not remove ${row.name} from its group`,
    message: message || "The hub refused the request.",
  };
}
