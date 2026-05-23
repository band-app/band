import { describe, expect, it } from "vitest";

import {
  countDiffLines,
  diffContentHeight,
  ROW_CM_LINE_HEIGHT,
  ROW_DIFF_DIVIDER,
  ROW_HUNK_SEPARATOR_HEIGHT,
  ROW_SHOW_FULL_BAR_HEIGHT,
} from "../src/dashboard/lib/diff-row-height.ts";

describe("countDiffLines", () => {
  it("returns all zeros for an empty diff", () => {
    expect(countDiffLines("")).toEqual({
      context: 0,
      insertions: 0,
      deletions: 0,
      hunks: 0,
    });
  });

  it("counts the four bucket categories inside a single hunk", () => {
    const diff = [
      "@@ -1,3 +1,4 @@",
      " context line A",
      "-old line",
      "+new line",
      "+another new",
      " context line B",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({
      context: 2,
      insertions: 2,
      deletions: 1,
      hunks: 1,
    });
  });

  it("counts every hunk header, with content split across them", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+c",
      "@@ -10,2 +10,2 @@",
      " d",
      "-e",
      "+f",
      "@@ -20,1 +20,2 @@",
      " g",
      "+h",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({
      context: 3,
      insertions: 3,
      deletions: 2,
      hunks: 3,
    });
  });

  it("ignores `--- a/foo` and `+++ b/foo` file headers that precede the first @@", () => {
    // These leading-character collisions used to inflate the placeholder
    // height by ~36 px per file (one phantom deletion + one phantom
    // insertion); the inHunk guard suppresses them.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 0123abc..456def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,2 @@",
      " unchanged",
      "-old",
      "+new",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({
      context: 1,
      insertions: 1,
      deletions: 1,
      hunks: 1,
    });
  });

  it("ignores trailing `\\ No newline at end of file` markers", () => {
    // The backslash-space marker starts with `\` (charCode 92), which
    // none of the bucket cases match — so it's silently dropped.
    const diff = ["@@ -1,1 +1,1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n");
    expect(countDiffLines(diff)).toEqual({
      context: 0,
      insertions: 1,
      deletions: 1,
      hunks: 1,
    });
  });

  it("handles a diff with no trailing newline", () => {
    // The final line is buffered against the implicit `end = len` branch
    // in the scanner. Regression guard: an off-by-one would drop the
    // last line.
    const diff = ["@@ -1,1 +1,2 @@", " ctx", "+added"].join("\n");
    expect(countDiffLines(diff)).toEqual({
      context: 1,
      insertions: 1,
      deletions: 0,
      hunks: 1,
    });
  });

  it("treats a lone `@` at end-of-string as not-a-hunk-header", () => {
    // `charCodeAt(i + 1)` on the last character returns NaN; `NaN === 64`
    // is false, so the scanner does NOT increment `hunks` for a stray `@`.
    // Regression guard: a future refactor of the lookahead must preserve
    // this behavior.
    const diff = "@";
    expect(countDiffLines(diff)).toEqual({
      context: 0,
      insertions: 0,
      deletions: 0,
      hunks: 0,
    });
  });

  it("counts every @@ as a hunk header (multi-file or repeated headers)", () => {
    // Two-hunk smoke test that re-verifies the counter advances correctly
    // when the scanner sees the SECOND `@@` after some intervening lines
    // — i.e. that `hunks` keeps incrementing rather than getting stuck.
    const diff = ["@@ -1,1 +1,1 @@", " context", "@@ -10,1 +10,1 @@", " context2"].join("\n");
    const counts = countDiffLines(diff);
    expect(counts.hunks).toBe(2);
    expect(counts.context).toBe(2);
  });
});

describe("diffContentHeight", () => {
  const zeroCounts = { context: 0, insertions: 0, deletions: 0, hunks: 0 };

  it("returns just the divider when there's no content and no chrome", () => {
    expect(diffContentHeight(zeroCounts, "unified", false)).toBe(ROW_DIFF_DIVIDER);
  });

  it("adds the 'Show full file' bar when canLoadMore is true", () => {
    expect(diffContentHeight(zeroCounts, "unified", true)).toBe(
      ROW_DIFF_DIVIDER + ROW_SHOW_FULL_BAR_HEIGHT,
    );
  });

  it("unified mode stacks context + insertions + deletions vertically", () => {
    const counts = { context: 5, insertions: 3, deletions: 2, hunks: 1 };
    // 5 + 3 + 2 = 10 lines × 18 px + 1 px divider
    const expected = ROW_DIFF_DIVIDER + 10 * ROW_CM_LINE_HEIGHT;
    expect(diffContentHeight(counts, "unified", false)).toBe(expected);
  });

  it("split mode uses max(oldSide, newSide), not the sum", () => {
    // oldSide = context + deletions = 5 + 2 = 7
    // newSide = context + insertions = 5 + 3 = 8
    // Split renders both editors at the same (max) height, so we expect 8.
    const counts = { context: 5, insertions: 3, deletions: 2, hunks: 1 };
    const expected = ROW_DIFF_DIVIDER + 8 * ROW_CM_LINE_HEIGHT;
    expect(diffContentHeight(counts, "split", false)).toBe(expected);
  });

  it("split mode picks the old side when there are more deletions than insertions", () => {
    const counts = { context: 2, insertions: 1, deletions: 5, hunks: 1 };
    // oldSide = 2 + 5 = 7 > newSide = 2 + 1 = 3
    const expected = ROW_DIFF_DIVIDER + 7 * ROW_CM_LINE_HEIGHT;
    expect(diffContentHeight(counts, "split", false)).toBe(expected);
  });

  it("adds 32 px per hunk separator between hunks (count − 1)", () => {
    const counts = { context: 0, insertions: 0, deletions: 0, hunks: 3 };
    // 3 hunks → 2 separators between them
    const expected = ROW_DIFF_DIVIDER + 2 * ROW_HUNK_SEPARATOR_HEIGHT;
    expect(diffContentHeight(counts, "unified", false)).toBe(expected);
  });

  it("does not add a separator for a single hunk", () => {
    const counts = { context: 0, insertions: 0, deletions: 0, hunks: 1 };
    expect(diffContentHeight(counts, "unified", false)).toBe(ROW_DIFF_DIVIDER);
  });

  it("combines all components correctly: split + canLoadMore + multiple hunks", () => {
    const counts = { context: 4, insertions: 2, deletions: 6, hunks: 2 };
    // split: max(4 + 6, 4 + 2) = 10 lines
    // hunkSeparators: (2 − 1) × 32 = 32
    // showFullBar: 30
    // total: 1 + 30 + 10 × 18 + 32 = 243
    const expected =
      ROW_DIFF_DIVIDER +
      ROW_SHOW_FULL_BAR_HEIGHT +
      10 * ROW_CM_LINE_HEIGHT +
      ROW_HUNK_SEPARATOR_HEIGHT;
    expect(diffContentHeight(counts, "split", true)).toBe(expected);
    expect(expected).toBe(243);
  });
});

describe("countDiffLines + diffContentHeight round-trip", () => {
  it("matches the height a real diff would produce", () => {
    // Realistic snippet: a small JS change with a 3-line context window.
    const diff = [
      "diff --git a/src/foo.js b/src/foo.js",
      "--- a/src/foo.js",
      "+++ b/src/foo.js",
      "@@ -1,5 +1,6 @@",
      " import { thing } from './thing';",
      " ",
      " export function foo() {",
      "-  return thing();",
      "+  const x = thing();",
      "+  return x;",
      " }",
    ].join("\n");
    const counts = countDiffLines(diff);
    expect(counts).toEqual({
      context: 4,
      insertions: 2,
      deletions: 1,
      hunks: 1,
    });
    // unified: 4 + 2 + 1 = 7 lines × 18 = 126 + 1 (divider) = 127
    expect(diffContentHeight(counts, "unified", false)).toBe(127);
    // split: max(4+1, 4+2) = 6 lines × 18 = 108 + 1 = 109
    expect(diffContentHeight(counts, "split", false)).toBe(109);
  });
});
