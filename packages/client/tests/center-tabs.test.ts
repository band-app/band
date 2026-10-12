import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  centerTabsKey,
  diffCenterTabs,
  keepHiddenTabs,
  parseCenterTabs,
  withLocalMembership,
} from "../src/center-tabs.ts";

const chat = { id: "c1", kind: "chat" } as const;
const term = { id: "t1", kind: "term" } as const;
const browser = { id: "b1", kind: "browser" } as const;

describe("center tabs", () => {
  it("parses a stored list and drops unknown kinds", () => {
    assert.deepEqual(
      parseCenterTabs({ tabs: [chat, { id: "x", kind: "nope" }, { kind: "chat" }], active: "c1" }),
      { tabs: [chat], active: "c1" },
    );
    assert.equal(parseCenterTabs("junk"), null);
  });

  it("names the client-state key per worktree", () => {
    assert.equal(centerTabsKey("repo-main"), "band:center-tabs:repo-main");
  });

  it("keeps the entries a device does not show, after the entry they followed", () => {
    const shown = (t: { kind: string }) => t.kind !== "browser";
    const merged = keepHiddenTabs(
      { tabs: [chat, term], active: "c1" },
      { tabs: [chat, browser, term], active: "b1" },
      shown,
    );
    assert.deepEqual(merged.tabs, [chat, browser, term]);
  });

  it("applies this device's closed and opened tabs to the shared list", () => {
    const shown = () => true;
    const merged = withLocalMembership(
      { tabs: [chat, term], active: "t1" },
      { tabs: [chat, browser], active: "c1" },
      shown,
    );
    assert.deepEqual(merged.tabs, [chat, browser]);
    assert.equal(merged.active, "c1");
  });

  it("diffs two lists", () => {
    assert.deepEqual(
      diffCenterTabs({ tabs: [chat], active: null }, { tabs: [term], active: null }),
      { added: [term], removed: [chat] },
    );
  });
});
