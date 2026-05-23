// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorLineTracker } from "@/dashboard";

// ---------------------------------------------------------------------------
// Helper: create a CodeMirror EditorView with the cursorLineTracker extension
// ---------------------------------------------------------------------------
function createEditor(
  doc: string,
  onJump: (departure: number, arrival: number) => void,
): EditorView {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const state = EditorState.create({
    doc,
    extensions: [cursorLineTracker(onJump)],
  });

  return new EditorView({ state, parent: container });
}

function destroyEditor(view: EditorView) {
  const parent = view.dom.parentElement;
  view.destroy();
  parent?.remove();
}

/**
 * Dispatch a user-initiated cursor move to a specific line.
 *
 * The `isUserEvent("select")` check inside cursorLineTracker requires
 * the transaction to carry a `select` user-event annotation.
 */
function userMoveCursorToLine(view: EditorView, lineNumber: number) {
  const line = view.state.doc.line(lineNumber);
  view.dispatch({
    selection: { anchor: line.from },
    userEvent: "select",
  });
}

/**
 * Dispatch a programmatic cursor move (no userEvent annotation).
 */
function programmaticMoveCursorToLine(view: EditorView, lineNumber: number) {
  const line = view.state.doc.line(lineNumber);
  view.dispatch({
    selection: { anchor: line.from },
  });
}

// Generate a multi-line document
function makeDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("cursorLineTracker", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    if (view) {
      destroyEditor(view);
      view = null;
    }
  });

  it("fires callback when user jumps ≥10 lines", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    // Place cursor at line 1 first (initializes lastLine)
    userMoveCursorToLine(view, 1);
    expect(onJump).not.toHaveBeenCalled();

    // Jump from line 1 to line 15 (14 lines away, ≥ 10)
    userMoveCursorToLine(view, 15);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(1, 15);
  });

  it("does not fire callback for small cursor moves (< 10 lines)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 1);
    userMoveCursorToLine(view, 5); // 4 lines away
    userMoveCursorToLine(view, 9); // 4 lines away

    expect(onJump).not.toHaveBeenCalled();
  });

  it("fires callback at exact threshold boundary (10 lines)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 1);
    userMoveCursorToLine(view, 11); // exactly 10 lines away

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(1, 11);
  });

  it("does not fire at 9 lines (just below threshold)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 1);
    userMoveCursorToLine(view, 10); // 9 lines away

    expect(onJump).not.toHaveBeenCalled();
  });

  it("ignores programmatic cursor moves (no userEvent annotation)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    // Initialize with a user move
    userMoveCursorToLine(view, 1);

    // Programmatic move — should be ignored
    programmaticMoveCursorToLine(view, 40);

    expect(onJump).not.toHaveBeenCalled();
  });

  it("tracks lastLine correctly across multiple jumps", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 1);
    userMoveCursorToLine(view, 20); // jump from 1 → 20
    userMoveCursorToLine(view, 40); // jump from 20 → 40

    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenNthCalledWith(1, 1, 20);
    expect(onJump).toHaveBeenNthCalledWith(2, 20, 40);
  });

  it("fires for backward jumps (scrolling up)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 40);
    userMoveCursorToLine(view, 5); // jump backward from 40 → 5

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(40, 5);
  });

  it("does not fire on the first cursor position (no departure yet)", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    // First move — lastLine starts at -1, so no jump is possible
    userMoveCursorToLine(view, 30);

    expect(onJump).not.toHaveBeenCalled();
  });

  it("interleaves small and large jumps correctly", () => {
    const onJump = vi.fn();
    view = createEditor(makeDoc(50), onJump);

    userMoveCursorToLine(view, 1); // init
    userMoveCursorToLine(view, 3); // small move, no fire
    userMoveCursorToLine(view, 5); // small move, no fire
    userMoveCursorToLine(view, 25); // jump from 5 → 25, fires
    userMoveCursorToLine(view, 27); // small move, no fire
    userMoveCursorToLine(view, 45); // jump from 27 → 45, fires

    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenNthCalledWith(1, 5, 25);
    expect(onJump).toHaveBeenNthCalledWith(2, 27, 45);
  });
});
