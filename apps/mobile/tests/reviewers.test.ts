import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVIEWER_STATE_LABEL,
  reviewerInitial,
  reviewersSummary,
  showsReviewers,
} from "../src/lib/checks/reviewers.ts";

const reviewer = (login: string, state: "approved" | "pending" | "changes_requested") => ({
  login,
  avatarUrl: null,
  state,
});

describe("reviewers", () => {
  it("counts approvals out of all reviewers", () => {
    assert.equal(
      reviewersSummary([
        reviewer("alice", "approved"),
        reviewer("bob", "changes_requested"),
        reviewer("carol", "pending"),
      ]),
      "1/3 approved",
    );
    assert.equal(reviewersSummary([]), "none");
  });

  it("shows the section for an empty list but not when the provider reports none", () => {
    assert.equal(showsReviewers({ reviewers: [] }), true);
    assert.equal(showsReviewers({ reviewers: [reviewer("a", "pending")] }), true);
    assert.equal(showsReviewers({}), false);
    assert.equal(showsReviewers(null), false);
  });

  it("labels states like the web tab", () => {
    assert.equal(REVIEWER_STATE_LABEL.changes_requested, "Changes requested");
    assert.equal(REVIEWER_STATE_LABEL.pending, "Pending");
  });

  it("uses the first letter of the login as the fallback avatar", () => {
    assert.equal(reviewerInitial("alice"), "A");
  });
});
