import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CenterTab, CenterTabs } from "@band-app/client/center-tabs";

import {
  chatStatuses,
  keepAlive,
  moveChat,
  neighbourOf,
  nextUnread,
  phoneTabs,
  tabState,
  writePhoneTabs,
} from "../src/lib/chat/worktree-tabs.ts";

const shared: CenterTabs = {
  tabs: [
    { id: "c1", kind: "chat" },
    { id: "t1", kind: "term" },
    { id: "c2", kind: "chat" },
    { id: "b1", kind: "browser" },
    { id: "c3", kind: "chat" },
  ],
  active: "c2",
};

const chatTabs = (...ids: string[]): CenterTab[] => ids.map((id) => ({ id, kind: "chat" }));

describe("phone tabs", () => {
  it("shows the chat tabs in the shared order with the shared active tab", () => {
    const view = phoneTabs(shared, ["c3", "c2", "c1"]);
    assert.deepEqual(view.ids, ["c1", "c2", "c3"]);
    assert.equal(view.active, "c2");
    assert.equal(view.hidden, 2);
  });

  it("adds chats the list lacks after the listed ones and skips tabs of unknown chats", () => {
    const view = phoneTabs(shared, ["c1", "c3", "c9"]);
    assert.deepEqual(view.ids, ["c1", "c3", "c9"]);
    assert.equal(view.active, null);
  });

  it("shows terminals among the chats and keeps a terminal active", () => {
    const view = phoneTabs({ ...shared, active: "t1" }, ["c1", "c2", "c3"], ["t1", "t2"]);
    assert.deepEqual(view.ids, ["c1", "t1", "c2", "c3", "t2"]);
    assert.deepEqual(view.tabs[1], { id: "t1", kind: "term" });
    assert.equal(view.active, "t1");
    assert.equal(view.hidden, 1);
  });

  it("skips a terminal the hub doesn't have, and a tab of the wrong kind", () => {
    assert.deepEqual(phoneTabs(shared, ["c1", "c2", "c3"], []).ids, ["c1", "c2", "c3"]);
    assert.deepEqual(phoneTabs(shared, ["t1"], []).ids, ["t1"]);
    assert.equal(phoneTabs({ ...shared, active: "t1" }, ["c1"]).active, null);
    const none = phoneTabs(null, ["a"]);
    assert.deepEqual([none.ids, none.active, none.hidden], [["a"], null, 0]);
  });

  it("closing a chat keeps the terminal and browser tabs where they were", () => {
    const next = writePhoneTabs(shared, ["c1", "c2", "c3"], chatTabs("c1", "c3"), "c3");
    assert.deepEqual(next, {
      tabs: [
        { id: "c1", kind: "chat" },
        { id: "t1", kind: "term" },
        { id: "b1", kind: "browser" },
        { id: "c3", kind: "chat" },
      ],
      active: "c3",
    });
  });

  it("a terminal tab the phone shows is written back, one it didn't show stays", () => {
    const withTerms: CenterTabs = {
      tabs: [...shared.tabs, { id: "t2", kind: "term" }],
      active: "c1",
    };
    const next = writePhoneTabs(
      withTerms,
      ["c1", "c2", "c3", "t1"],
      [
        { id: "t1", kind: "term" },
        { id: "c1", kind: "chat" },
        { id: "c2", kind: "chat" },
        { id: "c3", kind: "chat" },
      ],
      "t1",
    );
    assert.deepEqual(
      next.tabs.map((t) => t.id),
      ["t1", "c1", "c2", "b1", "c3", "t2"],
    );
    assert.equal(next.active, "t1");
  });

  it("keeps a chat tab the phone didn't show yet", () => {
    // c3 is a chat the phone doesn't know yet: it stays, after the tab it followed (b1).
    const next = writePhoneTabs(shared, ["c1", "c2"], chatTabs("c2", "c1"), "c1");
    assert.deepEqual(
      next.tabs.map((t) => t.id),
      ["c2", "b1", "c3", "c1", "t1"],
    );
  });

  it("adds a new chat at the end and makes it active", () => {
    const next = writePhoneTabs(shared, ["c1", "c2", "c3"], chatTabs("c1", "c2", "c3", "c4"), "c4");
    assert.deepEqual(next.tabs.at(-1), { id: "c4", kind: "chat" });
    assert.equal(next.active, "c4");
    assert.equal(next.tabs.length, 6);
  });

  it("picks the next tab after a close, else the previous one", () => {
    assert.equal(neighbourOf(["a", "b", "c"], "b"), "c");
    assert.equal(neighbourOf(["a", "b", "c"], "c"), "b");
    assert.equal(neighbourOf(["a"], "a"), null);
  });

  it("moves a tab and clamps at the ends", () => {
    assert.deepEqual(moveChat(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
    assert.deepEqual(moveChat(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
    assert.deepEqual(moveChat(["a", "b", "c"], "c", -2), ["c", "a", "b"]);
  });
});

describe("tab state", () => {
  const statuses = chatStatuses([
    { chatId: "a", status: "working" },
    { chatId: "b", status: "question" },
    { status: "working" },
  ]);

  it("reads each chat's status and skips a status with no chat (a terminal's)", () => {
    assert.deepEqual(
      [...statuses],
      [
        ["a", "working"],
        ["b", "question"],
      ],
    );
    assert.equal(tabState("a", statuses, new Set()), "running");
    assert.equal(tabState("b", statuses, new Set(["b"])), "attention");
    assert.equal(tabState("c", statuses, new Set(["c"])), "unread");
    assert.equal(tabState("c", statuses, new Set()), "idle");
  });

  it("marks a background chat unread when its turn ends, and clears it when shown", () => {
    const after = chatStatuses([]);
    const unread = nextUnread(new Set(), statuses, after, "x");
    assert.deepEqual([...unread], ["a"]);
    assert.deepEqual([...nextUnread(unread, after, after, "a")], []);
    assert.deepEqual([...nextUnread(new Set(), statuses, after, "a")], []);
  });

  it("returns the same set when nothing became unread", () => {
    const unread = new Set(["a"]);
    const idle = new Map([["a", "idle"]]);
    assert.equal(nextUnread(unread, idle, idle, "b"), unread);
  });
});

describe("keep alive", () => {
  it("keeps the shown chat and the most recent ones that still exist", () => {
    const exists = (id: string) => id !== "gone";
    assert.deepEqual(keepAlive(["b", "gone", "c", "d"], "a", exists, 3), ["a", "b", "c"]);
    assert.deepEqual(keepAlive(["a", "b"], "a", exists, 3), ["a", "b"]);
  });
});
