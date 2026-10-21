import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostDisplay, worktreeDisplay } from "../src/worktree-display.ts";

const hosts = [
  { id: "local", name: null },
  { id: "h-2e22f90bef5f", name: "mac" },
];
const repos = [
  {
    name: "borko",
    worktrees: [
      { name: "main", hostId: "h-2e22f90bef5f" },
      { name: "dev", hostId: "local" },
    ],
  },
];

describe("worktreeDisplay", () => {
  it("names the repo, worktree and host", () => {
    const d = worktreeDisplay("borko-main@h-2e22f90bef5f", repos, hosts);
    assert.equal(d.label, "borko · main on mac");
    assert.doesNotMatch(d.label, /h-[0-9a-f]{8,}/);
  });

  it("leaves the host off for the hub's own worktrees", () => {
    assert.equal(worktreeDisplay("borko-dev", repos, hosts).label, "borko · dev");
  });

  it("falls back without the raw host id when the worktree or host is unknown", () => {
    const d = worktreeDisplay("other-x@h-aaaaaaaaaaaa", repos, hosts);
    assert.equal(d.label, "other-x on unknown worker");
  });
});

describe("hostDisplay", () => {
  it("never returns an unknown id", () => {
    assert.equal(hostDisplay("h-123456789abc", hosts), "unknown worker");
    assert.equal(hostDisplay("h-2e22f90bef5f", hosts), "mac");
    assert.equal(hostDisplay(undefined, hosts), "This hub");
    assert.equal(hostDisplay("h-123456789abc", undefined), "unknown worker");
  });
});
