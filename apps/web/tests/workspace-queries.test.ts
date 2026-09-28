import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { closeDb } from "../src/server/infra/db/connection";
import { WorkspaceQueries } from "../src/server/infra/db/queries/workspaces";
import { seedState } from "./helpers/seed-state";

// ---------------------------------------------------------------------------
// WorkspaceQueries.findIdentity — pins the SQL match expression and the
// non-injective `toWorkspaceId` collision behaviour acknowledged in the
// TODO on `findIdentity`. The encoding
//
//   ${project}-${branch.replaceAll("/", "-")}
//
// is lossy: project "foo-bar" + branch "main" and project "foo" + branch
// "bar/main" both serialize to "foo-bar-main". The SQL match expression
// (`project_name || '-' || REPLACE(branch, '/', '-')`) and the runtime
// sanity-check guard (`toWorkspaceId(row.project, row.branch) ===
// workspaceId`) both accept either row, so SQLite's `.get()` returns
// whichever row it finds first. These tests lock that current contract
// so a future SQL rewrite (or change to `toWorkspaceId`) can't silently
// flip the behaviour.
// ---------------------------------------------------------------------------

describe("WorkspaceQueries.findIdentity", () => {
  let tmp: string;
  let originalBandHome: string | undefined;
  let queries: WorkspaceQueries;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-workspace-queries-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
    queries = new WorkspaceQueries();
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

  it("returns the identity row for a normal (non-colliding) workspace id", () => {
    const projectName = "kbhq";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "kbhq-main");
    const workspaceId = toWorkspaceId(projectName, branch);

    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    const identity = queries.findIdentity(workspaceId);
    expect(identity).toEqual({ project: projectName, branch, worktreePath: wtPath });
  });

  it("matches a slash-containing branch via the REPLACE clause", () => {
    const projectName = "kbhq";
    const branch = "feature/login";
    const wtPath = join(tmp, "worktrees", "kbhq", "feature", "login");
    const workspaceId = toWorkspaceId(projectName, branch);
    expect(workspaceId).toBe("kbhq-feature-login");

    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    const identity = queries.findIdentity(workspaceId);
    expect(identity).toEqual({ project: projectName, branch, worktreePath: wtPath });
  });

  it("returns null for a workspace id with no matching worktree", () => {
    seedState(tmp, {
      projects: [
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

  it("returns ONE of the colliding rows when the workspace id is ambiguous", () => {
    // Both ("foo-bar", "main") and ("foo", "bar/main") serialize to
    // "foo-bar-main" via `toWorkspaceId`. Both SQL rows satisfy the
    // match expression `project_name || '-' || REPLACE(branch, '/', '-')`
    // and both satisfy the runtime sanity check
    // `toWorkspaceId(row.project, row.branch) === workspaceId`, so
    // SQLite's `.get()` returns whichever row it finds first. We don't
    // assert which one wins — that's an implementation detail of the
    // SQL engine — but we DO assert that:
    //   1. some row is returned (the sanity check doesn't drop both), and
    //   2. it's one of the two colliding rows verbatim (no field
    //      mangling), and
    //   3. it round-trips through `toWorkspaceId` to the same id
    //      (sanity-check holds).
    const wtPathA = join(tmp, "worktrees", "foo-bar", "main");
    const wtPathB = join(tmp, "worktrees", "foo", "bar", "main");
    const workspaceId = toWorkspaceId("foo-bar", "main");
    expect(workspaceId).toBe("foo-bar-main");
    expect(toWorkspaceId("foo", "bar/main")).toBe(workspaceId);

    seedState(tmp, {
      projects: [
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

    const identity = queries.findIdentity(workspaceId);
    expect(identity).not.toBeNull();
    const candidates = [
      { project: "foo-bar", branch: "main", worktreePath: wtPathA },
      { project: "foo", branch: "bar/main", worktreePath: wtPathB },
    ];
    expect(candidates).toContainEqual(identity);
    expect(toWorkspaceId(identity!.project, identity!.branch)).toBe(workspaceId);
  });
});
