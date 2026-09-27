import type { ConflictKind, FileStatus } from "../types";

const statusColors: Record<FileStatus, string> = {
  A: "text-green-600 dark:text-green-400",
  M: "text-blue-600 dark:text-blue-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-purple-600 dark:text-purple-400",
  C: "text-purple-600 dark:text-purple-400",
  U: "text-yellow-600 dark:text-yellow-400",
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
        className="w-3 shrink-0 text-center text-xs font-bold text-red-600 dark:text-red-400"
      >
        !
      </span>
    );
  }
  if (!status) return null;
  return (
    <span
      title={statusLabels[status]}
      className={`w-3 shrink-0 text-center text-xs font-bold ${statusColors[status]}`}
    >
      {status}
    </span>
  );
}
