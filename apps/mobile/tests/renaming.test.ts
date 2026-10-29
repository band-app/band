import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameFailure, renameRequest, rowTitle, TITLE_MAX } from "../src/lib/renaming.ts";
import { emptyStatusState } from "../src/lib/status-state.ts";
import { buildSections, type RepoLike } from "../src/lib/worktree-list.ts";

describe("renaming", () => {
  it("shows the title when there is one, else the name", () => {
    assert.equal(rowTitle({ name: "feat-x", title: "Login revamp" }), "Login revamp");
    assert.equal(rowTitle({ name: "feat-x", title: null }), "feat-x");
  });

  it("trims what was typed, and clears the title when it is blank", () => {
    assert.deepEqual(renameRequest({ id: "a-x" }, "  Login revamp "), {
      worktreeId: "a-x",
      title: "Login revamp",
    });
    assert.deepEqual(renameRequest({ id: "a-x" }, "   "), { worktreeId: "a-x", title: null });
    assert.deepEqual(renameRequest({ id: "a-x" }, undefined), { worktreeId: "a-x", title: null });
    assert.equal(renameRequest({ id: "a-x" }, "x".repeat(300)).title?.length, TITLE_MAX);
  });

  it("names the failure and falls back to a plain message", () => {
    assert.deepEqual(renameFailure({ name: "x", title: "T" }, new Error("nope")), {
      title: "Could not rename T",
      message: "nope",
    });
    assert.equal(
      renameFailure({ name: "x", title: null }, "?").message,
      "The hub refused the request.",
    );
  });

  it("puts the hub's title on the list row and keeps the name for requests", () => {
    const repos: RepoLike[] = [
      {
        name: "alpha",
        worktrees: [
          { name: "main", branch: "main", pinned: false },
          { name: "feat-x", branch: "feat-x", pinned: false, title: "Login revamp" },
        ],
      },
    ];
    const rows = buildSections(repos, {
      statuses: emptyStatusState(),
      hosts: [],
      collapsed: new Set<string>(),
      query: "",
    }).flatMap((s) => s.data);
    const row = rows.find((r) => r.name === "feat-x");
    assert.equal(row?.title, "Login revamp");
    assert.equal(rows.find((r) => r.name === "main")?.title, null);
  });
});
