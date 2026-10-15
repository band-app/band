import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toWorktreeId, worktreeIdIsOnHost } from "../src/worktree-id.ts";

describe("worktreeIdIsOnHost", () => {
  it("reads a remote host from the id", () => {
    const id = toWorktreeId("proj", "feat/x", "h-0123456789ab");
    assert.equal(worktreeIdIsOnHost(id, "h-0123456789ab"), true);
    assert.equal(worktreeIdIsOnHost(id, "h-ffffffffffff"), false);
  });

  it("is false for the hub's own host, whose ids carry no host", () => {
    const id = toWorktreeId("proj", "main", "local");
    assert.equal(worktreeIdIsOnHost(id, "local"), false);
    assert.equal(worktreeIdIsOnHost(id, "h-0123456789ab"), false);
  });
});
