import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pinRequest, withPinned } from "../src/lib/pinning.ts";

describe("pinning", () => {
  it("leaves the host out for the hub's own machine, as the web does", () => {
    assert.deepEqual(pinRequest({ repo: "a", name: "x", hostId: "local" }, true), {
      repo: "a",
      name: "x",
      pinned: true,
    });
    assert.deepEqual(pinRequest({ repo: "a", name: "x", hostId: "h-1" }, false), {
      repo: "a",
      name: "x",
      pinned: false,
      hostId: "h-1",
    });
  });

  it("changes only the worktree on that host", () => {
    const repos = [
      {
        name: "a",
        worktrees: [
          { name: "x", pinned: false },
          { name: "x", hostId: "h-1", pinned: false },
        ],
      },
      { name: "b", worktrees: [{ name: "x", pinned: false }] },
    ];
    const next = withPinned(repos, { repo: "a", name: "x", pinned: true });
    assert.deepEqual(
      next.flatMap((r) => r.worktrees.map((w) => w.pinned)),
      [true, false, false],
    );
    const remote = withPinned(repos, { repo: "a", name: "x", pinned: true, hostId: "h-1" });
    assert.deepEqual(
      remote[0]?.worktrees.map((w) => w.pinned),
      [false, true],
    );
  });
});
