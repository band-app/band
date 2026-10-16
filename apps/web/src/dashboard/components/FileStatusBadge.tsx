import type { ConflictKind, FileStatus } from "../types";

const statusColors: Record<FileStatus, string> = {
  A: "text-git-added",
  M: "text-git-modified",
  D: "text-git-deleted",
  R: "text-git-renamed",
  C: "text-git-renamed",
  U: "text-git-untracked",
};

const statusLabels: Record<FileStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Untracked",
};

const conflictLabels: Record<ConflictKind, string> = {
  both_modified: "Conflict: both modified",
  both_added: "Conflict: both added",
  both_deleted: "Conflict: both deleted",
  added_by_us: "Conflict: added by us",
  added_by_them: "Conflict: added by them",
  deleted_by_us: "Conflict: deleted by us",
  deleted_by_them: "Conflict: deleted by them",
};

export function FileStatusBadge({
  status,
  conflict,
}: {
  status: FileStatus | undefined;
  /** Set for an unmerged file: shows a red `!` in place of the letter. */
  conflict?: ConflictKind;
}) {
  if (conflict) {
    return (
      <span
        title={conflictLabels[conflict]}
        data-testid="changes-tree__conflict-badge"
        className="w-3 shrink-0 text-center text-xs font-bold text-git-conflict"
      >
        !
      </span>
    );
  }
  if (!status) return null;
  return (
    <span
      title={statusLabels[status]}
      data-testid="changes-tree__status"
      className={`w-3 shrink-0 text-center text-xs font-bold ${statusColors[status]}`}
    >
      {status}
    </span>
  );
}
