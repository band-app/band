/**
 * Diff-row height estimation for the Changes view (DiffView).
 *
 * When a file row is expanded but its CodeMirror editor isn't mounted yet
 * (the row is offscreen, or near-but-not-quite-visible), the LazyFileRow
 * renders an empty placeholder div of the SAME height the editor would
 * occupy. That keeps the row's overall size stable across mount/unmount
 * cycles driven by the IntersectionObserver, so the user's scroll
 * position doesn't drift as rows pop their CodeMirror instances in and
 * out.
 *
 * Each rendered diff is a stack of:
 *   border-t            — 1 px divider between the header and the diff body
 *   "Show full file"    — optional 30 px expand-context link
 *   N × CodeMirror line — one line per context/insertion/deletion in
 *                          unified mode, max(old, new) in split mode
 *   M × hunk separator  — 32 px widget BETWEEN hunks (count − 1 of them)
 *
 * CodeMirror is configured with a 13 px monospace font and the default
 * 1.4 line-height (see `baseViewerExtensions` in codemirror-setup.ts),
 * which renders at ~18 px per line in practice.
 */

export const ROW_DIFF_DIVIDER = 1;
export const ROW_SHOW_FULL_BAR_HEIGHT = 30;
export const ROW_CM_LINE_HEIGHT = 18;
export const ROW_HUNK_SEPARATOR_HEIGHT = 32;

export interface DiffLineCounts {
  context: number;
  insertions: number;
  deletions: number;
  hunks: number;
}

export type DiffViewMode = "unified" | "split";

/**
 * Walk the raw unified-diff string once and bucket lines by their leading
 * character. Lines BEFORE the first `@@` hunk header (e.g. `--- a/foo`,
 * `+++ b/foo` file metadata) are ignored — they don't render as visible
 * editor lines and would otherwise inflate the placeholder height by
 * ~36 px per file.
 *
 * O(n) over the diff length, with no allocations beyond the result
 * object — diffs can be tens of thousands of lines on a full-file
 * expand-context, and this function runs once per fetch.
 */
export function countDiffLines(diff: string): DiffLineCounts {
  let context = 0;
  let insertions = 0;
  let deletions = 0;
  let hunks = 0;
  let inHunk = false;
  let i = 0;
  const len = diff.length;
  while (i < len) {
    const nl = diff.indexOf("\n", i);
    const end = nl === -1 ? len : nl;
    if (end > i) {
      const ch = diff.charCodeAt(i);
      // 64='@' 43='+' 45='-' 32=' '
      if (ch === 64 && diff.charCodeAt(i + 1) === 64) {
        inHunk = true;
        hunks++;
      } else if (inHunk && ch === 43) {
        insertions++;
      } else if (inHunk && ch === 45) {
        deletions++;
      } else if (inHunk && ch === 32) {
        context++;
      }
      // Pre-hunk header lines (`---`/`+++`) and lines that don't start
      // with any of the above (e.g. "\ No newline at end of file"
      // diagnostics, or stray blanks) are intentionally ignored — they
      // don't render visible lines in CodeMirror.
    }
    i = end + 1;
  }
  return { context, insertions, deletions, hunks };
}

/**
 * Pixel height of the diff content area (everything below the header) for
 * a row whose diff has loaded. Used as the placeholder height when
 * CodeMirror isn't mounted, so toggling visibility doesn't shift the
 * row's footprint.
 */
export function diffContentHeight(
  counts: DiffLineCounts,
  viewMode: DiffViewMode,
  canLoadMore: boolean,
): number {
  const { context, insertions, deletions, hunks } = counts;
  // Unified view stacks deleted, context, and inserted lines as a single
  // column — every line consumes vertical space. Split view shows old vs
  // new side by side and pads the shorter side to match the taller one,
  // so the visible height is `context + max(deletions, insertions)`.
  // (Equivalent to `max(context + deletions, context + insertions)` —
  // factored to make the "shared context, take whichever side is longer"
  // intent obvious.)
  const contentLines =
    viewMode === "split"
      ? context + Math.max(deletions, insertions)
      : context + insertions + deletions;
  const hunkSeparators = Math.max(0, hunks - 1) * ROW_HUNK_SEPARATOR_HEIGHT;
  const showFullBar = canLoadMore ? ROW_SHOW_FULL_BAR_HEIGHT : 0;
  return ROW_DIFF_DIVIDER + showFullBar + contentLines * ROW_CM_LINE_HEIGHT + hunkSeparators;
}
