import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasUnreadMark, unreadActionLabel, unreadRequest, withUnread } from "../src/lib/unread.ts";

describe("unread", () => {
  it("offers Mark as read for a manual mark and for a finished or failed turn", () => {
    assert.equal(unreadActionLabel({ unread: false, shown: "idle" }), "Mark as unread");
    assert.equal(unreadActionLabel({ unread: false, shown: "working" }), "Mark as unread");
    assert.equal(unreadActionLabel({ unread: true, shown: "idle" }), "Mark as read");
    assert.equal(unreadActionLabel({ unread: false, shown: "done" }), "Mark as read");
    assert.equal(hasUnreadMark({ unread: false, shown: "failed" }), true);
  });

  it("leaves the host out for the hub's own machine", () => {
    assert.deepEqual(unreadRequest({ id: "a-x", hostId: "local" }, true), {
      worktreeId: "a-x",
      unread: true,
    });
    assert.deepEqual(unreadRequest({ id: "a-x@h-1", hostId: "h-1" }, false), {
      worktreeId: "a-x@h-1",
      unread: false,
      hostId: "h-1",
    });
  });

  it("changes only the worktree with that id", () => {
    const repos = [
      {
        name: "a",
        worktrees: [{ name: "x" }, { name: "x", hostId: "h-1" }],
      },
      { name: "b", worktrees: [{ name: "x" }] },
    ];
    const next = withUnread(repos, "a-x@h-1", true);
    assert.deepEqual(
      next.flatMap((r) => r.worktrees.map((w) => (w as { unread?: boolean }).unread ?? false)),
      [false, true, false],
    );
  });
});
