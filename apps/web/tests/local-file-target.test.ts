import { describe, expect, it } from "vitest";
import { planLocalFileOpen } from "../src/dashboard/lib/local-file-target";

const worktrees = [
  { id: "alpha-main", path: "/work/alpha", hostId: "local" },
  { id: "alpha-feat@h-mac", path: "/work/alpha/.worktrees/feat", hostId: "h-mac" },
  { id: "beta-main@h-vps", path: "/work/beta", hostId: "h-vps" },
];

describe("planLocalFileOpen", () => {
  it("opens a file inside a worktree on this Mac as a normal tab in that worktree", () => {
    expect(
      planLocalFileOpen("/work/alpha/src/a.ts", worktrees, ["local"], "beta-main@h-vps"),
    ).toEqual({ kind: "worktree", worktreeId: "alpha-main", relPath: "src/a.ts" });
  });

  it("picks the deepest worktree when worktrees are nested", () => {
    expect(
      planLocalFileOpen("/work/alpha/.worktrees/feat/x.ts", worktrees, ["local", "h-mac"], null),
    ).toEqual({ kind: "worktree", worktreeId: "alpha-feat@h-mac", relPath: "x.ts" });
  });

  it("ignores a worktree whose worker is on another machine, even at the same path", () => {
    expect(planLocalFileOpen("/work/beta/b.ts", worktrees, ["local"], "alpha-main")).toEqual({
      kind: "external",
      worktreeId: "alpha-main",
    });
  });

  it("opens a file outside every worktree as an external tab in the current worktree", () => {
    expect(planLocalFileOpen("/etc/hosts", worktrees, ["local"], "alpha-main")).toEqual({
      kind: "external",
      worktreeId: "alpha-main",
    });
  });

  it("does not treat a sibling folder with a shared prefix as inside the worktree", () => {
    expect(planLocalFileOpen("/work/alpha-other/a.ts", worktrees, ["local"], "alpha-main")).toEqual(
      { kind: "external", worktreeId: "alpha-main" },
    );
  });

  it("has nowhere to open an outside file when no worktree is open", () => {
    expect(planLocalFileOpen("/etc/hosts", worktrees, ["local"], null).kind).toBe("none");
  });

  it("opens nothing in a worktree when this machine runs no worker", () => {
    expect(planLocalFileOpen("/work/alpha/a.ts", worktrees, [], "beta-main@h-vps").kind).toBe(
      "external",
    );
  });
});

describe("planLocalFileOpen for a folder (band://file/<folder>)", () => {
  it("selects the worktree for its root", () => {
    expect(planLocalFileOpen("/work/alpha", worktrees, ["local"], null, true)).toEqual({
      kind: "select",
      worktreeId: "alpha-main",
    });
  });

  it("selects the longest matching nested worktree", () => {
    expect(
      planLocalFileOpen(
        "/work/alpha/.worktrees/feat/src",
        worktrees,
        ["local", "h-mac"],
        null,
        true,
      ),
    ).toEqual({ kind: "select", worktreeId: "alpha-feat@h-mac" });
  });

  it("reports a folder outside every worktree", () => {
    expect(planLocalFileOpen("/etc", worktrees, ["local"], "alpha-main", true)).toEqual({
      kind: "outside",
      message: "Not in a Band worktree: /etc",
    });
  });
});
