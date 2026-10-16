import type { CodeRun } from "../chat/highlight.ts";

/**
 * Splits highlighted runs at newlines, so each line keeps the scopes of its own pieces. A block
 * comment that spans lines colors every line of it.
 */
export function splitRunsIntoLines(runs: readonly CodeRun[]): CodeRun[][] {
  const lines: CodeRun[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    parts.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1].push(run.scope ? { text, scope: run.scope } : { text });
    });
  }
  return lines;
}

/** The text of a file as lines. A trailing newline does not add an empty last line. */
export function textLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** The longest line, in characters, so a view can size its sideways scroll. */
export function longestLine(lines: readonly string[]): number {
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}
