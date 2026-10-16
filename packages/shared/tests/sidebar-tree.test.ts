import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOriginTree,
  buildPinnedTree,
  entriesOf,
  groupReposByLabel,
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

describe("groupReposByLabel", () => {
  const labels = [
    { id: "l1", name: "Epic", color: "#f00" },
    { id: "l2", name: "Private", color: "#00f" },
  ];
  const list = [
    { name: "a", label: "l2" },
    { name: "b" },
    { name: "c", label: "l1" },
    { name: "d", label: "gone" },
  ];

  it("follows the label order, then unlabeled repos", () => {
    const groups = groupReposByLabel(list, labels);
    assert.deepEqual(
      groups.map((g) => [g.label?.name ?? null, g.repos.map((r) => r.name)]),
      [
        ["Epic", ["c"]],
        ["Private", ["a"]],
        [null, ["b", "d"]],
      ],
    );
  });

  it("keeps one group when no labels exist, and only the filtered label otherwise", () => {
    assert.equal(groupReposByLabel(list, []).length, 1);
    const only = groupReposByLabel(list, labels, "l1");
    assert.deepEqual(
      only.map((g) => g.repos.map((r) => r.name)),
      [["c"]],
    );
  });
});
