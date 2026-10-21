// ---------------------------------------------------------------------------
// Terminal web links
//
// Replaces `@xterm/addon-web-links`, which only joins rows xterm itself wrapped
// (`isWrapped`). Programs such as Claude Code (Ink) wrap text on their own and
// write a hard newline plus indentation, so a long URL arrives as several
// unrelated rows. This provider joins both kinds into one logical string, runs
// the same URL pattern as the addon over it and maps each match back to a
// buffer range that spans every row the URL covers.
//
// A hard join needs evidence: the row must end within `EDGE_SLACK` columns of
// the right edge and the next row, after its indentation, must start with a
// non-space character that is not a prompt or list marker. A URL that ends
// mid-row never extends, because the URL pattern stops at the first space.
// ---------------------------------------------------------------------------

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { readLineColumns } from "./terminal-file-links";

const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
/** Ink wraps at its box width, which can sit a couple of columns short of `cols`. */
const EDGE_SLACK = 2;
const MAX_ROWS_EACH_WAY = 16;
const MAX_CHARS = 8 * 1024;
const LIST_MARKER_RE = /^(?:[-*+•>❯›$#]\s|\d+[.)]\s)/;

interface RowSegment {
  /** 1-based buffer row. */
  y: number;
  /** Offset of this segment's first character in the joined string. */
  start: number;
  text: string;
  columnForIndex: number[];
  /** Index into `text` where the segment starts within the row's own text. */
  offset: number;
}

interface RowInfo {
  text: string;
  columnForIndex: number[];
  wrapped: boolean;
}

function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const base = url.username
      ? `${url.protocol}//${url.username}${url.password ? `:${url.password}` : ""}@${url.host}`
      : `${url.protocol}//${url.host}`;
    return text.toLowerCase().startsWith(base.toLowerCase());
  } catch {
    return false;
  }
}

function reachesEdge(row: RowInfo, cols: number): boolean {
  const trimmed = row.text.trimEnd();
  if (trimmed.length === 0) return false;
  const lastColumn = row.columnForIndex[trimmed.length - 1] ?? 0;
  return lastColumn >= cols - EDGE_SLACK;
}

/** Whether row `next` continues a URL that began on or before row `prev`. */
function continues(prev: RowInfo, next: RowInfo, cols: number): boolean {
  if (next.wrapped) return true;
  if (!reachesEdge(prev, cols)) return false;
  const stripped = next.text.trimStart();
  if (stripped.length === 0 || LIST_MARKER_RE.test(stripped)) return false;
  return true;
}

export function createTerminalWebLinkProvider(
  terminal: Terminal,
  onActivate: (event: MouseEvent, uri: string) => void,
): ILinkProvider {
  const readRow = (y: number): RowInfo | undefined => {
    const line = terminal.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    const { text, columnForIndex } = readLineColumns(terminal, line);
    return { text, columnForIndex, wrapped: line.isWrapped };
  };

  return {
    provideLinks(y, callback) {
      const here = readRow(y);
      if (!here) {
        callback(undefined);
        return;
      }
      const rows = new Map<number, RowInfo>([[y, here]]);
      const get = (row: number): RowInfo | undefined => {
        if (!rows.has(row)) {
          const info = readRow(row);
          if (!info) return undefined;
          rows.set(row, info);
        }
        return rows.get(row);
      };

      let first = y;
      for (let i = 0; i < MAX_ROWS_EACH_WAY; i++) {
        const above = get(first - 1);
        const current = get(first);
        if (!above || !current || !continues(above, current, terminal.cols)) break;
        first--;
      }
      let last = y;
      for (let i = 0; i < MAX_ROWS_EACH_WAY; i++) {
        const below = get(last + 1);
        const current = get(last);
        if (!below || !current || !continues(current, below, terminal.cols)) break;
        last++;
      }

      let joined = "";
      const segments: RowSegment[] = [];
      for (let row = first; row <= last; row++) {
        const info = get(row);
        if (!info) break;
        const isFirst = row === first;
        const hard = !isFirst && !info.wrapped;
        const offset = hard ? info.text.length - info.text.trimStart().length : 0;
        // A row followed by a soft-wrapped row keeps its trailing cells, which hold URL
        // text. Every other row is trimmed, so the blank slack Ink leaves before its
        // hard newline does not split the URL.
        const nextSoft = row < last && get(row + 1)?.wrapped === true;
        const body = nextSoft ? info.text : info.text.trimEnd();
        const text = body.slice(offset);
        if (joined.length + text.length > MAX_CHARS) break;
        segments.push({
          y: row,
          start: joined.length,
          text,
          columnForIndex: info.columnForIndex,
          offset,
        });
        joined += text;
      }

      const links: ILink[] = [];
      for (const match of joined.matchAll(URL_RE)) {
        const uri = match[0];
        if (!isUrl(uri)) continue;
        const from = match.index;
        const to = from + uri.length - 1;
        const startSeg = segmentAt(segments, from);
        const endSeg = segmentAt(segments, to);
        if (!startSeg || !endSeg || y < startSeg.y || y > endSeg.y) continue;
        const startX = startSeg.columnForIndex[startSeg.offset + from - startSeg.start] ?? 1;
        const endX = endSeg.columnForIndex[endSeg.offset + to - endSeg.start] ?? terminal.cols;
        links.push({
          text: uri,
          range: { start: { x: startX, y: startSeg.y }, end: { x: endX, y: endSeg.y } },
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => onActivate(event, uri),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

function segmentAt(segments: RowSegment[], index: number): RowSegment | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && index >= seg.start) return seg.start + seg.text.length > index ? seg : undefined;
  }
  return undefined;
}
