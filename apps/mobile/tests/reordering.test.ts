import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dropIndex,
  groupOrder,
  moveItem,
  type OrderRow,
  reorderFailure,
  reorderRequest,
  shiftFor,
  siblingBlocks,
  withGroupOrder,
  withOrder,
} from "../src/lib/reordering.ts";

const row = (
  name: string,
  depth = 0,
  parentId: string | null = null,
  hostId = "local",
): OrderRow => ({
  id: name,
  repo: "r",
  name,
  hostId,
  depth,
  parentId,
});

describe("moveItem", () => {
  it("moves one item and keeps the rest in order", () => {
    assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
  });
});

describe("siblingBlocks", () => {
  const rows = [
    row("a"),
    row("a1", 1, "a"),
    row("a1x", 2, "a1"),
    row("a2", 1, "a"),
    row("b"),
    row("b1", 1, "b"),
  ];

  it("lists the top level with each worktree's descendants in its block", () => {
    const found = siblingBlocks(rows, "b");
    assert.deepEqual(
      found?.blocks.map((b) => b.rowIds),
      [
        ["a", "a1", "a1x", "a2"],
        ["b", "b1"],
      ],
    );
    assert.equal(found?.index, 1);
  });

  it("limits a child to the children of its own parent", () => {
    const found = siblingBlocks(rows, "a2");
    assert.deepEqual(
      found?.blocks.map((b) => b.id),
      ["a1", "a2"],
    );
    assert.equal(found?.index, 1);
    assert.deepEqual(
      siblingBlocks(rows, "a1")?.blocks.map((b) => b.rowIds),
      [["a1", "a1x"], ["a2"]],
    );
  });

  it("returns null for an unknown row", () => {
    assert.equal(siblingBlocks(rows, "zz"), null);
  });
});

describe("reorderRequest", () => {
  it("S1: dragging C above A in a flat list gives C, A, B", () => {
    const rows = [row("A"), row("B"), row("C")];
    assert.deepEqual(reorderRequest(rows, "C", 0, false), {
      scope: "siblings",
      order: [
        { repo: "r", name: "C" },
        { repo: "r", name: "A" },
        { repo: "r", name: "B" },
      ],
    });
  });

  it("S3: the top level of the Pinned section uses the pins scope", () => {
    const rows = [row("A"), row("B"), row("C")];
    assert.equal(reorderRequest(rows, "A", 2, true)?.scope, "pins");
    assert.deepEqual(
      reorderRequest(rows, "A", 2, true)?.order.map((o) => o.name),
      ["B", "C", "A"],
    );
  });

  it("uses siblings for a child inside the Pinned section, ordering only its siblings", () => {
    const rows = [row("A"), row("A1", 1, "A"), row("A2", 1, "A"), row("B")];
    const request = reorderRequest(rows, "A2", 0, true);
    assert.equal(request?.scope, "siblings");
    assert.deepEqual(
      request?.order.map((o) => o.name),
      ["A2", "A1"],
    );
  });

  it("orders only the top-level siblings when the moved worktree has children", () => {
    const rows = [row("A"), row("A1", 1, "A"), row("B")];
    for (const pinned of [false, true]) {
      const request = reorderRequest(rows, "A", 1, pinned);
      assert.equal(request?.scope, pinned ? "pins" : "siblings");
      assert.deepEqual(
        request?.order.map((o) => o.name),
        ["B", "A"],
      );
    }
  });

  it("does not list the children of another parent as siblings", () => {
    const rows = [
      row("A"),
      row("A1", 1, "A"),
      row("A2", 1, "A"),
      row("B"),
      row("B1", 1, "B"),
      row("B2", 1, "B"),
    ];
    assert.deepEqual(
      reorderRequest(rows, "B2", 0, false)?.order.map((o) => o.name),
      ["B2", "B1"],
    );
  });

  it("names the host of a worktree on another worker and leaves it out for the hub", () => {
    const request = reorderRequest(
      [
        { ...row("A"), id: "r-A" },
        { ...row("A", 0, null, "h-1"), id: "r-A@h-1" },
      ],
      "r-A@h-1",
      0,
      false,
    );
    assert.deepEqual(request?.order, [
      { repo: "r", name: "A", hostId: "h-1" },
      { repo: "r", name: "A" },
    ]);
  });

  it("returns null when nothing moves or there is nobody to order against", () => {
    assert.equal(reorderRequest([row("A"), row("B")], "A", 0, false), null);
    assert.equal(reorderRequest([row("A")], "A", 0, false), null);
  });
});

describe("withOrder", () => {
  it("stores the positions in the field of the scope and leaves other worktrees alone", () => {
    const repos = [{ name: "r", worktrees: [{ name: "A" }, { name: "B" }, { name: "C" }] }];
    const next = withOrder(repos, {
      scope: "siblings",
      order: [
        { repo: "r", name: "C" },
        { repo: "r", name: "A" },
      ],
    });
    assert.deepEqual(next[0]?.worktrees, [
      { name: "A", sortIndex: 1 },
      { name: "B" },
      { name: "C", sortIndex: 0 },
    ]);
    const pins = withOrder(repos, { scope: "pins", order: [{ repo: "r", name: "B" }] });
    assert.deepEqual(pins[0]?.worktrees[1], { name: "B", pinSortIndex: 0 });
  });
});

describe("optimistic updates keep the cached list intact (rollback relies on it)", () => {
  it("withOrder and withGroupOrder return new lists and leave their input unchanged", () => {
    const repos = Object.freeze([
      Object.freeze({
        name: "r",
        worktrees: Object.freeze([Object.freeze({ name: "A" }), Object.freeze({ name: "B" })]),
      }),
    ]) as unknown as { name: string; worktrees: { name: string }[] }[];
    const before = JSON.stringify(repos);
    const next = withOrder(repos, { scope: "pins", order: [{ repo: "r", name: "B" }] });
    assert.notEqual(next, repos);
    assert.equal(JSON.stringify(repos), before);

    const groups = Object.freeze([Object.freeze({ id: "g1" }), Object.freeze({ id: "g2" })]);
    const reordered = withGroupOrder([...groups], ["g2", "g1"]);
    assert.deepEqual(
      reordered.map((g) => g.id),
      ["g2", "g1"],
    );
    assert.deepEqual(
      groups.map((g) => g.id),
      ["g1", "g2"],
    );
  });
});

describe("withOrder on two workers", () => {
  it("sets the index only on the worktree of the named worker", () => {
    const repos = [{ name: "r", worktrees: [{ name: "A" }, { name: "A", hostId: "h-1" }] }];
    const next = withOrder(repos, {
      scope: "siblings",
      order: [{ repo: "r", name: "A", hostId: "h-1" }],
    });
    assert.deepEqual(next[0]?.worktrees, [
      { name: "A" },
      { name: "A", hostId: "h-1", sortIndex: 0 },
    ]);
  });
});

describe("dropIndex and shiftFor", () => {
  const heights = [50, 50, 50];

  it("stays put for a small drag and moves once the middle passes a neighbour's middle", () => {
    assert.equal(dropIndex(heights, 2, -10), 2);
    assert.equal(dropIndex(heights, 2, -60), 1);
    assert.equal(dropIndex(heights, 2, -110), 0);
    assert.equal(dropIndex(heights, 0, 60), 1);
    assert.equal(dropIndex(heights, 0, 500), 2);
    assert.equal(dropIndex(heights, 2, -500), 0);
  });

  it("works with blocks of different heights", () => {
    assert.equal(dropIndex([100, 40, 40], 0, 80), 1);
    assert.equal(dropIndex([100, 40, 40], 0, 120), 2);
  });

  it("shifts the blocks the held one passes by its height", () => {
    assert.deepEqual(
      [0, 1, 2].map((i) => shiftFor([30, 40, 50], 2, 0, i)),
      [50, 50, 0],
    );
    assert.deepEqual(
      [0, 1, 2].map((i) => shiftFor([30, 40, 50], 0, 2, i)),
      [0, -30, -30],
    );
    assert.deepEqual(
      [0, 1, 2].map((i) => shiftFor([30, 40, 50], 1, 1, i)),
      [0, 0, 0],
    );
  });
});

describe("group order", () => {
  it("S4: moving G3 above G1 gives G3, G1, G2", () => {
    assert.deepEqual(groupOrder(["G1", "G2", "G3"], ["G1", "G2", "G3"], 2, 0), ["G3", "G1", "G2"]);
  });

  it("keeps a group the filter hides in its place", () => {
    assert.deepEqual(groupOrder(["G1", "X", "G2", "G3"], ["G1", "G2", "G3"], 2, 0), [
      "G3",
      "X",
      "G1",
      "G2",
    ]);
  });

  it("returns null when the group stays", () => {
    assert.equal(groupOrder(["G1", "G2"], ["G1", "G2"], 1, 1), null);
  });

  it("sorts the groups of repos.list by the new ids", () => {
    const groups = [{ id: "G1" }, { id: "G2" }, { id: "G3" }];
    assert.deepEqual(
      withGroupOrder(groups, ["G3", "G1", "G2"]).map((g) => g.id),
      ["G3", "G1", "G2"],
    );
  });
});

describe("nested lists and purity", () => {
  const rows = [row("A"), row("A1", 1, "A"), row("A2", 1, "A"), row("B"), row("B1", 1, "B")];

  it("moving a top-level worktree with children orders only the top level", () => {
    assert.deepEqual(
      reorderRequest(rows, "A", 1, false)?.order.map((o) => o.name),
      ["B", "A"],
    );
    assert.deepEqual(
      reorderRequest(rows, "A", 1, true)?.order.map((o) => o.name),
      ["B", "A"],
    );
    assert.equal(reorderRequest(rows, "A", 1, true)?.scope, "pins");
  });

  it("a child never lists another parent's children as siblings", () => {
    assert.equal(reorderRequest(rows, "B1", 0, false), null);
    assert.deepEqual(
      reorderRequest(rows, "A2", 0, false)?.order.map((o) => o.name),
      ["A2", "A1"],
    );
  });

  it("withOrder and withGroupOrder leave their input untouched, so a rollback can reuse it", () => {
    const repos = [{ name: "r", worktrees: [{ name: "A" }, { name: "B" }] }];
    const before = JSON.stringify(repos);
    const next = withOrder(repos, {
      scope: "siblings",
      order: [
        { repo: "r", name: "B" },
        { repo: "r", name: "A" },
      ],
    });
    assert.notEqual(next[0], repos[0]);
    assert.equal(JSON.stringify(repos), before);
    const groups = Object.freeze([{ id: "G1" }, { id: "G2" }]);
    assert.deepEqual(
      withGroupOrder([...groups], ["G2", "G1"]).map((g) => g.id),
      ["G2", "G1"],
    );
    assert.deepEqual(groups, [{ id: "G1" }, { id: "G2" }]);
  });
});

describe("failure", () => {
  it("S5 alert: the message says the old order is back (the rollback itself is in useReorderWorktrees, manual)", () => {
    const failure = reorderFailure(new Error("Forbidden"));
    assert.equal(failure.title, "Could not save the new order");
    assert.match(failure.message, /Forbidden/);
    assert.match(failure.message, /old order/);
  });
});
