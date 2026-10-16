import { describe, expect, it } from "vitest";
import { moveRefusal } from "../src/dashboard/lib/sidebar-drop";
import type { WorktreeEntry } from "../src/dashboard/lib/sidebar-grouping";
import type { RepoInfo, WorktreeInfo } from "../src/dashboard/types";

// Pure functions with no state to fake: the rules that decide whether a worktree dropped on a host
// may open the "Open on another host" dialog.

const hosts = [
  { id: "a", name: "box-a", status: "online" },
  { id: "b", name: "box-b", status: "online" },
  { id: "off", name: "box-off", status: "offline" },
];

function entry(worktree: Partial<WorktreeInfo>, repo: Partial<RepoInfo> = {}): WorktreeEntry {
  return {
    worktreeId: "app-feat@a",
    repo: { name: "app", defaultBranch: "main", kind: "git", ...repo } as RepoInfo,
    worktree: { name: "feat", hostId: "a", pinned: false, ...worktree } as WorktreeInfo,
  };
}

describe("moveRefusal", () => {
  it("allows a worktree on an online worker to go to another online worker", () => {
    expect(moveRefusal(entry({}), "b", { hosts, isAdmin: false })).toBeNull();
  });

  it("allows the default branch while its host is up", () => {
    expect(moveRefusal(entry({ name: "main" }), "b", { hosts, isAdmin: true })).toBeNull();
  });

  it("refuses a worktree on the hub's own machine and a drop onto it", () => {
    expect(moveRefusal(entry({ hostId: "local" }), "b", { hosts, isAdmin: true })).toContain("hub");
    expect(moveRefusal(entry({}), "local", { hosts, isAdmin: true })).toContain("hub");
  });

  it("refuses a repo limited to this host with the card's wording", () => {
    expect(moveRefusal(entry({}, { allowedHostIds: ["a"] }), "b", { hosts, isAdmin: true })).toBe(
      "Only available on box-a",
    );
  });

  it("refuses a host the repo isn't allowed on unless the caller is an admin", () => {
    const limited = entry({}, { allowedHostIds: ["a", "c"] });
    expect(moveRefusal(limited, "b", { hosts, isAdmin: false })).toContain("needs an admin");
    expect(moveRefusal(limited, "b", { hosts, isAdmin: true })).toBeNull();
  });

  it("refuses an offline target", () => {
    expect(moveRefusal(entry({}), "off", { hosts, isAdmin: true })).toContain("offline");
  });
});
