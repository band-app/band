/**
 * Pure helpers for the iOS long-press → word select → arrow-extend flow in
 * TerminalPanel.
 *
 * Kept in a separate module (no React, no DOM mutation) so each function is
 * trivially unit-testable through the xterm.js public API. The TerminalPanel
 * orchestrates the state machine; this file does the math.
 */
import type { Terminal } from "@xterm/xterm";

export interface Cell {
  /** Column in the buffer, 0-based. */
  col: number;
  /** Absolute buffer row, 0-based (includes scrollback above viewport). */
  row: number;
}

export type ArrowDirection = "left" | "right" | "up" | "down";

/**
 * What counts as a "word character" for the long-press initial selection.
 *
 * Terminal users select tokens, not English words — paths (`/etc/hosts`),
 * URLs, file extensions (`.tar.gz`), hyphenated flags (`--verbose`),
 * version numbers (`1.2.3`), and namespaced identifiers (`foo::bar`). The
 * regex below covers all of those. Whitespace, quotes, and brackets are
 * deliberately excluded so e.g. long-pressing inside `"foo/bar"` selects
 * `foo/bar` rather than the surrounding quotes.
 */
const WORD_RE = /[A-Za-z0-9_./:\-+@~]/;

/**
 * Convert a touch / pointer position in client coordinates to a buffer cell.
 *
 * Uses `getBoundingClientRect()` on the xterm screen element rather than any
 * private xterm internal: as long as the renderer paints cells edge-to-edge
 * (true for both DOM and WebGL renderers), the math is just
 * `floor((x - left) / cellWidth)`.
 *
 * Out-of-bounds touches are clamped to the nearest visible cell so e.g. a
 * tap on the 1px gutter around the screen still maps to a valid cell.
 */
export function pointToCell(
  clientX: number,
  clientY: number,
  terminal: Terminal,
  screenEl: HTMLElement,
): Cell {
  const rect = screenEl.getBoundingClientRect();
  // Defensive: a zero-size rect during a pending fit/resize would divide by 0.
  if (rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) {
    return { col: 0, row: terminal.buffer.active.viewportY };
  }
  const cellW = rect.width / terminal.cols;
  const cellH = rect.height / terminal.rows;
  const col = clamp(Math.floor((clientX - rect.left) / cellW), 0, terminal.cols - 1);
  const viewportRow = clamp(Math.floor((clientY - rect.top) / cellH), 0, terminal.rows - 1);
  return { col, row: terminal.buffer.active.viewportY + viewportRow };
}

/**
 * Find the start/end columns of the "word" at `col` in the given line text.
 *
 * Returns a one-cell range `[c, c + 1)` if `col` is not on a word character
 * (or is past the end of the line). Clamped to the line bounds so the
 * caller always gets a 1-cell selection it can apply — the user can grow
 * it with the toolbar arrows.
 *
 * `end` is exclusive (one past the last word cell), matching xterm.js's
 * `select(col, row, length)` semantics — `length = end - start`.
 */
export function findWordBoundaries(line: string, col: number): { start: number; end: number } {
  // Out-of-bounds (or non-word) → always a 1-cell range. Earlier versions
  // returned `{ start: clamp(...), end: col + 1 }` which for col past the
  // line length produced a multi-cell highlight of trailing whitespace
  // (band-app/band PR #413 review). Clamp start AND derive end as start + 1
  // so the range stays single-cell regardless of how far past the line the
  // user tapped.
  if (col < 0 || col >= line.length || !WORD_RE.test(line[col])) {
    const safeCol = clamp(col, 0, Math.max(0, line.length));
    return { start: safeCol, end: safeCol + 1 };
  }
  let start = col;
  while (start > 0 && WORD_RE.test(line[start - 1])) start--;
  let end = col + 1;
  while (end < line.length && WORD_RE.test(line[end])) end++;
  return { start, end };
}

/**
 * Read the line text for an absolute buffer row, or return an empty string
 * if the row doesn't exist (e.g. the user long-pressed past the end of the
 * scrollback). `false` for trimRight so trailing spaces remain in their
 * positions — `findWordBoundaries` relies on column offsets matching cells.
 */
export function getLineText(terminal: Terminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(false) ?? "";
}

/**
 * Move a single cell one step in `dir`, wrapping at row edges and clamping at
 * the buffer's first/last valid row. This is the per-tap behavior for the
 * arrow keys in selection mode: extend by one cell.
 */
export function moveCell(cell: Cell, dir: ArrowDirection, terminal: Terminal): Cell {
  const cols = terminal.cols;
  // `buffer.length` counts every line in scrollback + viewport, so the last
  // valid row index is `length - 1`.
  const lastRow = Math.max(0, terminal.buffer.active.length - 1);
  switch (dir) {
    case "left":
      if (cell.col > 0) return { col: cell.col - 1, row: cell.row };
      if (cell.row > 0) return { col: cols - 1, row: cell.row - 1 };
      return cell;
    case "right":
      if (cell.col < cols - 1) return { col: cell.col + 1, row: cell.row };
      if (cell.row < lastRow) return { col: 0, row: cell.row + 1 };
      return cell;
    case "up":
      if (cell.row > 0) return { col: cell.col, row: cell.row - 1 };
      return cell;
    case "down":
      if (cell.row < lastRow) return { col: cell.col, row: cell.row + 1 };
      return cell;
  }
}

/**
 * Apply a selection from `anchor` to `head` to the terminal, regardless of
 * which end is earlier. Wraps the two endpoints into xterm.js's
 * (start, row, length) shape, with length counted as the number of cells
 * inclusive of both endpoints.
 */
export function applySelection(terminal: Terminal, anchor: Cell, head: Cell): void {
  const cols = terminal.cols;
  if (cols <= 0) return;
  const anchorLinear = anchor.row * cols + anchor.col;
  const headLinear = head.row * cols + head.col;
  const startLinear = Math.min(anchorLinear, headLinear);
  const endLinear = Math.max(anchorLinear, headLinear);
  const length = endLinear - startLinear + 1;
  const startRow = Math.floor(startLinear / cols);
  const startCol = startLinear - startRow * cols;
  terminal.select(startCol, startRow, length);
}

/**
 * Convenience: given the cell the user long-pressed and the line text at
 * that row, compute the (anchor, head) pair to highlight the word.
 */
export function wordSelectionAt(cell: Cell, lineText: string): { anchor: Cell; head: Cell } {
  const { start, end } = findWordBoundaries(lineText, cell.col);
  return {
    anchor: { col: start, row: cell.row },
    // `head` is the last cell of the selection (inclusive). `end` from
    // findWordBoundaries is exclusive, so subtract one.
    head: { col: Math.max(start, end - 1), row: cell.row },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
