// @vitest-environment jsdom
import { createElement, useReducer } from "react";
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

  it("removeFile wipes every persisted field, not just editedContent", () => {
    // Regression for the back-arrow "Discard" path on untitled tabs:
    // the prior code only cleared `editedContent` (via `update(fp,
    // { editedContent: undefined })`), leaving the rest of the entry —
    // `editorState`, `scrollTop`, `language`, `viewMode` — in
    // localStorage. The serialized `editorState` contains the full
    // doc, so on reload CodeMirror would restore the supposedly-
    // discarded buffer. The fix re-routes the discard through the
    // full close path (`tabState.removeFile`), and this test pins the
    // invariant: every TabFileState field must be gone after a single
    // `removeFile` call, including for the `untitled:N` key shape.
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("untitled:1", {
        editedContent: "discarded buffer",
        // The shape of `editorState` is opaque from the hook's
        // perspective — store a sentinel so the test reads identically
        // whether CodeMirror's JSON shape changes upstream.
        editorState: { doc: "discarded buffer", selection: { ranges: [] } },
        scrollTop: 42,
      });
      result.current.setViewMode("untitled:1", "source");
      result.current.setLanguage("untitled:1", "typescript");
    });

    // Pre-condition: everything is set.
    expect(result.current.get("untitled:1")).toEqual({
      editedContent: "discarded buffer",
      editorState: { doc: "discarded buffer", selection: { ranges: [] } },
      scrollTop: 42,
      viewMode: "source",
      language: "typescript",
    });
    expect(result.current.isDirty("untitled:1")).toBe(true);

    act(() => {
      result.current.removeFile("untitled:1");
    });

    // Every read path must report empty afterwards.
    expect(result.current.get("untitled:1")).toBeUndefined();
    expect(result.current.getViewMode("untitled:1")).toBeUndefined();
    expect(result.current.getLanguage("untitled:1")).toBeUndefined();
    expect(result.current.isDirty("untitled:1")).toBe(false);

    // localStorage round-trip — make sure nothing slipped through the
    // serializer (e.g. a stray `editorState` key surviving `delete`).
    expect(JSON.parse(localStorage.getItem("band-tab-state:ws-1") ?? "{}")).toEqual({});
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
// Language override (manual syntax-highlighting picker)
// ---------------------------------------------------------------------------
describe("useTabState – language override", () => {
  it("returns undefined for a file with no stored override", () => {
    const { result, unmount } = renderHook("ws-1");
    expect(result.current.getLanguage("foo.ts")).toBeUndefined();
    unmount();
  });

  it("stores and retrieves a manual override", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setLanguage("foo.txt", "javascript");
    });
    expect(result.current.getLanguage("foo.txt")).toBe("javascript");
    unmount();
  });

  it("overwrites a previous override", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setLanguage("foo.txt", "javascript");
    });
    act(() => {
      result.current.setLanguage("foo.txt", "python");
    });
    expect(result.current.getLanguage("foo.txt")).toBe("python");
    unmount();
  });

  it("stores overrides for untitled paths the same as file-backed paths", () => {
    // Issue: the language picker didn't take effect on untitled tabs.
    // The storage layer keys overrides by filePath string, so the
    // synthetic `untitled:N` key has to round-trip the same as a
    // regular workspace path. This test pins that down so the
    // storage contract can't regress while the rest of the picker
    // wiring evolves.
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setLanguage("untitled:1", "typescript");
      result.current.setLanguage("src/foo.ts", "rust");
    });
    expect(result.current.getLanguage("untitled:1")).toBe("typescript");
    expect(result.current.getLanguage("src/foo.ts")).toBe("rust");
    unmount();
  });

  it("clears the override via update({ language: undefined }) — Auto Detect path", () => {
    // The picker's Auto Detect row sends `AUTO_DETECT_LANGUAGE_ID`,
    // which CodeBrowserView translates to `update({ language: undefined })`.
    // That has to drop the entry so the next `getLanguage` returns
    // undefined and FileViewer falls back to extension detection —
    // see `handleLanguageOverride` for the matching production path.
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setLanguage("foo.ts", "python");
    });
    expect(result.current.getLanguage("foo.ts")).toBe("python");
    act(() => {
      result.current.update("foo.ts", { language: undefined });
    });
    expect(result.current.getLanguage("foo.ts")).toBeUndefined();
    unmount();
  });

  it("language override and editedContent are independent for the same file", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.update("foo.ts", { editedContent: "modified" });
      result.current.setLanguage("foo.ts", "javascript");
    });
    expect(result.current.get("foo.ts")?.editedContent).toBe("modified");
    expect(result.current.getLanguage("foo.ts")).toBe("javascript");

    // Updating editedContent doesn't drop the override (the picker
    // choice has to survive every keystroke and every save).
    act(() => {
      result.current.update("foo.ts", { editedContent: "changed again" });
    });
    expect(result.current.getLanguage("foo.ts")).toBe("javascript");
    unmount();
  });

  it("overrides are independent across files", () => {
    const { result, unmount } = renderHook("ws-1");
    act(() => {
      result.current.setLanguage("a.txt", "javascript");
      result.current.setLanguage("b.txt", "python");
    });
    expect(result.current.getLanguage("a.txt")).toBe("javascript");
    expect(result.current.getLanguage("b.txt")).toBe("python");
    unmount();
  });

  // Regression test for "can't change language mode for untitled / unsaved
  // files". `useTabState` is a ref-backed side-channel, so a bare
  // `setLanguage` call writes to localStorage but never triggers a React
  // re-render — the language indicator in the FileViewer is computed from
  // a prop derived from `getLanguage(viewFilePath)`, so without an
  // explicit render trigger in the parent the new override is invisible
  // until something else happens to re-render the tree (tab switch,
  // edit, reload). `CodeBrowserView.handleLanguageOverride` pairs
  // `setLanguage` with a `useReducer`-driven version bump to drive that
  // render; this test pins the contract by reproducing the same
  // pattern at the hook level and asserting the child renders with the
  // new value.
  it("setLanguage + useReducer bump causes the child render to see the new value", () => {
    const renders: { language: string | undefined }[] = [];

    function Child({ language }: { language: string | undefined }) {
      renders.push({ language });
      return null;
    }

    let bump: () => void = () => {
      throw new Error("bump not yet wired");
    };
    let setLang: (id: string) => void = () => {
      throw new Error("setLang not yet wired");
    };

    function Parent() {
      const tabState = useTabState("ws-1");
      const [, force] = useReducer((x: number) => x + 1, 0);
      bump = force;
      setLang = (id: string) => {
        tabState.setLanguage("untitled:1", id);
        force();
      };
      return createElement(Child, { language: tabState.getLanguage("untitled:1") });
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    act(() => {
      root = createRoot(container);
      root.render(createElement(Parent));
    });

    // Initial render — no override yet.
    expect(renders.at(-1)?.language).toBeUndefined();

    // Without the bump, the next React render would still see the
    // stale prop (proven by the rest of this file: the ref store never
    // re-renders on its own). With the bump, the next render reads the
    // freshly-written override.
    act(() => {
      setLang("typescript");
    });
    expect(renders.at(-1)?.language).toBe("typescript");

    // Subsequent pick — verify overwrite propagates the same way.
    act(() => {
      setLang("python");
    });
    expect(renders.at(-1)?.language).toBe("python");

    // A bare bump (without a write) still reads the persisted value —
    // protects against any future "skip render if value didn't change"
    // optimisation accidentally reading from a stale closure.
    act(() => {
      bump();
    });
    expect(renders.at(-1)?.language).toBe("python");

    act(() => {
      root.unmount();
    });
    container.remove();
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

  it("persists language overrides across hook instances (incl. untitled paths)", () => {
    // The picker's choice is supposed to survive reloads — see the
    // `language` docblock on TabFileState. Both file-backed and
    // untitled paths share the same storage, so round-trip both.
    const { result: r1, unmount: u1 } = renderHook("ws-1");
    act(() => {
      r1.current.setLanguage("src/main.txt", "rust");
      r1.current.setLanguage("untitled:3", "markdown");
    });
    u1();

    const { result: r2, unmount: u2 } = renderHook("ws-1");
    expect(r2.current.getLanguage("src/main.txt")).toBe("rust");
    expect(r2.current.getLanguage("untitled:3")).toBe("markdown");
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
