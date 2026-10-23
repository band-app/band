import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortRepoWorktrees } from "@band-app/shared/sidebar-tree";
import { buildGroupRows } from "../../web/src/dashboard/lib/sidebar-grouping.ts";
import { allCollapsed, setCollapsedMany } from "../src/lib/collapsed-repos.ts";
import {
  parentCandidates,
  removeFromGroupRequests,
  setParentRequests,
} from "../src/lib/parenting.ts";
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

  it("keeps the repo on the second line and records each row's parent", () => {
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
    const rows = buildSections(withOrigin, base)[0]?.data ?? [];
    assert.deepEqual(
      rows.map((r) => [r.name, r.parentId]),
      [
        ["child", "alpha-feat"],
        ["feat", null],
        ["main", null],
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

  it("S4, S12: plain top-level rows come first with no header, then each group as one section", () => {
    const sections = buildSections(fixture, opts).filter((s) => s.kind !== "pinned");
    assert.deepEqual(
      sections.map((s) => [s.name, s.kind, s.title, s.data.map((r) => r.id)]),
      [
        ["group:none", "top", "", ["gamma-main"]],
        ["group:l1", "group", "Epic", ["alpha-loose", "beta-main"]],
        ["group:l2", "group", "Private", ["alpha-main"]],
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
    // The defined groups stay listed, empty, so a worktree can be moved into them.
    assert.deepEqual(
      sections.map((s) => [s.name, s.data.length]),
      [
        ["group:none", 1],
        ["group:l1", 0],
        ["group:l2", 0],
      ],
    );
  });

  it("S4: without groups the worktrees sit under their repos", () => {
    assert.ok(buildSections(fixture, base).every((s) => s.kind !== "group"));
  });

  it("S5: the filter shows one group laid out as in All, with the pins narrowed too", () => {
    const all = buildSections(fixture, opts).find((s) => s.name === "group:l1");
    const filtered = buildSections(fixture, { ...opts, groupFilter: "l1" });
    assert.deepEqual(
      filtered.map((s) => s.name),
      ["group:l1"],
    );
    assert.deepEqual(
      filtered[0]?.data.map((r) => [r.id, r.depth]),
      all?.data.map((r) => [r.id, r.depth]),
    );
    assert.equal(filtered[0]?.title, all?.title);
    assert.equal(buildSections(fixture, { ...opts, groupFilter: null }).length, 4);
  });

  it("S6: the groups and their rows match the web's for the same data", () => {
    const mine = buildSections(fixture, opts)
      .filter((s) => s.kind !== "pinned")
      .flatMap((s) => s.data.map((r) => [s.name, r.id, r.depth]));
    const sorted = sortRepoWorktrees(fixture as never);
    const pinned = buildSections(fixture, opts)[0]?.data.map((r) => r.id) ?? [];
    const rest = sorted.map((r) => ({
      ...r,
      worktrees: r.worktrees.filter((w) => !pinned.includes(`${r.name}-${w.name}`)),
    }));
    let group = "group:none";
    const web: Array<[string, string, number]> = [];
    for (const row of buildGroupRows({
      repos: rest as never,
      allRepos: sorted as never,
      groups,
      filter: null,
      isGroupCollapsed: () => false,
      isOriginCollapsed: () => false,
    })) {
      if (row.kind === "group") group = `group:${row.groupId ?? "none"}`;
      else web.push([group, row.entry.worktreeId, row.depth]);
    }
    assert.deepEqual(mine, web);
  });
});

describe("setting a parent", () => {
  it("offers every worktree except the row and what was started from it", () => {
    const tree: RepoLike[] = [
      {
        name: "app",
        defaultBranch: "main",
        worktrees: [
          { name: "a", branch: "a", pinned: false, groupId: "g1" },
          {
            name: "b",
            branch: "b",
            pinned: false,
            origin: { worktreeId: "app-a", removed: false },
          },
          { name: "c", branch: "c", pinned: false, groupId: "g2" },
        ],
      },
    ];
    assert.deepEqual(
      parentCandidates(tree, { id: "app-a" }).map((c) => c.id),
      ["app-c"],
    );
  });

  it("moves the child into the parent's group, and a clear request changes no group", () => {
    const row = { id: "app-a", repo: "app", name: "a", hostId: "h-1", groupId: "g1" };
    const picked = setParentRequests(row, { id: "app-c", groupId: "g2" });
    assert.deepEqual(picked.origin, { repo: "app", name: "a", origin: "app-c", hostId: "h-1" });
    assert.deepEqual(picked.group, { worktreeId: "app-a", groupId: "g2", withChildren: true });
    assert.equal(setParentRequests(row, null).group, null);
    assert.equal(setParentRequests(row, { id: "app-d", groupId: "g1" }).group, null);
  });

  it("clears only the group when the parent is ungrouped or there is none", () => {
    const row = { id: "app-a", repo: "app", name: "a", hostId: "h-1", parentId: null };
    assert.deepEqual(removeFromGroupRequests(row, null), {
      origin: null,
      group: { worktreeId: "app-a", groupId: null },
    });
    assert.deepEqual(removeFromGroupRequests({ ...row, parentId: "app-b" }, null), {
      origin: null,
      group: { worktreeId: "app-a", groupId: null },
    });
  });

  it("also clears the parent when the parent is itself grouped", () => {
    const row = { id: "app-a", repo: "app", name: "a", hostId: "h-1", parentId: "app-b" };
    assert.deepEqual(removeFromGroupRequests(row, "g1"), {
      origin: { repo: "app", name: "a", origin: null, hostId: "h-1" },
      group: { worktreeId: "app-a", groupId: null },
    });
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

describe("collapse all", () => {
  it("folds and unfolds the named sections and keeps the others", () => {
    const folded = setCollapsedMany(JSON.stringify(["keep"]), ["group:a", "group:b"], true);
    assert.deepEqual(JSON.parse(folded ?? "[]"), ["group:a", "group:b", "keep"]);
    const unfolded = setCollapsedMany(folded, ["group:a", "group:b"], false);
    assert.deepEqual(JSON.parse(unfolded ?? "[]"), ["keep"]);
    assert.equal(setCollapsedMany(null, ["x"], false), null);
  });

  it("reports everything folded only when every named section is, and never for none", () => {
    assert.equal(allCollapsed(new Set(["a", "b"]), ["a", "b"]), true);
    assert.equal(allCollapsed(new Set(["a"]), ["a", "b"]), false);
    assert.equal(allCollapsed(new Set(["a"]), []), false);
  });
});
