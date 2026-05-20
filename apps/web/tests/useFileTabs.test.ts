// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type UseFileTabsReturn, useFileTabs } from "../src/hooks/useFileTabs";

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Minimal renderHook utility — avoids adding @testing-library/react
// ---------------------------------------------------------------------------
function renderHook(workspaceId: string): {
  result: { current: UseFileTabsReturn };
  unmount: () => void;
} {
  const result = { current: undefined as unknown as UseFileTabsReturn };
  let root: Root;

  function TestComponent() {
    result.current = useFileTabs(workspaceId);
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Basic open / pin / close
// ---------------------------------------------------------------------------
describe("useFileTabs — basic operations", () => {
  it("starts empty", () => {
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.activeTabPath).toBeNull();
    unmount();
  });

  it("openTab creates a pinned tab and activates it", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTab("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }]);
    expect(result.current.activeTabPath).toBe("a.ts");
    unmount();
  });

  it("openTabPreview creates a preview tab", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTabPreview("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts", isPreview: true }]);
    expect(result.current.activeTabPath).toBe("a.ts");
    unmount();
  });

  it("openTabPreview replaces an existing preview tab (clean preview)", () => {
    const { result, unmount } = renderHook("ws-1");
    let evicted: string | null = "unset";
    act(() => {
      result.current.openTabPreview("a.ts");
    });
    act(() => {
      evicted = result.current.openTabPreview("b.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "b.ts", isPreview: true }]);
    expect(result.current.activeTabPath).toBe("b.ts");
    expect(evicted).toBe("a.ts");
    unmount();
  });

  it("openTabPreview returns null when file is already open", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTab("a.ts");
    });
    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }]);
    expect(evicted).toBeNull();
    unmount();
  });

  it("pinTab converts a preview tab into a pinned tab", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTabPreview("a.ts");
    });
    act(() => {
      result.current.pinTab("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }]);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Dirty-preview race — the bug PR #374 introduces and we now guard against
// ---------------------------------------------------------------------------
describe("useFileTabs — dirty-preview guard (PR #374 fix)", () => {
  it("pins a dirty preview tab in place when a new preview is opened", () => {
    const { result, unmount } = renderHook("ws-1");

    // Open a preview tab and mark it dirty
    act(() => {
      result.current.openTabPreview("dirty.ts");
    });
    const isDirty = (path: string) => path === "dirty.ts";

    // Single-click on another file — dirty preview must be pinned, not evicted
    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("other.ts", isDirty);
    });

    // dirty.ts should be pinned (no longer a preview), other.ts is the new preview
    expect(result.current.openTabs).toEqual([
      { filePath: "dirty.ts" }, // pinned
      { filePath: "other.ts", isPreview: true },
    ]);
    expect(result.current.activeTabPath).toBe("other.ts");
    // Nothing was evicted — the dirty file stays around
    expect(evicted).toBeNull();
    unmount();
  });

  it("evicts a clean preview tab when isDirty returns false", () => {
    const { result, unmount } = renderHook("ws-1");

    act(() => {
      result.current.openTabPreview("clean.ts");
    });
    const isDirty = () => false;

    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("other.ts", isDirty);
    });

    // clean.ts is gone, other.ts is the new preview
    expect(result.current.openTabs).toEqual([{ filePath: "other.ts", isPreview: true }]);
    expect(evicted).toBe("clean.ts");
    unmount();
  });

  it("evicts a clean preview tab when isDirty is omitted", () => {
    const { result, unmount } = renderHook("ws-1");

    act(() => {
      result.current.openTabPreview("clean.ts");
    });

    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("other.ts");
    });

    expect(result.current.openTabs).toEqual([{ filePath: "other.ts", isPreview: true }]);
    expect(evicted).toBe("clean.ts");
    unmount();
  });

  it("does not consult isDirty when no preview tab exists", () => {
    const { result, unmount } = renderHook("ws-1");
    let isDirtyCalled = false;
    const isDirty = () => {
      isDirtyCalled = true;
      return true;
    };

    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("first.ts", isDirty);
    });

    expect(result.current.openTabs).toEqual([{ filePath: "first.ts", isPreview: true }]);
    expect(evicted).toBeNull();
    expect(isDirtyCalled).toBe(false);
    unmount();
  });

  it("does not consult isDirty for the file being opened", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTab("already-open.ts");
    });

    const calls: string[] = [];
    const isDirty = (path: string) => {
      calls.push(path);
      return false;
    };

    act(() => {
      result.current.openTabPreview("already-open.ts", isDirty);
    });

    // The already-open early-return path skips the preview lookup entirely.
    expect(calls).toEqual([]);
    unmount();
  });

  it("simulates the session-restore race: dirty preview survives first single-click", () => {
    // This is the scenario the PR fix targets: a dirty preview tab is
    // restored from localStorage on mount, and the user's FIRST single-click
    // on another file happens before any keystroke would have pinned it.

    // Seed localStorage with a preview tab
    localStorage.setItem(
      "band-open-tabs:ws-1",
      JSON.stringify({
        tabs: [{ filePath: "restored-preview.ts", isPreview: true }],
        active: "restored-preview.ts",
      }),
    );

    const { result, unmount } = renderHook("ws-1");
    expect(result.current.openTabs).toEqual([{ filePath: "restored-preview.ts", isPreview: true }]);

    // The user has unsaved edits in restored-preview.ts (loaded from tab-state).
    // First single-click on another file — without the dirty guard, restored
    // -preview.ts would be silently evicted along with its edits.
    const isDirty = (path: string) => path === "restored-preview.ts";

    let evicted: string | null = "unset";
    act(() => {
      evicted = result.current.openTabPreview("other.ts", isDirty);
    });

    expect(result.current.openTabs).toEqual([
      { filePath: "restored-preview.ts" }, // pinned, not evicted
      { filePath: "other.ts", isPreview: true },
    ]);
    expect(evicted).toBeNull();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// openTabPinned semantics — pins a preview, no-op on already-pinned
// ---------------------------------------------------------------------------
describe("useFileTabs — openTabPinned", () => {
  it("creates a pinned tab when the file is not open", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTabPinned("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }]);
    expect(result.current.activeTabPath).toBe("a.ts");
    unmount();
  });

  it("pins an existing preview tab", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTabPreview("a.ts");
    });
    act(() => {
      result.current.openTabPinned("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }]);
    unmount();
  });

  it("is a no-op (state-wise) on an already-pinned tab, but activates", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTab("a.ts");
      result.current.openTab("b.ts");
    });
    expect(result.current.activeTabPath).toBe("b.ts");

    act(() => {
      result.current.openTabPinned("a.ts");
    });
    expect(result.current.openTabs).toEqual([{ filePath: "a.ts" }, { filePath: "b.ts" }]);
    expect(result.current.activeTabPath).toBe("a.ts");
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Untitled tab close / reopen — make sure a fresh tab is fresh
// ---------------------------------------------------------------------------
describe("useFileTabs — untitled close+reopen", () => {
  it("closing an untitled tab clears it from openTabs and persisted state", () => {
    const { result, unmount } = renderHook("ws-1");
    let firstPath: string;
    act(() => {
      firstPath = result.current.openTabUntitled().filePath;
    });
    expect(result.current.openTabs).toEqual([
      { filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" },
    ]);
    expect(result.current.activeTabPath).toBe("untitled:1");

    act(() => {
      result.current.closeTab(firstPath);
    });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.activeTabPath).toBeNull();
    // The persisted tab list also has to drop the closed untitled — if
    // it survives, a reload would resurrect the tab pointing at the
    // (now stale) untitled:1 key, which is half of the bug the
    // back-arrow discard path was leaking.
    const persisted = JSON.parse(localStorage.getItem("band-open-tabs:ws-1") ?? "null");
    expect(persisted).toEqual({ tabs: [], active: null });
    unmount();
  });

  it("openTabUntitled after closing one returns a fresh monotonic key", () => {
    // The counter is intentionally monotonic — closing untitled:1 and
    // creating another scratch tab must NOT reuse the `untitled:1`
    // key, even though that slot is now free. Reusing it would let any
    // residual `band-tab-state:ws-1.untitled:1` entry (e.g. from a
    // pre-fix build that left `editorState` behind on discard) leak
    // into the new tab. This test pins the contract so the bug-fix's
    // assumption ("a new untitled tab is always a fresh key") can't
    // silently regress if the counter logic gets refactored.
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.openTabUntitled();
    });
    act(() => {
      result.current.closeTab("untitled:1");
    });
    let secondPath: string;
    act(() => {
      secondPath = result.current.openTabUntitled().filePath;
    });
    expect(secondPath!).toBe("untitled:2");
    expect(result.current.openTabs).toEqual([
      { filePath: "untitled:2", isUntitled: true, untitledLabel: "Untitled-2" },
    ]);
    unmount();
  });
});
