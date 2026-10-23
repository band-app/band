import { describe, expect, it } from "vitest";
import { planParentDrop } from "../src/dashboard/lib/sidebar-drop";
import { entriesOf } from "../src/dashboard/lib/sidebar-grouping";
import type { RepoInfo } from "../src/dashboard/types";

// Pure functions with no state to fake: the rules that decide where a worktree dropped on another
// worktree goes, and which drops are refused.

describe("planParentDrop", () => {
  const repos = [
    {
      name: "app",
      defaultBranch: "main",
      kind: "git",
      worktrees: [
        { name: "a", hostId: "a", groupId: "g1" },
        {
          name: "child",
          hostId: "a",
          groupId: "g1",
          origin: { worktreeId: "app-a@a" },
        },
        {
          name: "grandchild",
          hostId: "a",
          groupId: "g1",
          origin: { worktreeId: "app-child@a" },
        },
        { name: "b", hostId: "a", groupId: "g2" },
      ],
    },
  ] as unknown as RepoInfo[];
  const entries = entriesOf(repos);

  it("makes the dragged worktree a child of the one it lands on, in that worktree's group", () => {
    const plan = planParentDrop(entries, "app-a@a", "app-b@a", "into");
    expect(plan).toMatchObject({ type: "parent", origin: "app-b@a", groupId: "g2" });
  });

  it("refuses a drop onto itself", () => {
    expect(planParentDrop(entries, "app-a@a", "app-a@a", "into").type).toBe("refuse");
  });

  it("refuses a drop onto a descendant", () => {
    expect(planParentDrop(entries, "app-a@a", "app-grandchild@a", "into").type).toBe("refuse");
  });

  it("clears the parent in the gap beside a top-level row", () => {
    const plan = planParentDrop(entries, "app-child@a", "app-b@a", "before");
    expect(plan).toMatchObject({ type: "parent", origin: null, groupId: "g2" });
  });

  it("makes the dragged worktree a sibling in the gap beside a nested row", () => {
    const plan = planParentDrop(entries, "app-b@a", "app-child@a", "after");
    expect(plan).toMatchObject({ type: "parent", origin: "app-a@a", groupId: "g1" });
  });

  it("changes nothing when the parent and group already match", () => {
    expect(planParentDrop(entries, "app-child@a", "app-a@a", "into").type).toBe("none");
  });
});
