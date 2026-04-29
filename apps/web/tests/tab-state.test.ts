// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type UseTabStateReturn, useTabState } from "../src/hooks/useTabState";

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Minimal renderHook utility
// ---------------------------------------------------------------------------
function renderHook(workspaceId: string): {
  result: { current: UseTabStateReturn };
  unmount: () => void;
} {
  const result = { current: undefined as unknown as UseTabStateReturn };
  let root: Root;

  function TestComponent() {
    result.current = useTabState(workspaceId);
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
// Basic get / update / remove
// ---------------------------------------------------------------------------
describe("useTabState – basic operations", () => {
  it("returns undefined for a file with no stored state", () => {
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.get("foo.ts")).toBeUndefined();
    unmount();
  });

  it("stores and retrieves state via update + get", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "hello" });
    });
    expect(result.current.get("foo.ts")).toEqual({ editedContent: "hello" });
    unmount();
  });

  it("merges partial updates (does not overwrite unrelated fields)", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { viewMode: "source" });
    });
    act(() => {
      result.current.update("foo.ts", { editedContent: "modified" });
    });
    expect(result.current.get("foo.ts")).toEqual({
      viewMode: "source",
      editedContent: "modified",
    });
    unmount();
  });

  it("stores state for multiple files independently", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("a.ts", { editedContent: "a content" });
      result.current.update("b.ts", { editedContent: "b content" });
    });
    expect(result.current.get("a.ts")?.editedContent).toBe("a content");
    expect(result.current.get("b.ts")?.editedContent).toBe("b content");
    unmount();
  });

  it("removes all stored state for a file", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "hello" });
      result.current.setViewMode("foo.ts", "source");
    });
    act(() => {
      result.current.removeFile("foo.ts");
    });
    expect(result.current.get("foo.ts")).toBeUndefined();
    expect(result.current.getViewMode("foo.ts")).toBeUndefined();
    unmount();
  });

  it("removing a non-existent file is a no-op", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.removeFile("does-not-exist.ts");
    });
    expect(result.current.get("does-not-exist.ts")).toBeUndefined();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------
describe("useTabState – view mode", () => {
  it("returns undefined for a file with no stored view mode", () => {
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.getViewMode("readme.md")).toBeUndefined();
    unmount();
  });

  it("stores and retrieves view mode", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setViewMode("readme.md", "source");
    });
    expect(result.current.getViewMode("readme.md")).toBe("source");
    unmount();
  });

  it("overwrites view mode", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setViewMode("readme.md", "source");
    });
    act(() => {
      result.current.setViewMode("readme.md", "preview");
    });
    expect(result.current.getViewMode("readme.md")).toBe("preview");
    unmount();
  });

  it("view mode for different files is independent", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setViewMode("a.md", "source");
      result.current.setViewMode("b.md", "preview");
    });
    expect(result.current.getViewMode("a.md")).toBe("source");
    expect(result.current.getViewMode("b.md")).toBe("preview");
    unmount();
  });

  it("view mode and editedContent are independent for the same file", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("readme.md", { editedContent: "modified" });
      result.current.setViewMode("readme.md", "source");
    });
    expect(result.current.get("readme.md")?.editedContent).toBe("modified");
    expect(result.current.getViewMode("readme.md")).toBe("source");

    // Updating one doesn't affect the other
    act(() => {
      result.current.update("readme.md", { editedContent: "changed again" });
    });
    expect(result.current.getViewMode("readme.md")).toBe("source");
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Dirty detection
// ---------------------------------------------------------------------------
describe("useTabState – dirty detection", () => {
  it("returns false for a file with no edited content", () => {
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.isDirty("foo.ts")).toBe(false);
    unmount();
  });

  it("returns true when a file has edited content", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "modified" });
    });
    expect(result.current.isDirty("foo.ts")).toBe(true);
    unmount();
  });

  it("returns false after edited content is cleared", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "modified" });
    });
    expect(result.current.isDirty("foo.ts")).toBe(true);
    act(() => {
      result.current.update("foo.ts", { editedContent: undefined });
    });
    expect(result.current.isDirty("foo.ts")).toBe(false);
    unmount();
  });

  it("returns false after file is removed", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "modified" });
    });
    act(() => {
      result.current.removeFile("foo.ts");
    });
    expect(result.current.isDirty("foo.ts")).toBe(false);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------
describe("useTabState – localStorage persistence", () => {
  it("persists to localStorage and survives a new hook instance", () => {
    const { result: r1, unmount: u1 } = renderHook("ws-1");
    act(() => {
      r1.current.update("foo.ts", { editedContent: "modified" });
      r1.current.setViewMode("readme.md", "source");
    });
    u1();

    // New hook instance reads from localStorage
    const { result: r2, unmount: u2 } = renderHook("ws-1");
    expect(r2.current.get("foo.ts")?.editedContent).toBe("modified");
    expect(r2.current.getViewMode("readme.md")).toBe("source");
    u2();
  });

  it("persists removal to localStorage", () => {
    const { result: r1, unmount: u1 } = renderHook("ws-1");
    act(() => {
      r1.current.update("foo.ts", { editedContent: "modified" });
      r1.current.setViewMode("foo.ts", "source");
    });
    act(() => {
      r1.current.removeFile("foo.ts");
    });
    u1();

    const { result: r2, unmount: u2 } = renderHook("ws-1");
    expect(r2.current.get("foo.ts")).toBeUndefined();
    expect(r2.current.getViewMode("foo.ts")).toBeUndefined();
    u2();
  });

  it("uses the correct localStorage key per workspace", () => {
    const { result: r1, unmount: u1 } = renderHook("ws-1");
    act(() => {
      r1.current.update("foo.ts", { editedContent: "modified" });
      r1.current.setViewMode("readme.md", "source");
    });
    u1();

    const raw = localStorage.getItem("band-tab-state:ws-1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      "foo.ts": { editedContent: "modified" },
      "readme.md": { viewMode: "source" },
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace isolation
// ---------------------------------------------------------------------------
describe("useTabState – workspace isolation", () => {
  it("different workspaces have independent stores", () => {
    const { result: r1, unmount: u1 } = renderHook("ws-1");
    act(() => {
      r1.current.update("foo.ts", { editedContent: "ws1 content" });
      r1.current.setViewMode("readme.md", "source");
    });
    u1();

    const { result: r2, unmount: u2 } = renderHook("ws-2");
    expect(r2.current.get("foo.ts")).toBeUndefined();
    expect(r2.current.getViewMode("readme.md")).toBeUndefined();
    act(() => {
      r2.current.update("foo.ts", { editedContent: "ws2 content" });
    });
    u2();

    // ws-1 still has its original value
    const { result: r3, unmount: u3 } = renderHook("ws-1");
    expect(r3.current.get("foo.ts")?.editedContent).toBe("ws1 content");
    expect(r3.current.getViewMode("readme.md")).toBe("source");
    u3();
  });
});

// ---------------------------------------------------------------------------
// Resilience to corrupt localStorage
// ---------------------------------------------------------------------------
describe("useTabState – corrupt localStorage", () => {
  it("returns empty map when localStorage contains invalid JSON", () => {
    localStorage.setItem("band-tab-state:ws-1", "not-json");
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.get("foo.ts")).toBeUndefined();
    expect(result.current.getViewMode("foo.ts")).toBeUndefined();
    unmount();
  });

  it("returns empty map when localStorage contains a non-object", () => {
    localStorage.setItem("band-tab-state:ws-1", '"a string"');
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.get("foo.ts")).toBeUndefined();
    unmount();
  });

  it("returns empty map when localStorage contains null", () => {
    localStorage.setItem("band-tab-state:ws-1", "null");
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.get("foo.ts")).toBeUndefined();
    unmount();
  });
});
