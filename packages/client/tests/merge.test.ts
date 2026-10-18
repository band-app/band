import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MERGE_METHODS, mergeMethodLabel, mergeStatus, relativeTime } from "../src/merge.ts";

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
  });
});
