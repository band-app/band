// @vitest-environment jsdom
/**
 * Unit tests for the pure helpers backing the long-press → word select →
 * arrow-extend flow. Each helper is a function over xterm.js's public buffer
 * API and the DOM rect; we exercise them with hand-built fakes that mirror
 * the shape xterm exposes at runtime.
 */
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  applySelection,
  type Cell,
  findWordBoundaries,
  getLineText,
  moveCell,
  pointToCell,
  wordSelectionAt,
} from "../src/lib/terminal-selection";

// ---------------------------------------------------------------------------
// Tiny xterm.js shape — only the fields the helpers actually read. Each test
// builds one of these inline so it's clear which input drove the assertion.
// ---------------------------------------------------------------------------

interface FakeBufferLine {
  text: string;
}

interface FakeTerminal {
  cols: number;
  rows: number;
  viewportY: number;
  bufferLength: number;
  lines: Map<number, FakeBufferLine>;
  selectCalls: Array<{ col: number; row: number; length: number }>;
}

function makeTerminal(opts: Partial<FakeTerminal> & { cols?: number } = {}): Terminal {
  const t: FakeTerminal = {
    cols: 80,
    rows: 24,
    viewportY: 0,
    bufferLength: 100,
    lines: new Map(),
    selectCalls: [],
    ...opts,
  };
  return {
    cols: t.cols,
    rows: t.rows,
    buffer: {
      active: {
        viewportY: t.viewportY,
        length: t.bufferLength,
        getLine: (y: number) => {
          const line = t.lines.get(y);
          if (!line) return undefined;
          return {
            translateToString: (_trimRight?: boolean) => line.text,
          };
        },
      },
    },
    select: (col: number, row: number, length: number) => {
      t.selectCalls.push({ col, row, length });
    },
    // Expose the underlying fake for assertions.
    __fake: t,
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake; we only access fields the helpers use.
  } as any;
}

function fakeOf(terminal: Terminal): FakeTerminal {
  return (terminal as unknown as { __fake: FakeTerminal }).__fake;
}

// ---------------------------------------------------------------------------
// findWordBoundaries
// ---------------------------------------------------------------------------

describe("findWordBoundaries", () => {
  it("selects an alphanumeric identifier in the middle of a line", () => {
    //           0         1         2
    //           0123456789012345678901
    const line = "  hello world foo bar";
    expect(findWordBoundaries(line, 3)).toEqual({ start: 2, end: 7 }); // "hello"
    expect(findWordBoundaries(line, 8)).toEqual({ start: 8, end: 13 }); // "world"
  });

  it("extends across path separators (typical terminal token)", () => {
    const line = "cd /usr/local/bin";
    // long-press on "local"
    expect(findWordBoundaries(line, 9)).toEqual({ start: 3, end: 17 });
  });

  it("includes dots, dashes, underscores in the word", () => {
    const line = "run --verbose foo.tar.gz bar_baz";
    expect(findWordBoundaries(line, 5)).toEqual({ start: 4, end: 13 }); // "--verbose"
    expect(findWordBoundaries(line, 16)).toEqual({ start: 14, end: 24 }); // "foo.tar.gz"
    expect(findWordBoundaries(line, 27)).toEqual({ start: 25, end: 32 }); // "bar_baz"
  });

  it("returns a 1-cell range when col is on whitespace", () => {
    const line = "abc def";
    expect(findWordBoundaries(line, 3)).toEqual({ start: 3, end: 4 });
  });

  it("handles col past end of line by returning a 1-cell range at the line end", () => {
    const line = "abc";
    expect(findWordBoundaries(line, 10)).toEqual({ start: 3, end: 4 });
  });

  it("handles col past end of an empty line by returning a 1-cell range at 0", () => {
    expect(findWordBoundaries("", 5)).toEqual({ start: 0, end: 1 });
  });
});

// ---------------------------------------------------------------------------
// pointToCell
// ---------------------------------------------------------------------------

describe("pointToCell", () => {
  function makeScreenEl(width: number, height: number, left = 0, top = 0): HTMLElement {
    const el = document.createElement("div");
    el.getBoundingClientRect = () =>
      ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    return el;
  }

  it("maps a click in the middle of the screen to the middle cell", () => {
    const terminal = makeTerminal({ cols: 80, rows: 24 });
    const screen = makeScreenEl(800, 480); // 10px/cell wide, 20px/cell tall
    const cell = pointToCell(405, 245, terminal, screen);
    expect(cell).toEqual({ col: 40, row: 12 });
  });

  it("adds viewportY so the returned row is an absolute buffer row", () => {
    const terminal = makeTerminal({ cols: 80, rows: 24, viewportY: 200 });
    const screen = makeScreenEl(800, 480);
    const cell = pointToCell(5, 5, terminal, screen);
    expect(cell).toEqual({ col: 0, row: 200 });
  });

  it("clamps to the last visible cell when the touch is past the right edge", () => {
    const terminal = makeTerminal({ cols: 80, rows: 24 });
    const screen = makeScreenEl(800, 480);
    const cell = pointToCell(10_000, 10_000, terminal, screen);
    expect(cell).toEqual({ col: 79, row: 23 });
  });

  it("clamps to (0, viewportY) when the touch is past the left/top edge", () => {
    const terminal = makeTerminal({ cols: 80, rows: 24, viewportY: 50 });
    const screen = makeScreenEl(800, 480);
    const cell = pointToCell(-100, -100, terminal, screen);
    expect(cell).toEqual({ col: 0, row: 50 });
  });

  it("falls back to (0, viewportY) when the rect has zero area", () => {
    const terminal = makeTerminal({ cols: 80, rows: 24, viewportY: 7 });
    const screen = makeScreenEl(0, 0);
    expect(pointToCell(100, 100, terminal, screen)).toEqual({ col: 0, row: 7 });
  });

  // Regression coverage for band-app/band#463. We fix the bug by taking
  // the xterm container out of the document-level CSS `zoom` coordinate
  // space (counter-zoom on the container — see TerminalPanel render
  // block). Once that's in place both `clientX/Y` and
  // `getBoundingClientRect()` report values in unzoomed CSS pixels, and
  // `pointToCell`'s math depends only on the relative position of the
  // click within the rect.
  //
  // The single assertion below pins that property: the helper computes
  // the click coordinate from a target cell + rect, so passing those
  // back into `pointToCell` MUST recover the target cell. The math is
  // scale-invariant by construction, which is exactly what the
  // counter-zoom approach guarantees at runtime — there's no useful
  // additional coverage in re-running the same assertion across
  // arbitrary scale factors (every parameterized iteration would feed
  // identical inputs).
  it("regression #463: maps a click to the target cell under counter-zoom", () => {
    function clickAtCell(
      col: number,
      row: number,
      cols: number,
      rows: number,
      rectWidth: number,
      rectHeight: number,
      rectLeft = 0,
      rectTop = 0,
    ): { clientX: number; clientY: number } {
      // Pick the middle of the target cell so off-by-one in either floor()
      // or the half-pixel rect boundary doesn't slip us into a neighbor.
      const cellW = rectWidth / cols;
      const cellH = rectHeight / rows;
      return {
        clientX: rectLeft + (col + 0.5) * cellW,
        clientY: rectTop + (row + 0.5) * cellH,
      };
    }

    const terminal = makeTerminal({ cols: 80, rows: 24 });
    const screen = makeScreenEl(800, 480, 50, 30);
    const { clientX, clientY } = clickAtCell(42, 10, 80, 24, 800, 480, 50, 30);
    expect(pointToCell(clientX, clientY, terminal, screen)).toEqual({ col: 42, row: 10 });
  });
});

// ---------------------------------------------------------------------------
// moveCell
// ---------------------------------------------------------------------------

describe("moveCell", () => {
  it("moves left within a row", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 10, row: 5 }, "left", terminal)).toEqual({ col: 9, row: 5 });
  });

  it("wraps left at col 0 to the previous row's last cell", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 0, row: 5 }, "left", terminal)).toEqual({ col: 79, row: 4 });
  });

  it("does not move left past (0, 0)", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 0, row: 0 }, "left", terminal)).toEqual({ col: 0, row: 0 });
  });

  it("wraps right at the last column to the next row's first cell", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 79, row: 5 }, "right", terminal)).toEqual({ col: 0, row: 6 });
  });

  it("does not move right past the last buffer row", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 79, row: 99 }, "right", terminal)).toEqual({ col: 79, row: 99 });
  });

  it("moves up and down by full rows, clamped to buffer bounds", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    expect(moveCell({ col: 10, row: 5 }, "up", terminal)).toEqual({ col: 10, row: 4 });
    expect(moveCell({ col: 10, row: 0 }, "up", terminal)).toEqual({ col: 10, row: 0 });
    expect(moveCell({ col: 10, row: 5 }, "down", terminal)).toEqual({ col: 10, row: 6 });
    expect(moveCell({ col: 10, row: 99 }, "down", terminal)).toEqual({ col: 10, row: 99 });
  });
});

// ---------------------------------------------------------------------------
// applySelection
// ---------------------------------------------------------------------------

describe("applySelection", () => {
  it("forwards a forward range (anchor before head) to terminal.select", () => {
    const terminal = makeTerminal({ cols: 80 });
    applySelection(terminal, { col: 5, row: 2 }, { col: 10, row: 2 });
    expect(fakeOf(terminal).selectCalls).toEqual([{ col: 5, row: 2, length: 6 }]);
  });

  it("normalizes a reverse range (head before anchor) to start at the smaller end", () => {
    const terminal = makeTerminal({ cols: 80 });
    applySelection(terminal, { col: 10, row: 2 }, { col: 5, row: 2 });
    expect(fakeOf(terminal).selectCalls).toEqual([{ col: 5, row: 2, length: 6 }]);
  });

  it("spans multiple rows with the correct cell length", () => {
    const terminal = makeTerminal({ cols: 80 });
    // (col 70, row 2) → (col 10, row 4)
    // length = (4*80 + 10) - (2*80 + 70) + 1 = 330 - 230 + 1 = 101
    applySelection(terminal, { col: 70, row: 2 }, { col: 10, row: 4 });
    expect(fakeOf(terminal).selectCalls).toEqual([{ col: 70, row: 2, length: 101 }]);
  });

  it("is a no-op when cols is zero (defensive)", () => {
    const terminal = makeTerminal({ cols: 0 });
    applySelection(terminal, { col: 0, row: 0 }, { col: 0, row: 0 });
    expect(fakeOf(terminal).selectCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// wordSelectionAt + getLineText (integration through findWordBoundaries)
// ---------------------------------------------------------------------------

describe("wordSelectionAt", () => {
  it("returns inclusive (anchor, head) cells around the word", () => {
    const result = wordSelectionAt({ col: 9, row: 7 }, "cd /usr/local/bin");
    // word = "/usr/local/bin" → start=3, end=17 (exclusive)
    expect(result.anchor).toEqual({ col: 3, row: 7 });
    expect(result.head).toEqual({ col: 16, row: 7 });
  });

  it("collapses to a 1-cell range when long-pressing on whitespace", () => {
    const result = wordSelectionAt({ col: 2, row: 7 }, "ab  cd");
    expect(result.anchor).toEqual({ col: 2, row: 7 });
    expect(result.head).toEqual({ col: 2, row: 7 });
  });
});

describe("getLineText", () => {
  it("returns the line text from xterm.js's buffer", () => {
    const lines = new Map<number, FakeBufferLine>([
      [3, { text: "hello world" }],
      [4, { text: "foo bar" }],
    ]);
    const terminal = makeTerminal({ lines });
    expect(getLineText(terminal, 3)).toBe("hello world");
    expect(getLineText(terminal, 4)).toBe("foo bar");
  });

  it("returns an empty string for a missing row", () => {
    const terminal = makeTerminal({ lines: new Map() });
    expect(getLineText(terminal, 99)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: simulate a long-press + a few arrow extensions
// ---------------------------------------------------------------------------

describe("integration: long-press then extend", () => {
  it("extends a word selection rightward by one cell per arrow press", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    const lineText = "the quick brown fox";
    // Long-press on "quick" (col 6).
    const { anchor, head } = wordSelectionAt({ col: 6, row: 1 }, lineText);
    expect(anchor).toEqual({ col: 4, row: 1 });
    expect(head).toEqual({ col: 8, row: 1 });
    applySelection(terminal, anchor, head);

    // Tap → → →: head moves right three times.
    let h: Cell = head;
    for (let i = 0; i < 3; i++) h = moveCell(h, "right", terminal);
    expect(h).toEqual({ col: 11, row: 1 });
    applySelection(terminal, anchor, h);

    const calls = fakeOf(terminal).selectCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ col: 4, row: 1, length: 5 }); // "quick"
    expect(calls[1]).toEqual({ col: 4, row: 1, length: 8 }); // "quick br"
  });

  it("flips direction when the head crosses the anchor (shrink-and-grow-other-side)", () => {
    const terminal = makeTerminal({ cols: 80, bufferLength: 100 });
    // Initial: anchor (10, 1), head (12, 1) — a 3-cell selection.
    const anchor: Cell = { col: 10, row: 1 };
    let head: Cell = { col: 12, row: 1 };
    // Move left 5 times: head ends at col 7. Selection now extends from col 7
    // through col 10 (anchor), and the call is normalized to start at col 7.
    for (let i = 0; i < 5; i++) head = moveCell(head, "left", terminal);
    expect(head).toEqual({ col: 7, row: 1 });
    applySelection(terminal, anchor, head);
    expect(fakeOf(terminal).selectCalls.pop()).toEqual({ col: 7, row: 1, length: 4 });
  });
});
