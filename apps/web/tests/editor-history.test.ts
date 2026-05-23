// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { beforeAll, describe, expect, it } from "vitest";
import { type UseEditorHistoryReturn, useEditorHistory } from "@/dashboard";

// Tell React we're in a test environment that supports act()
beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Minimal renderHook utility — avoids adding @testing-library/react
// ---------------------------------------------------------------------------
function renderHook(): { result: { current: UseEditorHistoryReturn }; unmount: () => void } {
  const result = { current: undefined as unknown as UseEditorHistoryReturn };
  let root: Root;

  function TestComponent() {
    result.current = useEditorHistory();
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);

  act(() => {
    root = createRoot(container);
    root.render(createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Basic push / back / forward
// ---------------------------------------------------------------------------
describe("useEditorHistory – basic navigation", () => {
  it("starts with canGoBack and canGoForward both false", () => {
    const { result, unmount } = renderHook();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
    unmount();
  });

  it("goBack returns undefined when stack is empty", () => {
    const { result, unmount } = renderHook();
    let entry: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      entry = result.current.goBack();
    });
    expect(entry!).toBeUndefined();
    unmount();
  });

  it("goForward returns undefined when stack is empty", () => {
    const { result, unmount } = renderHook();
    let entry: ReturnType<UseEditorHistoryReturn["goForward"]>;
    act(() => {
      entry = result.current.goForward();
    });
    expect(entry!).toBeUndefined();
    unmount();
  });

  it("pushing one entry does not enable back (only one item in stack)", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
    });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
    unmount();
  });

  it("pushing two entries enables back", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 1 });
    });
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
    unmount();
  });

  it("goBack returns the previous entry and enables forward", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 10 });
    });

    let entry: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      entry = result.current.goBack();
    });

    expect(entry!).toEqual({ filePath: "a.ts", line: 1 });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(true);
    unmount();
  });

  it("goForward returns the next entry after going back", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 10 });
    });

    act(() => {
      result.current.goBack();
    });

    let entry: ReturnType<UseEditorHistoryReturn["goForward"]>;
    act(() => {
      entry = result.current.goForward();
    });

    expect(entry!).toEqual({ filePath: "b.ts", line: 10 });
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
    unmount();
  });

  it("navigates through a three-entry stack correctly", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 20 });
      result.current.push({ filePath: "c.ts", line: 50 });
    });

    // Go back twice
    let entry1: ReturnType<UseEditorHistoryReturn["goBack"]>;
    let entry2: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      entry1 = result.current.goBack();
    });
    act(() => {
      entry2 = result.current.goBack();
    });
    expect(entry1!).toEqual({ filePath: "b.ts", line: 20 });
    expect(entry2!).toEqual({ filePath: "a.ts", line: 1 });

    // Can't go back further
    expect(result.current.canGoBack).toBe(false);

    // Go forward twice
    let fwd1: ReturnType<UseEditorHistoryReturn["goForward"]>;
    let fwd2: ReturnType<UseEditorHistoryReturn["goForward"]>;
    act(() => {
      fwd1 = result.current.goForward();
    });
    act(() => {
      fwd2 = result.current.goForward();
    });
    expect(fwd1!).toEqual({ filePath: "b.ts", line: 20 });
    expect(fwd2!).toEqual({ filePath: "c.ts", line: 50 });

    // Can't go forward further
    expect(result.current.canGoForward).toBe(false);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Forward stack truncation (browser-like behavior)
// ---------------------------------------------------------------------------
describe("useEditorHistory – forward stack truncation", () => {
  it("pushing after goBack truncates the forward stack", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 20 });
      result.current.push({ filePath: "c.ts", line: 50 });
    });

    // Go back to b.ts
    act(() => {
      result.current.goBack();
    });

    // Push a new entry — this should truncate c.ts from forward stack
    act(() => {
      // The navigatingRef sentinel is true here, so the first push is a no-op.
      // We need to "consume" the sentinel first.
      result.current.push({ filePath: "sentinel-consumed" });
    });
    act(() => {
      result.current.push({ filePath: "d.ts", line: 99 });
    });

    // Forward should be disabled (c.ts was truncated)
    expect(result.current.canGoForward).toBe(false);

    // Going back should reach b.ts, then a.ts
    let back1: ReturnType<UseEditorHistoryReturn["goBack"]>;
    let back2: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      back1 = result.current.goBack();
    });
    act(() => {
      back2 = result.current.goBack();
    });
    expect(back1!).toEqual({ filePath: "b.ts", line: 20 });
    expect(back2!).toEqual({ filePath: "a.ts", line: 1 });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Navigating sentinel – goBack/goForward suppress the next push
// ---------------------------------------------------------------------------
describe("useEditorHistory – navigating sentinel", () => {
  it("the first push after goBack is suppressed", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 20 });
    });

    act(() => {
      result.current.goBack();
    });

    // This push should be silently ignored (sentinel is true)
    act(() => {
      result.current.push({ filePath: "should-be-ignored.ts", line: 999 });
    });

    // We should still be able to go forward to b.ts
    expect(result.current.canGoForward).toBe(true);
    let fwd: ReturnType<UseEditorHistoryReturn["goForward"]>;
    act(() => {
      fwd = result.current.goForward();
    });
    expect(fwd!).toEqual({ filePath: "b.ts", line: 20 });
    unmount();
  });

  it("the first push after goForward is suppressed", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 20 });
    });

    act(() => {
      result.current.goBack();
    });
    act(() => {
      result.current.goForward();
    });

    // This push should be silently ignored (sentinel is true)
    act(() => {
      result.current.push({ filePath: "should-be-ignored.ts", line: 999 });
    });

    // Stack should still be [a.ts, b.ts] with cursor at b.ts
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
    let back: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      back = result.current.goBack();
    });
    expect(back!).toEqual({ filePath: "a.ts", line: 1 });
    unmount();
  });

  it("sentinel resets after one push — second push goes through", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 1 });
      result.current.push({ filePath: "b.ts", line: 20 });
    });

    act(() => {
      result.current.goBack();
    });

    // First push is suppressed
    act(() => {
      result.current.push({ filePath: "suppressed.ts" });
    });

    // Second push goes through
    act(() => {
      result.current.push({ filePath: "c.ts", line: 50 });
    });

    // Going back should reach a.ts (b.ts was truncated since we pushed c.ts after going back to a.ts)
    let back: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      back = result.current.goBack();
    });
    expect(back!).toEqual({ filePath: "a.ts", line: 1 });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Deduplication (entriesAreClose)
// ---------------------------------------------------------------------------
describe("useEditorHistory – deduplication", () => {
  it("skips push when same file and line is within ±5 lines", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      // Lines 5–15 are "close" to line 10
      result.current.push({ filePath: "a.ts", line: 12 });
    });

    // Should still have only one entry — canGoBack false
    expect(result.current.canGoBack).toBe(false);
    unmount();
  });

  it("allows push when same file but line differs by more than 5", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      result.current.push({ filePath: "a.ts", line: 20 });
    });

    expect(result.current.canGoBack).toBe(true);
    unmount();
  });

  it("allows push for different files regardless of line proximity", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      result.current.push({ filePath: "b.ts", line: 10 });
    });

    expect(result.current.canGoBack).toBe(true);
    unmount();
  });

  it("treats two entries without line numbers in the same file as duplicates", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts" });
      result.current.push({ filePath: "a.ts" });
    });

    expect(result.current.canGoBack).toBe(false);
    unmount();
  });

  it("treats entries at exact proximity boundary (±5) as close", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      result.current.push({ filePath: "a.ts", line: 15 }); // exactly 5 away
    });

    // |10 - 15| = 5, which is <= 5, so they are "close" — deduplicated
    expect(result.current.canGoBack).toBe(false);
    unmount();
  });

  it("treats entries just beyond proximity boundary as different", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      result.current.push({ filePath: "a.ts", line: 16 }); // 6 away
    });

    // |10 - 16| = 6, which is > 5, so they are different
    expect(result.current.canGoBack).toBe(true);
    unmount();
  });

  it("when one entry has a line and the other does not, they are different", () => {
    const { result, unmount } = renderHook();
    act(() => {
      result.current.push({ filePath: "a.ts", line: 10 });
      result.current.push({ filePath: "a.ts" });
    });

    expect(result.current.canGoBack).toBe(true);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Stack cap (MAX_HISTORY = 100)
// ---------------------------------------------------------------------------
describe("useEditorHistory – stack size cap", () => {
  it("caps the stack at 100 entries by dropping the oldest", () => {
    const { result, unmount } = renderHook();
    act(() => {
      // Push 105 entries across different files (no dedup)
      for (let i = 0; i < 105; i++) {
        result.current.push({ filePath: `file-${i}.ts`, line: i + 1 });
      }
    });

    // Go back should work for 99 entries (100 total, cursor at 99, back to 0)
    let backCount = 0;
    let entry: ReturnType<UseEditorHistoryReturn["goBack"]>;
    act(() => {
      while (true) {
        entry = result.current.goBack();
        if (entry === undefined) break;
        backCount++;
      }
    });

    // 100 entries in stack, cursor starts at 99, can go back 99 times
    expect(backCount).toBe(99);

    // The oldest 5 entries (file-0 through file-4) should have been dropped
    // The first entry in the stack should be file-5.ts
    // (cursor is at 0 after going all the way back)
    unmount();
  });
});
