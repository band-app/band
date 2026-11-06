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

  describe("reordering in the gap", () => {
    const list = entriesOf([
      {
        name: "app",
        defaultBranch: "main",
        kind: "git",
        worktrees: [
          { name: "a", hostId: "a", groupId: "g1", sortIndex: 0 },
          { name: "b", hostId: "a", groupId: "g1", sortIndex: 1 },
          { name: "c", hostId: "a", groupId: "g1", sortIndex: 2 },
          { name: "p", hostId: "a", groupId: "g1", sortIndex: 3 },
          {
            name: "k1",
            hostId: "a",
            groupId: "g1",
            origin: { worktreeId: "app-p@a" },
            sortIndex: 0,
          },
          {
            name: "k2",
            hostId: "a",
            groupId: "g1",
            origin: { worktreeId: "app-p@a" },
            sortIndex: 1,
          },
          { name: "x", hostId: "a", groupId: "g2", sortIndex: 0 },
        ],
      },
    ] as unknown as RepoInfo[]);
    const names = (plan: ReturnType<typeof planParentDrop>) =>
      plan.type === "reorder" || plan.type === "parent"
        ? (plan.order ?? []).map((r) => r.name)
        : [];

    it("puts a top-level row above another in the same group", () => {
      const plan = planParentDrop(list, "app-c@a", "app-a@a", "before");
      expect(plan).toMatchObject({ type: "reorder", scope: "siblings" });
      expect(names(plan)).toEqual(["c", "a", "b", "p"]);
    });

    it("swaps two children of one parent and keeps the parent", () => {
      const plan = planParentDrop(list, "app-k2@a", "app-k1@a", "before");
      expect(plan).toMatchObject({ type: "reorder", scope: "siblings" });
      expect((plan as { reparent?: unknown }).reparent).toBeUndefined();
      expect(names(plan)).toEqual(["k2", "k1"]);
    });

    it("changes nothing when the row is already there", () => {
      expect(planParentDrop(list, "app-a@a", "app-b@a", "before").type).toBe("none");
    });

    it("reparents and orders in one reorder when only the parent changes", () => {
      const plan = planParentDrop(list, "app-c@a", "app-k1@a", "after");
      expect(plan).toMatchObject({
        type: "reorder",
        reparent: { name: "c", origin: "app-p@a" },
      });
      expect(names(plan)).toEqual(["k1", "c", "k2"]);
    });

    it("carries the order along when the group changes too", () => {
      const plan = planParentDrop(list, "app-x@a", "app-b@a", "after");
      expect(plan).toMatchObject({ type: "parent", origin: null, groupId: "g1" });
      expect(names(plan)).toEqual(["a", "b", "x", "c", "p"]);
    });
  });
});
