/** The fields of a list row that decide whether and how a worktree may be deleted. */
export interface DeletableRow {
  repo: string;
  name: string;
  hostId: string;
  /** The repo's default-branch worktree. */
  main: boolean;
  /** The row is the single folder of a plain (non-git) repo. */
  plain: boolean;
  dirty: boolean;
  ahead: number;
  pr: { number: number } | null;
  prTone: string | null;
}

/** The web never offers delete for the default-branch worktree or a plain repo's folder. */
export function canDelete(row: Pick<DeletableRow, "main" | "plain">): boolean {
  return !row.main && !row.plain;
}

/** What deleting would lose, in the words of the web's delete dialog. Empty for a clean row. */
export function deleteWarnings(row: DeletableRow): string[] {
  const lines: string[] = [];
  if (row.pr && row.prTone !== "merged" && row.prTone !== "closed") {
    lines.push(`PR #${row.pr.number} is open. This branch has not been merged.`);
  }
  if (row.ahead > 0) {
    lines.push(
      `${row.ahead} ${row.ahead === 1 ? "commit" : "commits"} not pushed. They will be lost.`,
    );
  }
  if (row.dirty) lines.push("Uncommitted changes. They will be lost.");
  return lines;
}

/** The request `worktrees.remove` takes, with the host left out for the hub's own machine. */
export function removeRequest(row: Pick<DeletableRow, "repo" | "name" | "hostId">): {
  repo: string;
  name: string;
  hostId?: string;
} {
  return {
    repo: row.repo,
    name: row.name,
    ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
  };
}

/** The alert's title, body and confirm label for a row. */
export function deletePrompt(row: DeletableRow): {
  title: string;
  message: string;
  confirm: string;
} {
  const warnings = deleteWarnings(row);
  const head = `This removes the worktree from ${row.repo}.`;
  return {
    title: `Delete ${row.name}?`,
    message: warnings.length > 0 ? `${head}\n\n${warnings.join("\n")}` : head,
    confirm: warnings.length > 0 ? "Delete anyway" : "Delete",
  };
}

/** The alert text for a refused delete: the hub's own message, else a generic one. */
export function deleteFailure(
  row: Pick<DeletableRow, "name">,
  error: unknown,
): {
  title: string;
  message: string;
} {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    title: `Could not delete ${row.name}`,
    message: message || "The hub refused the request.",
  };
}
