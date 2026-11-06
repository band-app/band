import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MERGE_METHODS,
  mergeMethodLabel,
  mergeStatus,
  queueBadgeLabel,
  queueEstimate,
  queueLine,
  relativeTime,
} from "../src/merge.ts";

const open = (mergeState: string) => mergeStatus({ state: "open", mergeState });

describe("mergeStatus", () => {
  it("lets a clean pull request merge with no hint", () => {
    assert.deepEqual(open("clean"), { label: "Squash and merge", canMerge: true, hint: "" });
    assert.equal(open("has_hooks").canMerge, true);
  });

  it("lets an unstable one merge with a hint", () => {
    const s = open("unstable");
    assert.equal(s.canMerge, true);
    assert.equal(s.hint, "Some checks that are not required are failing.");
  });

  it("disables the button for blocked, behind, dirty and draft with the web's text", () => {
    assert.deepEqual(open("blocked"), {
      label: "Blocked",
      canMerge: false,
      hint: "Required reviews or checks are missing.",
    });
    assert.deepEqual(open("behind"), {
      label: "Behind base",
      canMerge: false,
      hint: "The branch is out of date.",
    });
    assert.deepEqual(open("dirty"), {
      label: "Conflicts",
      canMerge: false,
      hint: "The branch has merge conflicts.",
    });
    assert.deepEqual(open("draft"), {
      label: "Draft",
      canMerge: false,
      hint: "Mark the PR ready for review first.",
    });
  });

  it("shows Merged and Closed whatever the merge state says", () => {
    assert.equal(mergeStatus({ state: "merged", mergeState: "clean" }).label, "Merged");
    assert.equal(mergeStatus({ state: "closed", mergeState: "clean" }).canMerge, false);
  });

  it("waits on an unknown merge state", () => {
    assert.deepEqual(open("unknown"), {
      label: "Checking mergeability",
      canMerge: false,
      hint: "",
    });
  });
});

describe("merge methods", () => {
  it("lists squash first, then merge, then rebase", () => {
    assert.deepEqual(
      MERGE_METHODS.map((m) => m.label),
      ["Squash and merge", "Create a merge commit", "Rebase and merge"],
    );
    assert.equal(mergeMethodLabel("rebase"), "Rebase and merge");
  });
});

describe("relativeTime", () => {
  it("counts back from now", () => {
    const now = Date.parse("2026-01-02T10:00:00Z");
    assert.equal(relativeTime("2026-01-02T09:57:00Z", now), "3 minutes ago");
    assert.equal(relativeTime("2026-01-01T10:00:00Z", now), "yesterday");
    assert.equal(relativeTime("2026-01-02T09:59:59Z", now), "1 second ago");
    assert.equal(relativeTime("2026-01-02T08:00:00Z", now), "2 hours ago");
    assert.equal(relativeTime("2025-11-02T10:00:00Z", now), "2 months ago");
    assert.equal(relativeTime("2024-01-02T10:00:00Z", now), "2 years ago");
    assert.equal(relativeTime("2026-01-02T10:00:00Z", now), "now");
    assert.equal(relativeTime("not a date", now), "not a date");
  });
});

describe("merge queue", () => {
  const queue = {
    state: "awaiting_checks" as const,
    position: 2,
    total: 3,
    estimatedTimeToMerge: 300,
  };

  it("words the entry like the web's Checks panel", () => {
    assert.equal(queueLine(queue), "In merge queue, position 2 of 3 (awaiting checks)");
    assert.equal(
      queueLine({ state: "queued", position: 1 }),
      "In merge queue, position 1 (queued)",
    );
    assert.equal(queueBadgeLabel(queue), "In merge queue · position 2");
  });

  it("formats the estimate", () => {
    assert.equal(queueEstimate(300), "about 5 min");
    assert.equal(queueEstimate(30), "less than a minute");
    assert.equal(queueEstimate(5400), "about 1 h 30 min");
    assert.equal(queueEstimate(null), null);
    assert.equal(queueEstimate(0), null);
  });

  it("offers no merge for a queued PR and still does for an open clean one", () => {
    const queued = mergeStatus({ state: "open", mergeState: "clean", mergeQueue: queue });
    assert.equal(queued.canMerge, false);
    assert.equal(queued.queued, true);
    assert.equal(queued.label, "In merge queue");
    const open = mergeStatus({ state: "open", mergeState: "clean" });
    assert.equal(open.canMerge, true);
    assert.equal(open.queued, undefined);
  });
});
