import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOriginTree,
  buildPinnedTree,
  entriesOf,
  groupEntries,
  originDescendants,
  type SidebarRepo,
  sortRepoWorktrees,
  withoutPinned,
} from "../src/sidebar-tree.ts";

const repos: SidebarRepo[] = [
  {
    name: "alpha",
    defaultBranch: "main",
    worktrees: [
      { name: "main" },
      { name: "b", pinned: true, pinSortIndex: 2 },
      { name: "a", pinned: true, pinSortIndex: 1 },
      { name: "kid", origin: { worktreeId: "alpha-a" } },
      { name: "grandkid", origin: { worktreeId: "alpha-kid" } },
    ],
  },
  { name: "plain", kind: "plain", worktrees: [{ name: "only", pinned: true }] },
];

describe("buildPinnedTree", () => {
  it("orders pins by pinSortIndex and keeps what was started from a pin under it", () => {
    const tree = buildPinnedTree(repos);
    assert.deepEqual(
      tree.pins.map((p) => p.worktreeId),
      ["alpha-a", "alpha-b"],
    );
    assert.deepEqual(
      tree.childrenOf.get("alpha-a")?.map((e) => e.worktreeId),
      ["alpha-kid"],
    );
    assert.deepEqual([...tree.ids].sort(), ["alpha-a", "alpha-b", "alpha-grandkid", "alpha-kid"]);
  });

  it("takes the pinned worktrees and their descendants out of the repo, not plain repos", () => {
    const tree = buildPinnedTree(repos);
    const { repos: rest, reposWithPinned } = withoutPinned(repos, tree);
    assert.deepEqual(
      rest[0]?.worktrees.map((w) => w.name),
      ["main"],
    );
    assert.deepEqual(
      rest[1]?.worktrees.map((w) => w.name),
      ["only"],
    );
    assert.deepEqual([...reposWithPinned], ["alpha"]);
  });
});

describe("buildOriginTree", () => {
  it("nests worktrees without a live origin under the repo's main", () => {
    const tree = buildOriginTree(entriesOf(sortRepoWorktrees(repos)));
    assert.deepEqual(
      tree.roots.map((r) => r.worktreeId),
      ["alpha-main", "plain-only"],
    );
    assert.deepEqual(
      tree.childrenOf.get("alpha-main")?.map((e) => e.worktreeId),
      ["alpha-b", "alpha-a"],
    );
  });
});

describe("buildOriginTree keepAtTop", () => {
  it("leaves a worktree at the top level instead of nesting it under its repo's main", () => {
    const list: SidebarRepo[] = [
      {
        name: "a",
        defaultBranch: "main",
        worktrees: [{ name: "main" }, { name: "x" }, { name: "y" }],
      },
    ];
    const tree = buildOriginTree(entriesOf(list), { keepAtTop: (e) => e.worktree.name === "y" });
    assert.deepEqual(
      tree.roots.map((r) => r.worktreeId),
      ["a-main", "a-y"],
    );
    assert.deepEqual(
      tree.childrenOf.get("a-main")?.map((e) => e.worktreeId),
      ["a-x"],
    );
  });
});

describe("groupEntries", () => {
  const groups = [
    { id: "g1", name: "Epic", color: "#f00" },
    { id: "g2", name: "Private", color: "#00f" },
  ];
  const mixed: SidebarRepo[] = [
    {
      name: "a",
      defaultBranch: "main",
      worktrees: [
        { name: "main", groupId: "g2" },
        { name: "x", groupId: "g1" },
        { name: "y" },
        { name: "z", groupId: "gone" },
      ],
    },
    { name: "b", defaultBranch: "main", worktrees: [{ name: "main", groupId: "g1" }] },
  ];
  const names = (sections: ReturnType<typeof groupEntries>) =>
    sections.map((s) => [s.group?.name ?? null, s.entries.map((e) => e.worktreeId)]);

  it("follows the group order, then ungrouped worktrees, mixing repos in a group", () => {
    assert.deepEqual(names(groupEntries(entriesOf(mixed), groups)), [
      ["Epic", ["a-x", "b-main"]],
      ["Private", ["a-main"]],
      [null, ["a-y", "a-z"]],
    ]);
  });

  it("keeps an empty group, and one section with no groups defined", () => {
    const empty = groupEntries(entriesOf(mixed), [
      ...groups,
      { id: "g3", name: "Idle", color: "#0f0" },
    ]);
    assert.deepEqual(empty[2].entries, []);
    assert.equal(groupEntries(entriesOf(mixed), []).length, 1);
  });

  it("keeps only the filtered group", () => {
    assert.deepEqual(names(groupEntries(entriesOf(mixed), groups, "g1")), [
      ["Epic", ["a-x", "b-main"]],
    ]);
  });

  it("finds the worktrees started from one, to any depth, by origin link", () => {
    const all = entriesOf(repos);
    assert.deepEqual(
      originDescendants(all, "alpha-a").map((e) => e.worktreeId),
      ["alpha-kid", "alpha-grandkid"],
    );
    assert.deepEqual(originDescendants(all, "alpha-main"), []);
  });
});
