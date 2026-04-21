import type { FileStatus } from "../types";

const statusColors: Record<FileStatus, string> = {
  A: "text-green-600 dark:text-green-400",
  M: "text-blue-600 dark:text-blue-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-purple-600 dark:text-purple-400",
  U: "text-yellow-600 dark:text-yellow-400",
};

const statusLabels: Record<FileStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
};

export function FileStatusBadge({ status }: { status: FileStatus | undefined }) {
  if (!status) return null;
  return (
    <span
      title={statusLabels[status]}
      className={`shrink-0 text-xs font-bold ${statusColors[status]}`}
    >
      {status}
    </span>
  );
}
