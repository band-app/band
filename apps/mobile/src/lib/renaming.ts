import type { WorktreeRow } from "./worktree-list.ts";

/** The longest title the hub accepts. */
export const TITLE_MAX = 100;

/** What the list shows for a row: its custom title, else its name. */
export function rowTitle(row: Pick<WorktreeRow, "name" | "title">): string {
  return row.title || row.name;
}

/** The `worktrees.setTitle` request for what a person typed. Blank clears the title. */
export function renameRequest(
  row: Pick<WorktreeRow, "id">,
  typed: string | undefined,
): { worktreeId: string; title: string | null } {
  const title = (typed ?? "").trim().slice(0, TITLE_MAX);
  return { worktreeId: row.id, title: title === "" ? null : title };
}

/** The alert text for a refused rename. */
export function renameFailure(
  row: Pick<WorktreeRow, "name" | "title">,
  error: unknown,
): { title: string; message: string } {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    title: `Could not rename ${rowTitle(row)}`,
    message: message || "The hub refused the request.",
  };
}
