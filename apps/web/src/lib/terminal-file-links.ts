// ---------------------------------------------------------------------------
// Terminal file links
//
// Detects file-path references in terminal output and turns them into
// clickable xterm links. Clicking one dispatches the same workspace-scoped
// `band:open-file` event the chat renderer uses (see
// `ai-elements/file-link-components.tsx`), which routes the path into Quick
// Open so the file lands in the file browser.
//
// Detection reuses `isFilePath` so the terminal and chat agree on what counts
// as a file reference (known extension, or a slash/line-indicator for bare
// names — see `file-path-detection.ts`). A permissive tokenizer first carves
// the line into path-shaped candidates; `isFilePath` then accepts or rejects
// each one, which is what keeps `http://host:5173` and `1.2.3` from linking.
// ---------------------------------------------------------------------------

import type { IBufferCell, IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import { isFilePath } from "./file-path-detection";

/**
 * A path candidate found within a single line of terminal text.
 * `startIndex`/`endIndex` are 0-based offsets into the line string
 * (`endIndex` exclusive).
 */
export interface TerminalFileMatch {
  text: string;
  startIndex: number;
  endIndex: number;
}

// A maximal run of path-shaped characters, optionally followed by a
// `:line`, `:line:col`, or `:line-end` suffix. The character class
// deliberately excludes `:` (except as the line-suffix separator) so a URL
// like `http://host` breaks into `http` + `//host` candidates — both of
// which `isFilePath` rejects — rather than matching as one token. The second
// separator may be `:` (column) or `-` (line range) so `src/main.rs:42:5`
// and `app.tsx:10-20` each stay a single candidate, matching the chat
// renderer's file-path grammar.
const CANDIDATE_RE = /[A-Za-z0-9._/@~+-]+(?::\d+(?:[-:]\d+)?)?/g;

/**
 * Find file-path references in one line of terminal text.
 *
 * Pure and dependency-light so it can be unit-tested without a DOM or a live
 * xterm instance.
 */
export function findTerminalFileLinks(lineText: string): TerminalFileMatch[] {
  const matches: TerminalFileMatch[] = [];
  CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = CANDIDATE_RE.exec(lineText);
  while (match !== null) {
    const text = match[0];
    if (isFilePath(text)) {
      matches.push({ text, startIndex: match.index, endIndex: match.index + text.length });
    }
    match = CANDIDATE_RE.exec(lineText);
  }
  return matches;
}

/**
 * Read a terminal buffer line into its text plus a map from each character's
 * string index to its 1-based terminal column. Walking cells (rather than
 * using `translateToString`) keeps the column mapping correct when wide
 * (CJK/emoji) glyphs precede a path on the same line: a wide glyph is one
 * string character but two columns, so a naive index→column assumption would
 * place the link underline a cell too far left for everything after it.
 */
function readLineColumns(
  terminal: Terminal,
  line: IBufferLine,
): { text: string; columnForIndex: number[] } {
  let text = "";
  const columnForIndex: number[] = [];
  let cell: IBufferCell | undefined;
  for (let x = 0; x < terminal.cols; x++) {
    cell = line.getCell(x, cell);
    if (!cell) continue;
    // Width 0 marks the trailing half of a wide glyph — no character of its
    // own, so skip it (its glyph was emitted by the preceding cell).
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    columnForIndex[text.length] = x + 1; // xterm columns are 1-based
    text += chars.length > 0 ? chars : " ";
  }
  return { text, columnForIndex };
}

/**
 * Build an xterm link provider that detects file paths on each line and, when
 * one is clicked, invokes `onActivate` with the matched text (path plus any
 * `:line[:col]` suffix). Register it with `terminal.registerLinkProvider(...)`.
 *
 * Wrapped lines are not stitched together: a path split across the right edge
 * of the viewport won't link. This keeps the provider simple and is rare for
 * the short relative paths that dominate build/git/test output.
 */
export function createTerminalFileLinkProvider(
  terminal: Terminal,
  onActivate: (text: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const { text, columnForIndex } = readLineColumns(terminal, line);
      const matches = findTerminalFileLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = matches.map((m) => {
        const startColumn = columnForIndex[m.startIndex] ?? 1;
        const endColumn = columnForIndex[m.endIndex - 1] ?? terminal.cols;
        return {
          text: m.text,
          range: {
            start: { x: startColumn, y: bufferLineNumber },
            end: { x: endColumn, y: bufferLineNumber },
          },
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            // Stop the click from also landing in the terminal (focus / paste
            // selection) once we've decided to open the file.
            event.preventDefault();
            onActivate(m.text);
          },
        };
      });
      callback(links);
    },
  };
}
