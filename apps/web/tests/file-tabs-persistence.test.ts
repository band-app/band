/**
 * Unit tests for the pure persistence helpers in `useFileTabs.ts`:
 * `parseTabState`, `serializeTabState`, `initialUntitledCounter`.
 *
 * The hook itself is React/localStorage-bound, but the parse/serialize
 * split lets us cover the non-trivial logic — defensive shape checks,
 * untitled-tab rehydration, the prefix-safety guard, counter
 * seeding — without spinning up a browser env. The localStorage layer
 * is exercised by hand in the dashboard; the corruption-vs-rehydration
 * paths covered here are the ones that historically broke quietly
 * when tab shapes changed across builds.
 */

import { describe, expect, it } from "vitest";
import {
  type FileTab,
  initialUntitledCounter,
  parseTabState,
  serializeTabState,
} from "../src/hooks/useFileTabs";

describe("parseTabState", () => {
  it("returns null for a missing or empty payload", () => {
    expect(parseTabState(null)).toBeNull();
    expect(parseTabState("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseTabState("not-json")).toBeNull();
    expect(parseTabState("{}")).toBeNull(); // missing tabs array
    expect(parseTabState('{"tabs":null}')).toBeNull();
  });

  it("accepts the legacy bare-string tab form", () => {
    const result = parseTabState(
      JSON.stringify({ tabs: ["src/main.ts", "README.md"], active: "src/main.ts" }),
    );
    expect(result).toEqual({
      tabs: [{ filePath: "src/main.ts" }, { filePath: "README.md" }],
      active: "src/main.ts",
    });
  });

  it("rehydrates preview / external flags from the object form", () => {
    const result = parseTabState(
      JSON.stringify({
        tabs: [
          { filePath: "src/preview.ts", isPreview: true },
          { filePath: "/abs/external.md", isExternal: true },
        ],
        active: null,
      }),
    );
    expect(result?.tabs).toEqual([
      { filePath: "src/preview.ts", isPreview: true },
      { filePath: "/abs/external.md", isExternal: true },
    ]);
  });

  it("rehydrates untitled tabs with their label", () => {
    const result = parseTabState(
      JSON.stringify({
        tabs: [{ filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" }],
        active: "untitled:1",
      }),
    );
    expect(result).toEqual({
      tabs: [{ filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" }],
      active: "untitled:1",
    });
  });

  it("rejects isUntitled:true on a path without the untitled prefix (defensive)", () => {
    // A future bug or a hand-edited localStorage payload could flag a
    // real file as untitled. The parser strips the flag rather than
    // letting a workspace path masquerade as a scratch buffer — that
    // would break `isUntitledPath` checks elsewhere in the code.
    const result = parseTabState(
      JSON.stringify({
        tabs: [{ filePath: "src/main.ts", isUntitled: true, untitledLabel: "Untitled-1" }],
        active: null,
      }),
    );
    expect(result?.tabs[0]).toEqual({ filePath: "src/main.ts" });
    expect(result?.tabs[0]).not.toHaveProperty("isUntitled");
    expect(result?.tabs[0]).not.toHaveProperty("untitledLabel");
  });

  it("drops non-string and non-object entries from the tabs array", () => {
    // Mixed-shape array — legacy builds may have written this. The
    // load path must not crash; downstream `.split("/")` calls expect
    // strings.
    const result = parseTabState(
      JSON.stringify({
        tabs: ["src/a.ts", 42, null, { filePath: "src/b.ts" }, { noPath: true }],
        active: null,
      }),
    );
    expect(result?.tabs).toEqual([{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }]);
  });

  it("rejects non-string active path", () => {
    const result = parseTabState(JSON.stringify({ tabs: [], active: 42 }));
    expect(result).toEqual({ tabs: [], active: null });
  });
});

describe("serializeTabState", () => {
  it("uses the bare-string form for plain pinned tabs", () => {
    const tabs: FileTab[] = [{ filePath: "src/main.ts" }, { filePath: "README.md" }];
    const out = serializeTabState(tabs, "src/main.ts");
    expect(JSON.parse(out)).toEqual({
      tabs: ["src/main.ts", "README.md"],
      active: "src/main.ts",
    });
  });

  it("uses the object form for flagged tabs", () => {
    const tabs: FileTab[] = [
      { filePath: "src/x.ts", isPreview: true },
      { filePath: "/abs/y.md", isExternal: true },
      { filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" },
    ];
    expect(JSON.parse(serializeTabState(tabs, null))).toEqual({
      tabs: [
        { filePath: "src/x.ts", isPreview: true },
        { filePath: "/abs/y.md", isExternal: true },
        { filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" },
      ],
      active: null,
    });
  });

  it("rewrites active to null when it doesn't name an open tab", () => {
    // Defensive guard for callers that pass a stale active pointer
    // (e.g. after closing the active tab without updating local
    // state). Without this, a reload would surface an orphan active
    // pointer that doesn't render any tab.
    const out = serializeTabState([{ filePath: "src/main.ts" }], "src/deleted.ts");
    expect(JSON.parse(out).active).toBeNull();
  });

  it("round-trips through parseTabState (all flag combinations)", () => {
    const tabs: FileTab[] = [
      { filePath: "src/main.ts" },
      { filePath: "src/preview.ts", isPreview: true },
      { filePath: "/abs/external.md", isExternal: true },
      { filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" },
      { filePath: "untitled:2", isUntitled: true, untitledLabel: "Untitled-2" },
    ];
    const restored = parseTabState(serializeTabState(tabs, "untitled:1"));
    expect(restored).toEqual({ tabs, active: "untitled:1" });
  });
});

describe("initialUntitledCounter", () => {
  it("returns 0 when there are no untitled tabs", () => {
    expect(initialUntitledCounter([])).toBe(0);
    expect(initialUntitledCounter([{ filePath: "src/main.ts" }])).toBe(0);
  });

  it("returns the highest N from existing untitled tabs", () => {
    // Order doesn't matter — the counter is "monotonic, never reused"
    // across the workspace's lifetime, so the next untitled tab should
    // get N+1 regardless of which slots are currently occupied.
    expect(
      initialUntitledCounter([
        { filePath: "untitled:1", isUntitled: true, untitledLabel: "Untitled-1" },
        { filePath: "untitled:3", isUntitled: true, untitledLabel: "Untitled-3" },
        { filePath: "untitled:2", isUntitled: true, untitledLabel: "Untitled-2" },
      ]),
    ).toBe(3);
  });

  it("ignores tabs without the untitled flag (defensive)", () => {
    // A workspace path that happens to look like the synthetic key
    // shouldn't shift the counter — the flag is the source of truth.
    expect(
      initialUntitledCounter([{ filePath: "untitled:99", untitledLabel: "Untitled-99" }]),
    ).toBe(0);
  });

  it("ignores malformed untitled paths", () => {
    // Whatever the path-tail says, only valid integers count.
    expect(
      initialUntitledCounter([
        { filePath: "untitled:abc", isUntitled: true, untitledLabel: "Untitled-abc" },
        { filePath: "untitled:2", isUntitled: true, untitledLabel: "Untitled-2" },
      ]),
    ).toBe(2);
  });
});
