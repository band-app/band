import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canDelete,
  type DeletableRow,
  deleteFailure,
  deletePrompt,
  deleteWarnings,
  removeRequest,
} from "../src/lib/deleting.ts";

const clean: DeletableRow = {
  repo: "alpha",
  name: "feat-x",
  hostId: "local",
  main: false,
  plain: false,
  dirty: false,
  ahead: 0,
  pr: null,
  prTone: null,
};

describe("deleting", () => {
  it("offers delete except for the default branch and a plain folder", () => {
    assert.equal(canDelete(clean), true);
    assert.equal(canDelete({ ...clean, main: true }), false);
    assert.equal(canDelete({ ...clean, plain: true }), false);
  });

  it("has no warnings for a clean row and a plain confirm", () => {
    assert.deepEqual(deleteWarnings(clean), []);
    assert.equal(deletePrompt(clean).confirm, "Delete");
    assert.equal(deletePrompt(clean).title, "Delete feat-x?");
  });

  it("lists each thing that would be lost", () => {
    const row = { ...clean, dirty: true, ahead: 2, pr: { number: 123 }, prTone: "success" };
    assert.deepEqual(deleteWarnings(row), [
      "PR #123 is open. This branch has not been merged.",
      "2 commits not pushed. They will be lost.",
      "Uncommitted changes. They will be lost.",
    ]);
    assert.equal(deletePrompt(row).confirm, "Delete anyway");
  });

  it("uses the singular for one commit and ignores a merged or closed PR", () => {
    assert.deepEqual(deleteWarnings({ ...clean, ahead: 1 }), [
      "1 commit not pushed. They will be lost.",
    ]);
    assert.deepEqual(deleteWarnings({ ...clean, pr: { number: 5 }, prTone: "merged" }), []);
    assert.deepEqual(deleteWarnings({ ...clean, pr: { number: 5 }, prTone: "closed" }), []);
  });

  it("leaves the host out for the hub's own machine", () => {
    assert.deepEqual(removeRequest(clean), { repo: "alpha", name: "feat-x" });
    assert.deepEqual(removeRequest({ ...clean, hostId: "h-1" }), {
      repo: "alpha",
      name: "feat-x",
      hostId: "h-1",
    });
  });

  it("shows the hub's message when a delete is refused", () => {
    assert.deepEqual(deleteFailure(clean, new Error("feat-x has a running agent")), {
      title: "Could not delete feat-x",
      message: "feat-x has a running agent",
    });
    assert.equal(deleteFailure(clean, "boom").message, "The hub refused the request.");
  });
});
