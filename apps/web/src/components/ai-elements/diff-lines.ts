/**
 * Line diff for the chat's tool cards. ACP reports a file edit as the old
 * and new text of the file (`ToolCallContent` of type `diff`); the card
 * shows which lines changed, with a few lines of context.
 *
 * A plain LCS table is fine at chat scale. Past `MAX_CELLS` the diff falls
 * back to "every old line removed, every new line added", so a huge file
 * rewrite can't stall the render.
 */

export type DiffLine =
  | { kind: "same" | "add" | "del"; text: string }
  | { kind: "gap"; skipped: number };

const MAX_CELLS = 400_000;
const CONTEXT = 3;

function rawDiff(
  oldLines: string[],
  newLines: string[],
): Array<{ kind: "same" | "add" | "del"; text: string }> {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_CELLS) {
    return [
      ...oldLines.map((text) => ({ kind: "del" as const, text })),
      ...newLines.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // lcs[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ kind: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: oldLines[i++] });
    } else {
      out.push({ kind: "add", text: newLines[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: oldLines[i++] });
  while (j < m) out.push({ kind: "add", text: newLines[j++] });
  return out;
}

/** Changed lines with `CONTEXT` lines around them; runs of unchanged lines
 *  beyond that collapse into a `gap`. */
export function diffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const raw = rawDiff(oldText ? oldText.split("\n") : [], newText.split("\n"));
  const keep = raw.map(() => false);
  raw.forEach((line, idx) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(raw.length - 1, idx + CONTEXT); k++) {
      keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  raw.forEach((line, idx) => {
    if (keep[idx]) {
      if (skipped > 0) out.push({ kind: "gap", skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "gap", skipped });
  return out;
}
