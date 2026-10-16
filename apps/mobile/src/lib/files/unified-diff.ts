/** A unified diff as lines with their old and new numbers, for a native diff view. */

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "add" | "del"; text: string; oldLine?: number; newLine?: number }
  /** `\ No newline at end of file`. */
  | { kind: "note"; text: string };

export interface ParsedDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Git said the two sides are binary files. */
  binary: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Reads the output of `git diff` for one file. Lines before the first hunk (`diff --git`, mode,
 * `index`, `---`, `+++`, rename lines) are dropped: the screen's header names the file.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let binary = false;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch"))
        binary = true;
      // A new file's first hunk follows `diff --git`; a later file in the same text restarts it.
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2) });
    else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newLine: newLine++ });
      added++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++ });
      removed++;
    } else {
      rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { rows, added, removed, binary };
}
