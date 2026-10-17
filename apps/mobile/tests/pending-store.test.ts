import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getPending,
  pendingVersion,
  setPending,
  subscribePending,
} from "../src/lib/chat/pending-store.ts";

describe("pending store", () => {
  it("stores a text and bumps the version once for a repeated write", () => {
    const v = pendingVersion();
    setPending("c1", "Run pnpm test");
    setPending("c1", "Run pnpm test");
    assert.equal(getPending("c1"), "Run pnpm test");
    assert.equal(pendingVersion(), v + 1);
  });

  it("ignores clearing a chat it does not hold, and bumps on a real clear", () => {
    const v = pendingVersion();
    setPending("unknown", null);
    assert.equal(pendingVersion(), v);
    setPending("c1", null);
    assert.equal(getPending("c1"), undefined);
    assert.equal(pendingVersion(), v + 1);
  });

  it("notifies listeners until they unsubscribe", () => {
    let calls = 0;
    const off = subscribePending(() => {
      calls++;
    });
    setPending("c2", "a");
    off();
    setPending("c2", "b");
    assert.equal(calls, 1);
    setPending("c2", null);
  });
});
