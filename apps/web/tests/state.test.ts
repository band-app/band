import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/lib/db/connection";
import { getWorkspaceStatus, upsertWorkspaceStatus } from "../src/lib/state";
import { seedState, seedWorkspaceStatuses } from "./helpers/seed-state";

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
