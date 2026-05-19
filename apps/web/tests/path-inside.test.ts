/**
 * Tests for `pathInside` — the segment-aware containment helper used
 * by the untitled save flow to decide whether a chosen save path
 * lives inside the workspace or should be treated as external.
 *
 * Security-adjacent: a wrong answer routes the save through the
 * wrong adapter (workspace vs external) AND strips the workspace
 * prefix off a path that isn't actually inside it, producing an
 * invalid workspace-relative filename. The `/a/band` vs `/a/band-fork`
 * case is the canonical regression to guard against; the rest are
 * boundary conditions a future change to the helper could plausibly
 * break.
 */

import { describe, expect, it } from "vitest";
import { pathInside } from "../src/lib/path-inside";

describe("pathInside", () => {
  it("returns empty string when child equals parent", () => {
    expect(pathInside("/a/band", "/a/band")).toBe("");
  });

  it("returns the relative segment when child is inside parent", () => {
    expect(pathInside("/a/band", "/a/band/src/main.ts")).toBe("src/main.ts");
    expect(pathInside("/a/band", "/a/band/README.md")).toBe("README.md");
    expect(pathInside("/a/band", "/a/band/deeply/nested/file.ts")).toBe("deeply/nested/file.ts");
  });

  it("returns null for a same-prefix sibling (prefix-collision case)", () => {
    // The canonical regression: `/a/band-fork` is NOT inside `/a/band`
    // even though their path strings share a prefix. The required
    // trailing `/` after the parent blocks the false positive.
    expect(pathInside("/a/band", "/a/band-fork/src/main.ts")).toBeNull();
    expect(pathInside("/a/band", "/a/band-fork")).toBeNull();
    expect(pathInside("/a/band", "/a/bandage/file.ts")).toBeNull();
  });

  it("returns null for a completely unrelated path", () => {
    expect(pathInside("/a/band", "/etc/passwd")).toBeNull();
    expect(pathInside("/a/band", "/Users/alice/other/file.ts")).toBeNull();
  });

  it("normalises trailing slashes on the parent path", () => {
    // The OS save dialog may or may not return a directory with a
    // trailing slash, and workspace registry paths historically have
    // varied. The helper must normalise so the prefix check fires
    // consistently regardless of trailing-slash state.
    expect(pathInside("/a/band/", "/a/band/src/main.ts")).toBe("src/main.ts");
    expect(pathInside("/a/band///", "/a/band/src/main.ts")).toBe("src/main.ts");
    expect(pathInside("/a/band/", "/a/band")).toBe("");
  });

  it("does not normalise trailing slashes on the child path", () => {
    // We deliberately do NOT strip the child's trailing slash — the
    // save dialog returns canonical file paths without trailing
    // slashes, and quietly accepting one would mask a malformed input.
    // This documents the current behaviour rather than asserting
    // correctness; if a future change wants to be more permissive
    // it should be explicit.
    expect(pathInside("/a/band", "/a/band/src/")).toBe("src/");
  });

  it("returns null when the parent is empty", () => {
    // Defensive: an empty workspace root should never resolve any
    // child as "inside" it.
    expect(pathInside("", "/anything")).toBeNull();
  });
});
