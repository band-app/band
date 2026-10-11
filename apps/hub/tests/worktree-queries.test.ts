import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { WorktreeQueries } from "../src/server/infra/db/queries/worktrees";
import { seedState } from "./helpers/seed-state";

// ---------------------------------------------------------------------------
// WorktreeQueries.findIdentity — pins the SQL match expression and the
// non-injective `toWorktreeId` collision behaviour acknowledged in the
// TODO on `findIdentity`. The encoding
//
//   ${repo}-${branch.replaceAll("/", "-")}
//
// is lossy: repo "foo-bar" + branch "main" and repo "foo" + branch
// "bar/main" both serialize to "foo-bar-main". The SQL match expression
// (`repo_name || '-' || REPLACE(branch, '/', '-')`) and the runtime
// sanity-check guard (`toWorktreeId(row.repo, row.branch, "local") ===
// worktreeId`) both accept either row, so SQLite's `.get()` returns
// whichever row it finds first. These tests lock that current contract
// so a future SQL rewrite (or change to `toWorktreeId`) can't silently
// flip the behaviour.
// ---------------------------------------------------------------------------

describe("WorktreeQueries.findIdentity", () => {
  let tmp: string;
  let originalBandHome: string | undefined;
  let queries: WorktreeQueries;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-worktree-queries-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
    queries = new WorktreeQueries();
  });

  afterEach(() => {
    closeDb();
    if (originalBandHome !== undefined) {
      process.env.BAND_HOME = originalBandHome;
    } else {
      delete process.env.BAND_HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the identity row for a normal (non-colliding) worktree id", () => {
    const repoName = "kbhq";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "kbhq-main");
    const worktreeId = toWorktreeId(repoName, branch, "local");

    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    const identity = queries.findIdentity(worktreeId);
    expect(identity).toEqual({ repo: repoName, branch, worktreePath: wtPath });
  });

  it("matches a slash-containing branch via the REPLACE clause", () => {
    const repoName = "kbhq";
    const branch = "feature/login";
    const wtPath = join(tmp, "worktrees", "kbhq", "feature", "login");
    const worktreeId = toWorktreeId(repoName, branch, "local");
    expect(worktreeId).toBe("kbhq-feature-login");

    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    const identity = queries.findIdentity(worktreeId);
    expect(identity).toEqual({ repo: repoName, branch, worktreePath: wtPath });
  });

  it("returns null for a worktree id with no matching worktree", () => {
    seedState(tmp, {
      repos: [
        {
          name: "kbhq",
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: join(tmp, "worktrees", "kbhq-main") }],
        },
      ],
    });

    const identity = queries.findIdentity("ghost-branch");
    expect(identity).toBeNull();
  });

  it("returns ONE of the colliding rows when the worktree id is ambiguous", () => {
    // Both ("foo-bar", "main") and ("foo", "bar/main") serialize to
    // "foo-bar-main" via `toWorktreeId`. Both SQL rows satisfy the
    // match expression `repo_name || '-' || REPLACE(branch, '/', '-')`
    // and both satisfy the runtime sanity check
    // `toWorktreeId(row.repo, row.branch, "local") === worktreeId`, so
    // SQLite's `.get()` returns whichever row it finds first. We don't
    // assert which one wins — that's an implementation detail of the
    // SQL engine — but we DO assert that:
    //   1. some row is returned (the sanity check doesn't drop both), and
    //   2. it's one of the two colliding rows verbatim (no field
    //      mangling), and
    //   3. it round-trips through `toWorktreeId` to the same id
    //      (sanity-check holds).
    const wtPathA = join(tmp, "worktrees", "foo-bar", "main");
    const wtPathB = join(tmp, "worktrees", "foo", "bar", "main");
    const worktreeId = toWorktreeId("foo-bar", "main", "local");
    expect(worktreeId).toBe("foo-bar-main");
    expect(toWorktreeId("foo", "bar/main", "local")).toBe(worktreeId);

    seedState(tmp, {
      repos: [
        {
          name: "foo-bar",
          path: join(tmp, "repos", "foo-bar"),
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: wtPathA }],
        },
        {
          name: "foo",
          path: join(tmp, "repos", "foo"),
          defaultBranch: "main",
          worktrees: [{ branch: "bar/main", path: wtPathB }],
        },
      ],
    });

    const identity = queries.findIdentity(worktreeId);
    expect(identity).not.toBeNull();
    const candidates = [
      { repo: "foo-bar", branch: "main", worktreePath: wtPathA },
      { repo: "foo", branch: "bar/main", worktreePath: wtPathB },
    ];
    expect(candidates).toContainEqual(identity);
    expect(toWorktreeId(identity!.repo, identity!.branch, "local")).toBe(worktreeId);
  });
});
