import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortRepoWorktrees, withoutPinned } from "@band-app/shared/sidebar-tree";
import {
  buildOriginRows,
  buildPinnedTree as webPinnedTree,
} from "../../web/src/dashboard/lib/sidebar-grouping.ts";
import { applyStatusEvent, emptyStatusState, type StatusEvent } from "../src/lib/status-state.ts";
import {
  buildSections,
  ciTone,
  countAttention,
  findRow,
  hostLabel,
  parseGroupBy,
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
  {
    name: "beta",
    worktrees: [{ name: "main", branch: "main", pinned: false, groupId: "grp_1791723973064" }],
  },
];

function statusesOf(events: StatusEvent[]) {
  return events.reduce(applyStatusEvent, emptyStatusState());
}

const base = {
  statuses: emptyStatusState(),
  hosts: [{ id: "h-1", name: "builder" }],
  collapsed: new Set<string>(),
  query: "",
};

describe("buildSections", () => {
  it("lists pinned worktrees in their own section, then every repo with its worktrees", () => {
    const sections = buildSections(repos, base);
    assert.deepEqual(
      sections.map((s) => s.title),
      ["Pinned", "alpha", "beta"],
    );
    assert.equal(sections[0]?.kind, "pinned");
    assert.deepEqual(
      sections[0]?.data.map((r) => r.id),
      ["alpha-feat-login"],
    );
    const alpha = sections[1]?.data ?? [];
    assert.deepEqual(
      alpha.map((r) => r.name),
      ["main", "fix-bug"],
    );
    assert.equal(alpha[1]?.id, "alpha-fix-bug@h-1");
    assert.deepEqual(
      alpha.map((r) => [r.hostTag, r.remote]),
      [
        ["This hub", false],
        ["builder", true],
      ],
    );
  });

  it("drops the rows of a collapsed repo but keeps its counts", () => {
    const sections = buildSections(repos, { ...base, collapsed: new Set(["alpha"]) });
    assert.equal(sections[1]?.collapsed, true);
    assert.equal(sections[1]?.data.length, 0);
    assert.equal(sections[1]?.total, 2);
  });

  it("filters by name, branch or repo name and drops repos with no match", () => {
    assert.deepEqual(
      buildSections(repos, { ...base, query: "LOGIN" }).map((s) => s.data.map((r) => r.id)),
      [["alpha-feat-login"]],
    );
    assert.deepEqual(
      buildSections(repos, { ...base, query: "beta" }).map((s) => s.name),
      ["beta"],
    );
  });

  it("finds a worktree by its id, repo and name together", () => {
    assert.deepEqual(
      buildSections(repos, { ...base, query: "alpha-fix-bug" }).map((s) => s.data.map((r) => r.id)),
      [["alpha-fix-bug@h-1"]],
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

  it("maps the agent status to the icon and the second line", () => {
    const statuses = statusesOf([
      {
        kind: "snapshot",
        statuses: [
          { worktreeId: "beta-main", agent: { status: "question" } },
          {
            worktreeId: "alpha-main",
            agent: {
              status: "working",
              lastActivity: new Date(Date.now() - 3 * 60_000).toISOString(),
            },
          },
        ],
      },
    ]);
    const sections = buildSections(repos, { ...base, statuses });
    const main = sections[1]?.data.find((r) => r.id === "alpha-main");
    assert.equal(main?.agent, "running");
    assert.equal(main?.shown, "working");
    assert.equal(main?.subtitle, "Working · 3 m");
    const beta = sections[2]?.data[0];
    assert.equal(beta?.shown, "question");
    assert.equal(beta?.subtitle, "Needs you");
    assert.equal(countAttention(repos, statuses), 1);
  });

  it("groups by host, hub first, and nests by origin", () => {
    const byHost = buildSections(repos, { ...base, groupBy: "host" });
    assert.deepEqual(
      byHost.map((s) => s.title),
      ["Pinned", "This hub", "builder"],
    );
    // The repo leads the second line, with no trailing separator when nothing follows.
    assert.equal(byHost[2]?.data[0]?.subtitle, "alpha");
    const withOrigin: RepoLike[] = [
      {
        name: "alpha",
        defaultBranch: "main",
        worktrees: [
          {
            name: "child",
            branch: "child",
            pinned: false,
            origin: { worktreeId: "alpha-feat", removed: false },
          },
          { name: "feat", branch: "feat", pinned: false },
          { name: "main", branch: "main", pinned: false },
        ],
      },
    ];
    const rows = buildSections(withOrigin, { ...base, groupBy: "origin" })[0]?.data ?? [];
    assert.deepEqual(
      rows.map((r) => [r.name, r.depth]),
      [
        ["main", 0],
        ["feat", 1],
        ["child", 2],
      ],
    );
  });

  it("carries the PR tag, or the CI icon when there is no PR", () => {
    const pr = { number: 7, title: "Add login", url: "u", state: "open" as const, isDraft: false };
    const statuses = statusesOf([
      { kind: "branch-status", worktreeId: "alpha-main", ci: { state: "failure", pr } },
      { kind: "branch-status", worktreeId: "beta-main", ci: { state: "success", pr: null } },
    ]);
    const sections = buildSections(repos, { ...base, statuses });
    const main = sections[1]?.data.find((r) => r.id === "alpha-main");
    assert.equal(main?.pr?.number, 7);
    assert.equal(main?.prTone, "failure");
    assert.equal(main?.ciTone, null);
    const beta = sections[2]?.data[0];
    assert.equal(beta?.pr, null);
    assert.equal(beta?.ciTone, "success");
  });
});

const webPins = (repos: RepoLike[]) => ({
  pins: webPinnedTree(sortRepoWorktrees(repos as never) as never),
});

describe("pinned, groups and origin like the web", () => {
  const groups = [
    { id: "l1", name: "Epic", color: "#ef4444" },
    { id: "l2", name: "Private", color: "#3b82f6" },
  ];
  const fixture: RepoLike[] = [
    {
      name: "alpha",
      defaultBranch: "main",
      worktrees: [
        { name: "main", branch: "main", pinned: false, groupId: "l2" },
        { name: "second", branch: "second", pinned: true, pinSortIndex: 2 },
        { name: "first", branch: "first", pinned: true, pinSortIndex: 1 },
        {
          name: "started-from-first",
          branch: "s",
          pinned: false,
          origin: { worktreeId: "alpha-first", removed: false },
          groupId: "l2",
        },
        { name: "loose", branch: "loose", pinned: false, sortIndex: 1, groupId: "l1" },
      ],
    },
    {
      name: "beta",
      defaultBranch: "main",
      worktrees: [{ name: "main", branch: "main", pinned: false, groupId: "l1" }],
    },
    {
      name: "gamma",
      defaultBranch: "main",
      worktrees: [{ name: "main", branch: "main", pinned: false }],
    },
  ];
  const opts = { ...base, groups };

  it("S2: Pinned lists the pins in the web's order with what started from each", () => {
    const pinned = buildSections(fixture, opts)[0];
    assert.equal(pinned?.kind, "pinned");
    assert.deepEqual(
      pinned?.data.map((r) => [r.id, r.depth]),
      [
        ["alpha-first", 0],
        ["alpha-started-from-first", 1],
        ["alpha-second", 0],
      ],
    );
  });

  it("S4: worktrees sit under group headers in group order, ungrouped last, a repo once per group", () => {
    const sections = buildSections(fixture, opts).filter((s) => s.kind === "repo");
    assert.deepEqual(
      sections.map((s) => [
        s.name,
        s.groupHeader?.name ?? null,
        s.groupHeader?.color ?? null,
        s.data.map((r) => r.id),
      ]),
      [
        ["l1:alpha", "Epic", "#ef4444", ["alpha-loose"]],
        ["l1:beta", null, null, ["beta-main"]],
        ["l2:alpha", "Private", "#3b82f6", ["alpha-main"]],
        ["none:gamma", "Ungrouped", null, ["gamma-main"]],
      ],
    );
  });

  it("S4: a worktree whose group is gone is listed as ungrouped", () => {
    const sections = buildSections(
      [
        {
          name: "delta",
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", pinned: false, groupId: "gone" }],
        },
      ],
      opts,
    );
    assert.deepEqual(
      sections.map((s) => [s.name, s.groupHeader?.name]),
      [["none:delta", "Ungrouped"]],
    );
  });

  it("S4: no group headers without groups or while a filter is on", () => {
    assert.ok(buildSections(fixture, base).every((s) => !s.groupHeader));
    assert.ok(buildSections(fixture, { ...opts, groupFilter: "l1" }).every((s) => !s.groupHeader));
  });

  it("S5: the filter keeps only that group's worktrees, the pins and the other views included", () => {
    const ids = (groupBy: "repo" | "origin" | "host") =>
      buildSections(fixture, { ...opts, groupFilter: "l1", groupBy }).flatMap((s) =>
        s.data.map((r) => r.id),
      );
    assert.deepEqual(ids("repo"), ["alpha-loose", "beta-main"]);
    assert.deepEqual(ids("origin").sort(), ["alpha-loose", "beta-main"]);
    assert.deepEqual(ids("host").sort(), ["alpha-loose", "beta-main"]);
    assert.deepEqual(
      buildSections(fixture, { ...opts, groupFilter: "l1" }).map((s) => s.kind),
      ["repo", "repo"],
    );
    assert.equal(buildSections(fixture, { ...opts, groupFilter: null }).length, 5);
  });

  it("S6: Origin matches the web's Origin view for the same data, Pinned on top", () => {
    const sections = buildSections(fixture, { ...opts, groupBy: "origin" });
    assert.equal(sections[0]?.kind, "pinned");
    const mine = sections[1]?.data.map((r) => [r.id, r.depth]);

    const { pins } = webPins(fixture);
    const webRows = buildOriginRows(
      withoutPinned(sortRepoWorktrees(fixture as never), pins as never).repos as never,
      () => false,
    ).flatMap((row) => (row.kind === "worktree" ? [[row.entry.worktreeId, row.depth]] : []));
    assert.deepEqual(mine, webRows);
  });

  it("S6: Worker groups the hub first and keeps Pinned on top", () => {
    const withHost: RepoLike[] = [
      ...fixture,
      {
        name: "delta",
        defaultBranch: "main",
        worktrees: [{ name: "x", branch: "x", pinned: false, hostId: "h-1" }],
      },
    ];
    const sections = buildSections(withHost, { ...opts, groupBy: "host" });
    assert.deepEqual(
      sections.map((s) => s.title),
      ["Pinned", "This hub", "builder"],
    );
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

describe("parseGroupBy", () => {
  it("accepts origin and host and falls back to repo", () => {
    assert.equal(parseGroupBy("origin"), "origin");
    assert.equal(parseGroupBy("host"), "host");
    assert.equal(parseGroupBy("junk"), "repo");
    assert.equal(parseGroupBy(null), "repo");
  });
});
