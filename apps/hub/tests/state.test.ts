import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { getWorktreeStatus, upsertWorktreeStatus } from "../src/server/services/state";
import { seedState, seedWorktreeStatuses } from "./helpers/seed-state";

// Read `updated_at` directly from SQLite — used to assert that the
// no-op write skip actually prevents writes (rather than the higher-level
// row staying logically identical).
function readUpdatedAt(tmpHome: string, worktreeId: string): number | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite
      .prepare("SELECT updated_at FROM worktree_statuses WHERE worktree_id = ?")
      .get(worktreeId) as { updated_at: number } | undefined;
    return row?.updated_at;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// upsertWorktreeStatus — heals stale rows with empty identity fields.
//
// The desktop EditorPicker dropdown (right sidepanel header) is gated on a non-empty
// `worktreePath` (see DesktopTitleBar.tsx). Some rows in older Band
// installs were inserted with `worktreePath = ""` (agent started before
// the repo's worktree was persisted, or rows left behind by a prior
// version). Without healing, those worktrees never get the dropdown
// even though the worktree path is recoverable from the repos /
// worktrees tables.
// ---------------------------------------------------------------------------

describe("upsertWorktreeStatus — identity healing", () => {
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

  it("heals an existing row with empty repo/branch/worktreePath", () => {
    const repoName = "kbhq";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "kbhq-main");
    const worktreeId = toWorktreeId(repoName, branch);

    // Repo state has a real worktree for this worktreeId.
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

    // worktree_statuses row exists but with empty identity fields,
    // mirroring the user-reported real-world state.
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorktreeStatus(worktreeId, { status: "waiting" });

    expect(healed.repo).toBe(repoName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);

    // Round-trip via getWorktreeStatus to make sure the update was
    // actually written to the row, not just returned in-memory.
    const persisted = getWorktreeStatus(worktreeId);
    expect(persisted).not.toBeNull();
    expect(persisted!.repo).toBe(repoName);
    expect(persisted!.branch).toBe(branch);
    expect(persisted!.worktreePath).toBe(wtPath);
  });

  it("heals only the empty subset of identity fields", () => {
    const repoName = "kbhq";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "kbhq-main");
    const worktreeId = toWorktreeId(repoName, branch);

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

    // Pre-existing row has correct repo + branch but lost its
    // worktreePath somehow. Only worktreePath should be healed; the
    // already-correct fields must be left alone.
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: repoName,
        branch,
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorktreeStatus(worktreeId, { status: "waiting" });

    expect(healed.repo).toBe(repoName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);
  });

  it("does not overwrite non-empty worktreePath even if state.json would resolve differently", () => {
    const repoName = "kbhq";
    const branch = "main";
    const staleButValidPath = "/tmp/some-old-cached-worktree-path";
    const newPathInState = join(tmp, "worktrees", "kbhq-main");
    const worktreeId = toWorktreeId(repoName, branch);

    // state.json (repos/worktrees DB) currently resolves the
    // worktree to a different path. We should NOT clobber the row.
    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "kbhq"),
          defaultBranch: "main",
          worktrees: [{ branch, path: newPathInState }],
        },
      ],
    });

    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: repoName,
        branch,
        worktreePath: staleButValidPath,
        agentStatus: "waiting",
      },
    ]);

    const result = upsertWorktreeStatus(worktreeId, { status: "waiting" });

    // worktreePath stays at the (non-empty) seeded value — healing is
    // conservative and never overwrites correct data.
    expect(result.worktreePath).toBe(staleButValidPath);
    expect(result.repo).toBe(repoName);
    expect(result.branch).toBe(branch);
  });

  it("leaves an existing row alone when repo/worktrees DB has no matching entry", () => {
    const worktreeId = "unknown-repo-main";

    // No repos/worktrees seeded — resolveWorktreeIdentity returns
    // null, so the row stays empty (no spurious writes).
    seedState(tmp, { repos: [] });
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const result = upsertWorktreeStatus(worktreeId, { status: "waiting" });

    expect(result.repo).toBe("");
    expect(result.branch).toBe("");
    expect(result.worktreePath).toBe("");
  });
});

// ---------------------------------------------------------------------------
// upsertWorktreeStatus — no-op write skip.
//
// The status poller calls `upsertWorktreeStatus(_, { status: "waiting" })`
// on every tick for every idle worktree; without a no-op guard each tick
// produces a WAL frame just to bump `updatedAt`, which nothing reads.
// ---------------------------------------------------------------------------

describe("upsertWorktreeStatus — no-op write skip", () => {
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
    const repoName = "demo";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "demo-main");
    const worktreeId = toWorktreeId(repoName, branch);

    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    // Seed a fully-populated row so no healing or status change is needed.
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: repoName,
        branch,
        worktreePath: wtPath,
        agentStatus: "waiting",
        agentLastActivity: "",
      },
    ]);

    const before = readUpdatedAt(tmp, worktreeId);
    expect(before).toBeDefined();

    upsertWorktreeStatus(worktreeId, { status: "waiting" });

    const after = readUpdatedAt(tmp, worktreeId);
    // updated_at must be byte-identical — no UPDATE was issued.
    expect(after).toBe(before);
  });

  it("does bump updated_at when status changes", () => {
    const repoName = "demo";
    const branch = "main";
    const wtPath = join(tmp, "worktrees", "demo-main");
    const worktreeId = toWorktreeId(repoName, branch);

    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    // Seed `updated_at` far in the past so any real write is
    // observable without depending on wall-clock progression between
    // the seed and the upsert (which on a loaded CI host can land on
    // the same millisecond as `Date.now()` inside upsert).
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: repoName,
        branch,
        worktreePath: wtPath,
        agentStatus: "waiting",
        updatedAt: 0,
      },
    ]);

    expect(readUpdatedAt(tmp, worktreeId)).toBe(0);

    upsertWorktreeStatus(worktreeId, { status: "working" });

    const after = readUpdatedAt(tmp, worktreeId)!;
    expect(after).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveWorktreeIdentity — SQL-side `toWorktreeId` match.
//
// The lookup pushes the `${repo}-${branch.replaceAll("/", "-")}`
// computation into SQL (`repo || '-' || REPLACE(branch, '/', '-')`)
// so it can filter server-side instead of scanning every worktree in
// JS. Exercise the slash-in-branch case to prove the REPLACE works.
// ---------------------------------------------------------------------------

describe("upsertWorktreeStatus — identity lookup with slashes in branch", () => {
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

  it("resolves a worktreeId whose branch contains slashes", () => {
    const repoName = "demo";
    const branch = "feat/nested/thing";
    const wtPath = join(tmp, "worktrees", "demo-feat-nested-thing");
    const worktreeId = toWorktreeId(repoName, branch);
    // Sanity: helper collapses slashes to dashes.
    expect(worktreeId).toBe("demo-feat-nested-thing");

    seedState(tmp, {
      repos: [
        {
          name: repoName,
          path: join(tmp, "repos", "demo"),
          defaultBranch: "main",
          worktrees: [{ branch, path: wtPath }],
        },
      ],
    });

    // Stale row with empty identity — forces the heal path through
    // the new SQL-backed `resolveWorktreeIdentity`.
    seedWorktreeStatuses(tmp, [
      {
        worktreeId,
        repo: "",
        branch: "",
        worktreePath: "",
        agentStatus: "waiting",
      },
    ]);

    const healed = upsertWorktreeStatus(worktreeId, { status: "waiting" });

    expect(healed.repo).toBe(repoName);
    expect(healed.branch).toBe(branch);
    expect(healed.worktreePath).toBe(wtPath);
  });
});
