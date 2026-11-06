import { describe, expect, it } from "vitest";
import { findWorktreeForPath, parseLocalFileInput } from "../src/dashboard/lib/html-preview";

describe("parseLocalFileInput", () => {
  it("reads the three-slash form with a fragment", () => {
    expect(parseLocalFileInput("file:///Users/a/deck.html#3")).toEqual({
      path: "/Users/a/deck.html",
      search: "",
      hash: "3",
    });
  });
  it("reads the two-slash typo form", () => {
    expect(parseLocalFileInput("file://Users/a/deck.html#3")?.path).toBe("/Users/a/deck.html");
  });
  it("reads file://localhost/", () => {
    expect(parseLocalFileInput("file://localhost/Users/a/x.html")?.path).toBe("/Users/a/x.html");
  });
  it("reads a bare absolute path and keeps the query", () => {
    expect(parseLocalFileInput("/Users/a/x.html?v=1#top")).toEqual({
      path: "/Users/a/x.html",
      search: "v=1",
      hash: "top",
    });
  });
  it("decodes spaces and non-ASCII characters", () => {
    expect(parseLocalFileInput("file:///Users/a/My%20Deck%20%C3%BC.html")?.path).toBe(
      "/Users/a/My Deck ü.html",
    );
  });
  it("ignores ordinary input", () => {
    expect(parseLocalFileInput("example.com")).toBeNull();
    expect(parseLocalFileInput("some words")).toBeNull();
    expect(parseLocalFileInput("https://example.com/a")).toBeNull();
    expect(parseLocalFileInput("//cdn.example.com/x")).toBeNull();
  });
  it("refuses dot-dot segments", () => {
    expect(parseLocalFileInput("file:///a/../etc/hosts")).toBeNull();
  });
});

describe("findWorktreeForPath", () => {
  const worktrees = [
    { id: "r-main", path: "/w/r" },
    { id: "r-nested", path: "/w/r/nested" },
    { id: "r-main@h-1", path: "/w/r", hostId: "h-1" },
  ];
  it("picks the longest containing worktree on the worker", () => {
    expect(findWorktreeForPath("/w/r/nested/a.html", "local", worktrees)).toMatchObject({
      worktree: { id: "r-nested" },
      relPath: "a.html",
    });
  });
  it("only considers the given worker", () => {
    expect(findWorktreeForPath("/w/r/a.html", "h-1", worktrees)?.worktree.id).toBe("r-main@h-1");
  });
  it("returns null outside every worktree", () => {
    expect(findWorktreeForPath("/etc/hosts", "local", worktrees)).toBeNull();
  });
});
