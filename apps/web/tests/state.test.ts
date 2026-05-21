import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/lib/db/connection";
import { getWorkspaceStatus, upsertWorkspaceStatus } from "../src/lib/state";
import { seedState, seedWorkspaceStatuses } from "./helpers/seed-state";

// Read `updated_at` directly from SQLite — used to assert that the
// no-op write skip actually prevents writes (rather than the higher-level
// row staying logically identical).
function readUpdatedAt(tmpHome: string, workspaceId: string): number | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite
      .prepare("SELECT updated_at FROM workspace_statuses WHERE workspace_id = ?")
      .get(workspaceId) as { updated_at: number } | undefined;
    return row?.updated_at;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// upsertWorkspaceStatus — heals stale rows with empty identity fields.
//
// The desktop title-bar EditorPicker dropdown is gated on a non-empty
// `worktreePath` (see DesktopTitleBar.tsx). Some rows in older Band
// installs were inserted with `worktreePath = ""` (agent started before
// the project's worktree was persisted, or rows left behind by a prior
// version). Without healing, those workspaces never get the dropdown
// even though the worktree path is recoverable from the projects /
// worktrees tables.
// ---------------------------------------------------------------------------

describe("upsertWorkspaceStatus — identity healing", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-state-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
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

  it("heals an existing row with empty project/branch/worktreePath", () => {
    const projectName = "kbhq";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "kbhq-main");
    const workspaceId = toWorkspaceId(projectName, branch);

    // Project state has a real worktree for this workspaceId.
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

    // workspace_statuses row exists but with empty identity fields,
    // mirroring the user-reported real-world state.
    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    expect(healed.project).toBe(projectName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);

    // Round-trip via getWorkspaceStatus to make sure the update was
    // actually written to the row, not just returned in-memory.
    const persisted = getWorkspaceStatus(workspaceId);
    expect(persisted).not.toBeNull();
    expect(persisted!.project).toBe(projectName);
    expect(persisted!.branch).toBe(branch);
    expect(persisted!.worktreePath).toBe(wtPath);
  });

  it("heals only the empty subset of identity fields", () => {
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

    // Pre-existing row has correct project + branch but lost its
    // worktreePath somehow. Only worktreePath should be healed; the
    // already-correct fields must be left alone.
    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: projectName,
        branch,
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    expect(healed.project).toBe(projectName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);
  });

  it("does not overwrite non-empty worktreePath even if state.json would resolve differently", () => {
    const projectName = "kbhq";
    const branch = "main";
    const staleButValidPath = "/tmp/some-old-cached-worktree-path";
    const newPathInState = join(tmp, "worktrees", "kbhq-main");
    const workspaceId = toWorkspaceId(projectName, branch);

    // state.json (projects/worktrees DB) currently resolves the
    // workspace to a different path. We should NOT clobber the row.
    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: newPathInState }],
        },
      ],
    });

    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: projectName,
        branch,
        worktreePath: staleButValidPath,
        agentStatus: "waiting",
      },
    ]);

    const result = upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    // worktreePath stays at the (non-empty) seeded value — healing is
    // conservative and never overwrites correct data.
    expect(result.worktreePath).toBe(staleButValidPath);
    expect(result.project).toBe(projectName);
    expect(result.branch).toBe(branch);
  });

  it("leaves an existing row alone when project/worktrees DB has no matching entry", () => {
    const workspaceId = "unknown-project-main";

    // No projects/worktrees seeded — resolveWorkspaceIdentity returns
    // null, so the row stays empty (no spurious writes).
    seedState(tmp, { projects: [] });
    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const result = upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    expect(result.project).toBe("");
    expect(result.branch).toBe("");
    expect(result.worktreePath).toBe("");
  });
});

// ---------------------------------------------------------------------------
// upsertWorkspaceStatus — no-op write skip.
//
// The status poller calls `upsertWorkspaceStatus(_, { status: "waiting" })`
// on every tick for every idle workspace; without a no-op guard each tick
// produces a WAL frame just to bump `updatedAt`, which nothing reads.
// ---------------------------------------------------------------------------

describe("upsertWorkspaceStatus — no-op write skip", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-state-noop-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
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

  it("does not bump updated_at when nothing changed", () => {
    const projectName = "demo";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "demo-main");
    const workspaceId = toWorkspaceId(projectName, branch);

    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    // Seed a fully-populated row so no healing or status change is needed.
    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: projectName,
        branch,
        worktreePath: wtPath,
        agentStatus: "waiting",
        agentLastActivity: "",
      },
    ]);

    const before = readUpdatedAt(tmp, workspaceId);
    expect(before).toBeDefined();

    upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    const after = readUpdatedAt(tmp, workspaceId);
    // updated_at must be byte-identical — no UPDATE was issued.
    expect(after).toBe(before);
  });

  it("does bump updated_at when status changes", () => {
    const projectName = "demo";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "demo-main");
    const workspaceId = toWorkspaceId(projectName, branch);

    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: projectName,
        branch,
        worktreePath: wtPath,
        agentStatus: "waiting",
      },
    ]);

    const before = readUpdatedAt(tmp, workspaceId)!;

    // Ensure the wall clock has advanced past `before` so a real
    // write would be observable. Date.now() has millisecond
    // resolution on every supported platform, but back-to-back
    // calls can land on the same tick.
    const start = Date.now();
    while (Date.now() <= before) {
      // spin until next ms tick
      if (Date.now() - start > 100) break;
    }

    upsertWorkspaceStatus(workspaceId, { status: "working" });

    const after = readUpdatedAt(tmp, workspaceId)!;
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceIdentity — SQL-side `toWorkspaceId` match.
//
// The lookup pushes the `${project}-${branch.replaceAll("/", "-")}`
// computation into SQL (`project || '-' || REPLACE(branch, '/', '-')`)
// so it can filter server-side instead of scanning every worktree in
// JS. Exercise the slash-in-branch case to prove the REPLACE works.
// ---------------------------------------------------------------------------

describe("upsertWorkspaceStatus — identity lookup with slashes in branch", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-state-slash-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
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

  it("resolves a workspaceId whose branch contains slashes", () => {
    const projectName = "demo";
    const branch = "feat/nested/thing";
    const wtPath = join(tmp, "worktrees", "demo-feat-nested-thing");
    const workspaceId = toWorkspaceId(projectName, branch);
    // Sanity: helper collapses slashes to dashes.
    expect(workspaceId).toBe("demo-feat-nested-thing");

    seedState(tmp, {
      projects: [
        {
          name: projectName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    // Stale row with empty identity — forces the heal path through
    // the new SQL-backed `resolveWorkspaceIdentity`.
    seedWorkspaceStatuses(tmp, [
      {
        workspaceId,
        project: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorkspaceStatus(workspaceId, { status: "waiting" });

    expect(healed.project).toBe(projectName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);
  });
});
