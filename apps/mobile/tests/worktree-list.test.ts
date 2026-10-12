import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyStatusEvent, emptyStatusState, type StatusEvent } from "../src/lib/status-state.ts";
import {
  buildSections,
  ciTone,
  countAttention,
  findRow,
  hostLabel,
  pullRequestTone,
  type RepoLike,
} from "../src/lib/worktree-list.ts";

const repos: RepoLike[] = [
  {
    name: "alpha",
    worktrees: [
      { name: "main", branch: "main", pinned: false },
      { name: "feat/login", branch: "feat/login", pinned: true },
      { name: "fix-bug", branch: "fix-bug", pinned: false, hostId: "h-1" },
    ],
  },
  { name: "beta", label: "Beta app", worktrees: [{ name: "main", branch: "main", pinned: false }] },
];

function statusesOf(events: StatusEvent[]) {
  return events.reduce(applyStatusEvent, emptyStatusState());
}

const base = {
  statuses: emptyStatusState(),
  hosts: [{ id: "h-1", name: "builder" }],
  collapsed: new Set<string>(),
  query: "",
  needsMeOnly: false,
};

describe("buildSections", () => {
  it("lists every repo with its worktrees, pinned first, with branch and host", () => {
    const sections = buildSections(repos, base);
    assert.deepEqual(
      sections.map((s) => s.title),
      ["alpha", "Beta app"],
    );
    const alpha = sections[0]?.data ?? [];
    assert.deepEqual(
      alpha.map((r) => r.name),
      ["feat/login", "main", "fix-bug"],
    );
    assert.equal(alpha[0]?.id, "alpha-feat-login");
    assert.equal(alpha[2]?.id, "alpha-fix-bug@h-1");
    assert.deepEqual(
      alpha.map((r) => r.hostTag),
      ["This hub", "This hub", "builder"],
    );
  });

  it("drops the rows of a collapsed repo but keeps its counts", () => {
    const sections = buildSections(repos, { ...base, collapsed: new Set(["alpha"]) });
    assert.equal(sections[0]?.collapsed, true);
    assert.equal(sections[0]?.data.length, 0);
    assert.equal(sections[0]?.total, 3);
  });

  it("filters by name, branch or repo title and drops repos with no match", () => {
    assert.deepEqual(
      buildSections(repos, { ...base, query: "LOGIN" }).map((s) => s.data.map((r) => r.id)),
      [["alpha-feat-login"]],
    );
    assert.deepEqual(
      buildSections(repos, { ...base, query: "beta" }).map((s) => s.name),
      ["beta"],
    );
  });

  it("shows a collapsed repo expanded while a filter is on", () => {
    const sections = buildSections(repos, {
      ...base,
      collapsed: new Set(["alpha"]),
      query: "main",
    });
    assert.equal(sections[0]?.collapsed, false);
    assert.equal(sections[0]?.data.length, 1);
  });

  it("keeps only the worktrees that need the user with the needs-me filter", () => {
    const statuses = statusesOf([
      {
        kind: "snapshot",
        statuses: [
          { worktreeId: "beta-main", agent: { status: "needs_attention" } },
          { worktreeId: "alpha-main", agent: { status: "working" } },
        ],
      },
    ]);
    const sections = buildSections(repos, { ...base, statuses, needsMeOnly: true });
    assert.deepEqual(
      sections.map((s) => s.data.map((r) => r.id)),
      [["beta-main"]],
    );
    assert.equal(countAttention(repos, statuses), 1);
    const all = buildSections(repos, { ...base, statuses });
    assert.equal(all[0]?.data.find((r) => r.id === "alpha-main")?.agent, "running");
  });

  it("carries the PR tag, or the CI icon when there is no PR", () => {
    const pr = { number: 7, title: "Add login", url: "u", state: "open" as const, isDraft: false };
    const statuses = statusesOf([
      { kind: "branch-status", worktreeId: "alpha-main", ci: { state: "failure", pr } },
      { kind: "branch-status", worktreeId: "beta-main", ci: { state: "success", pr: null } },
    ]);
    const sections = buildSections(repos, { ...base, statuses });
    const main = sections[0]?.data.find((r) => r.id === "alpha-main");
    assert.equal(main?.pr?.number, 7);
    assert.equal(main?.prTone, "failure");
    assert.equal(main?.ciTone, null);
    const beta = sections[1]?.data[0];
    assert.equal(beta?.pr, null);
    assert.equal(beta?.ciTone, "success");
  });
});

describe("badges", () => {
  const pr = (state: "open" | "merged" | "closed") => ({
    number: 1,
    title: "t",
    url: "u",
    state,
    isDraft: false,
  });

  it("colors an open PR by CI state and merged or closed PRs by their own state", () => {
    assert.equal(pullRequestTone(pr("open"), "running"), "pending");
    assert.equal(pullRequestTone(pr("open"), "success"), "success");
    assert.equal(pullRequestTone(pr("open"), "cancelled"), "neutral");
    assert.equal(pullRequestTone(pr("open"), "none"), "neutral");
    assert.equal(pullRequestTone(pr("merged"), "failure"), "merged");
    assert.equal(pullRequestTone(pr("closed"), "success"), "closed");
  });

  it("shows no CI icon without checks", () => {
    assert.equal(ciTone({ state: "none" }), null);
    assert.equal(ciTone({ state: "cancelled" }), null);
    assert.equal(ciTone(undefined), null);
    assert.equal(ciTone({ state: "pending" }), "pending");
  });

  it("names hosts like the web", () => {
    assert.equal(hostLabel(undefined, []), "This hub");
    assert.equal(hostLabel("local", []), "This hub");
    assert.equal(hostLabel("h-1", [{ id: "h-1", name: " builder " }]), "builder");
    assert.equal(hostLabel("h-2", []), "h-2");
  });
});

describe("findRow", () => {
  it("finds a worktree by id and returns null for an unknown one", () => {
    assert.equal(findRow(repos, "alpha-fix-bug@h-1", emptyStatusState(), [])?.branch, "fix-bug");
    assert.equal(findRow(repos, "nope", emptyStatusState(), []), null);
  });
});
