/** The Changes list's sections and rows, as the web's Changes panel groups them. */

export type ChangeSection = "conflicts" | "unstaged" | "staged" | "untracked" | "branch";

export interface ChangeEntry {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "U";
  additions?: number;
  deletions?: number;
  conflict?: string;
}

export interface ChangesLike {
  compareBranch: string;
  mergeBase: string | null;
  branchStatus: string;
  conflicts: ChangeEntry[];
  unstaged: ChangeEntry[];
  staged: ChangeEntry[];
  untracked: ChangeEntry[];
  branch: ChangeEntry[];
}

/** The web's order and titles. */
export const SECTION_TITLES: Record<ChangeSection, string> = {
  conflicts: "Conflicts",
  unstaged: "Changes",
  staged: "Staged Changes",
  untracked: "Untracked Files",
  branch: "Committed on Branch",
};

const ORDER: ChangeSection[] = ["conflicts", "unstaged", "staged", "untracked", "branch"];

export type ChangeListItem =
  | { type: "header"; section: ChangeSection; title: string; count: number }
  | { type: "file"; section: ChangeSection; entry: ChangeEntry };

/** Header and file rows for the sections that hold files, in the web's order. */
export function changeListItems(changes: ChangesLike): ChangeListItem[] {
  const items: ChangeListItem[] = [];
  for (const section of ORDER) {
    const entries = changes[section];
    if (entries.length === 0) continue;
    items.push({ type: "header", section, title: SECTION_TITLES[section], count: entries.length });
    for (const entry of entries) items.push({ type: "file", section, entry });
  }
  return items;
}

export function countChanges(changes: ChangesLike): number {
  return ORDER.reduce((sum, s) => sum + changes[s].length, 0);
}

export const STATUS_NAMES: Record<ChangeEntry["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Untracked",
};

/** Why the branch section is empty when the comparison is not ready. */
export function branchUnavailableMessage(
  changes: Pick<ChangesLike, "compareBranch" | "branchStatus">,
  headBranch: string,
): string | null {
  switch (changes.branchStatus) {
    case "ready":
      return null;
    case "invalid-base":
      return `Can't compare with ${changes.compareBranch}: the branch doesn't exist.`;
    case "no-merge-base":
      return `${headBranch} shares no history with ${changes.compareBranch}.`;
    default:
      return "There are no commits yet.";
  }
}
