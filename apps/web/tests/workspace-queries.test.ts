import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { closeDb } from "../src/server/infra/db/connection";
import { WorkspaceQueries } from "../src/server/infra/db/queries/workspaces";
import { seedState } from "./helpers/seed-state";

// ---------------------------------------------------------------------------
// WorkspaceQueries.findIdentity — pins the exact-id lookup contract.
//
// `findIdentity` now matches on the stored, unique `worktrees.workspace_id`
// column (the worktree's frozen identity) rather than re-deriving the id
// from `project_name || '-' || REPLACE(branch, '/', '-')` at query time.
// That kills the old non-injective-encoding ambiguity (project "foo-bar" +
// branch "main" and project "foo" + branch "bar/main" both serialize to
// "foo-bar-main"): the unique index makes two such rows impossible to store
// at all, and lookups resolve to one exact row by id.
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

  it("resolves each workspace by its exact stored id with no cross-talk", () => {
    // Two worktrees whose ids share a prefix. The old query re-derived the
    // id from (project, branch) and could mis-resolve; the column lookup is
    // exact, so each id maps to exactly its own row.
    const wtPathA = join(tmp, "worktrees", "alpha", "main");
    const wtPathB = join(tmp, "worktrees", "alpha", "feature");
    const idA = toWorkspaceId("alpha", "main");
    const idB = toWorkspaceId("alpha", "feature");

    seedState(tmp, {
      projects: [
        {
          name: "alpha",
          path: join(tmp, "repos", "alpha"),
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: wtPathA },
            { branch: "feature", path: wtPathB },
          ],
        },
      ],
    });

    expect(queries.findIdentity(idA)).toEqual({
      project: "alpha",
      branch: "main",
      worktreePath: wtPathA,
    });
    expect(queries.findIdentity(idB)).toEqual({
      project: "alpha",
      branch: "feature",
      worktreePath: wtPathB,
    });
  });

  it("a switched branch still resolves via its frozen id, not the new branch", () => {
    // The worktree was created on `feature` (id frozen as alpha-feature) but
    // its branch was later switched to `feature-renamed`. Resolution must key
    // on the frozen id; the live branch is just a label carried on the row.
    const wtPath = join(tmp, "worktrees", "alpha", "feature");
    const frozenId = toWorkspaceId("alpha", "feature");

    seedState(tmp, {
      projects: [
        {
          name: "alpha",
          path: join(tmp, "repos", "alpha"),
          defaultBranch: "main",
          worktrees: [{ workspaceId: frozenId, branch: "feature-renamed", path: wtPath }],
        },
      ],
    });

    // The id derived from the *new* branch resolves to nothing ...
    expect(queries.findIdentity(toWorkspaceId("alpha", "feature-renamed"))).toBeNull();
    // ... while the frozen id resolves to the worktree, reporting its live branch.
    expect(queries.findIdentity(frozenId)).toEqual({
      project: "alpha",
      branch: "feature-renamed",
      worktreePath: wtPath,
    });
  });
});
