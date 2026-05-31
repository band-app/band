// Integration tests for `UsageScannerService` (issue #425).
//
// Exercises the scanner orchestration against a real SQLite database
// (via the production migrations + `UsageEventQueries`). The adapter
// surface (`agent.listSessions` + `agent.getSessionUsage`) is the
// scanner's out-of-process boundary, so the test provides stub
// implementations via the constructor's DI seam. The DB itself is the
// real production schema; the row shape, the `external_key`
// unique-index dedup, and the watermark advance all run through the
// production code.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodingAgent, SessionListItem, SessionUsageSnapshot } from "@band-app/coding-agent";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { UsageEventQueries } from "../src/server/infra/db/queries/usage-events";
import { UsageScanStateQueries } from "../src/server/infra/db/queries/usage-scan-state";
import { UsageScannerService } from "../src/server/infra/usage-scanner/usage-scanner";

const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  "..",
  "src",
  "server",
  "infra",
  "db",
  "migrations",
);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * `bandHome()` in production returns `${HOME}/.band` (or `BAND_HOME`
 * verbatim) — i.e. the band DATA directory, not the user home. Test
 * helpers below treat the passed-in path as the *band-home* directly,
 * so `db = ${bandHomeDir}/band.db`. This matches how the production
 * `getDb()` resolves things and avoids the off-by-one (".band/band.db"
 * vs "band.db") that subtly bit me earlier.
 */
function bootstrapDb(bandHomeDir: string): void {
  mkdirSync(bandHomeDir, { recursive: true });
  const dbPath = join(bandHomeDir, "band.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_FOLDER });
  sqlite.close();
}

function selectAllUsageEvents(bandHomeDir: string): Array<{
  external_key: string | null;
  cost_usd: number;
  input_tokens: number;
  provider: string | null;
  session_id: string | null;
  workspace_id: string;
  project: string;
}> {
  const sqlite = new DatabaseSync(join(bandHomeDir, "band.db"));
  try {
    return sqlite
      .prepare(
        `SELECT external_key, cost_usd, input_tokens, provider, session_id, workspace_id, project
         FROM usage_events ORDER BY id`,
      )
      .all() as Array<{
      external_key: string | null;
      cost_usd: number;
      input_tokens: number;
      provider: string | null;
      session_id: string | null;
      workspace_id: string;
      project: string;
    }>;
  } finally {
    sqlite.close();
  }
}

function watermark(bandHomeDir: string, workspaceId: string, agentType: string): number {
  const sqlite = new DatabaseSync(join(bandHomeDir, "band.db"));
  try {
    const row = sqlite
      .prepare(
        `SELECT last_scanned_updated_at FROM usage_scan_state
         WHERE workspace_id = ? AND agent_type = ?`,
      )
      .get(workspaceId, agentType) as { last_scanned_updated_at: number } | undefined;
    return row?.last_scanned_updated_at ?? 0;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Stub adapter — a real `CodingAgent` shape with only the methods the
// scanner uses. Each test instantiates a fresh one with the sessions /
// usage maps it wants the scanner to see.
// ---------------------------------------------------------------------------

interface StubAdapterOptions {
  sessions: SessionListItem[];
  /** sessionId → snapshot. Missing entries are returned as `null` (the
   *  scanner skips them silently). */
  usageBySession: Record<string, SessionUsageSnapshot>;
}

function makeStubAdapter(opts: StubAdapterOptions): CodingAgent {
  const calls = { listSessions: 0, getSessionUsage: [] as string[] };
  const agent: CodingAgent & { __calls: typeof calls } = {
    name: "Stub",
    supportedFeatures: { costTracking: true, sessionListing: true },
    // eslint-disable-next-line require-yield
    async *runSession() {
      // Not used by the scanner.
    },
    async listSessions() {
      calls.listSessions++;
      return opts.sessions;
    },
    async getSessionUsage(sessionId: string) {
      calls.getSessionUsage.push(sessionId);
      return opts.usageBySession[sessionId] ?? null;
    },
    __calls: calls,
  };
  return agent;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpHome: string;
let originalBandHome: string | undefined;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "band-usage-scanner-test-")));
  bootstrapDb(tmpHome);
  // Point the production `bandHome()` helper at the tmp dir so the
  // `getDb()` lazy connection lands on the same SQLite file we just
  // migrated. The connection is process-singleton — close the previous
  // one (if any) before swapping the env so the next `getDb()` re-opens.
  originalBandHome = process.env.BAND_HOME;
  closeDb();
  process.env.BAND_HOME = tmpHome;
});

afterEach(() => {
  closeDb();
  if (originalBandHome === undefined) {
    delete process.env.BAND_HOME;
  } else {
    process.env.BAND_HOME = originalBandHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UsageScannerService (issue #425)", () => {
  const workspaceId = "band-main";
  const project = "band";
  const worktreePath = "/tmp/band-main";

  // Hour anchors used by the bucket-aware assertions below. UTC-aligned
  // because the scanner snaps to UTC hour starts (`hourStartUtc`).
  const HOUR_MS = 60 * 60 * 1000;
  // 2023-11-14 22:00:00 UTC — anchor for "hour A".
  const HOUR_A = 1_700_000_400_000 - (1_700_000_400_000 % HOUR_MS);
  const HOUR_B = HOUR_A + HOUR_MS;

  it("buckets turns within the same hour into one row and re-upserts on growth", async () => {
    const sessionId = "ses_abc";
    // Two turns inside hour A, sums into ONE bucket row.
    const baseSnap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 60_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 200,
          cacheCreationTokens: 0,
          reasoningOutputTokens: 0,
          costUsd: 0.0042,
        },
        {
          turnIndex: 1,
          capturedAt: HOUR_A + 60_000,
          inputTokens: 80,
          outputTokens: 30,
          costUsd: 0.0017,
        },
      ],
    };
    const sessions: SessionListItem[] = [
      { sessionId, summary: "demo", lastModified: HOUR_A + 60_000 },
    ];

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () =>
        makeStubAdapter({ sessions, usageBySession: { [sessionId]: baseSnap } }),
    });

    await scanner.tick();

    const rowsAfterFirst = selectAllUsageEvents(tmpHome);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0].external_key).toBe(`claude-code:ses_abc:${HOUR_A}:claude-sonnet-4-6`);
    // Sums: 100+80 input, 200 cache, 0.0042+0.0017 cost.
    expect(rowsAfterFirst[0].input_tokens).toBe(180);
    expect(rowsAfterFirst[0].cost_usd).toBeCloseTo(0.0059, 4);
    expect(rowsAfterFirst.every((r) => r.workspace_id === workspaceId)).toBe(true);
    expect(rowsAfterFirst.every((r) => r.project === project)).toBe(true);

    // Watermark advanced to the listing's `lastModified`.
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(HOUR_A + 60_000);

    // Second tick on the same listing — the session's lastModified is
    // not past the watermark, so we skip getSessionUsage entirely.
    await scanner.tick();
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(1);

    // Bump lastModified + add a third turn in the SAME hour. Because
    // the bucket key is per (session, hour, model), the third turn
    // upserts into the existing row — totals REPLACE, not append.
    const grownSnap: SessionUsageSnapshot = {
      ...baseSnap,
      updatedAt: HOUR_A + 120_000,
      turns: [
        ...baseSnap.turns,
        {
          turnIndex: 2,
          capturedAt: HOUR_A + 120_000,
          inputTokens: 60,
          outputTokens: 20,
          costUsd: 0.001,
        },
      ],
    };
    const grownSessions: SessionListItem[] = [
      { sessionId, summary: "demo", lastModified: HOUR_A + 120_000 },
    ];
    const grownScanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () =>
        makeStubAdapter({
          sessions: grownSessions,
          usageBySession: { [sessionId]: grownSnap },
        }),
    });
    await grownScanner.tick();

    const rowsAfterGrowth = selectAllUsageEvents(tmpHome);
    expect(rowsAfterGrowth).toHaveLength(1);
    // Replaced totals: 100+80+60 input, 0.0042+0.0017+0.001 cost.
    expect(rowsAfterGrowth[0].input_tokens).toBe(240);
    expect(rowsAfterGrowth[0].cost_usd).toBeCloseTo(0.0069, 4);
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(HOUR_A + 120_000);
  });

  it("splits turns crossing the hour boundary into separate rows", async () => {
    // One turn in hour A, one in hour B — two rows. Cross-midnight
    // sessions are correct by the same logic.
    const sessionId = "ses_cross";
    const snap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 3_540_000, // 0:59 into hour A
      updatedAt: HOUR_B + 60_000, // 0:01 into hour B
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 3_540_000,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.001,
        },
        {
          turnIndex: 1,
          capturedAt: HOUR_B + 60_000,
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.002,
        },
      ],
    };

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () =>
        makeStubAdapter({
          sessions: [{ sessionId, summary: "", lastModified: HOUR_B + 60_000 }],
          usageBySession: { [sessionId]: snap },
        }),
    });

    await scanner.tick();
    const rows = selectAllUsageEvents(tmpHome);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.external_key).sort();
    expect(keys).toEqual([
      `claude-code:ses_cross:${HOUR_A}:claude-sonnet-4-6`,
      `claude-code:ses_cross:${HOUR_B}:claude-sonnet-4-6`,
    ]);
  });

  it("emits one row per model when a session switches mid-hour", async () => {
    // Codex supports switching models mid-session. The bucket key
    // includes model, so a multi-model hour gets one row per model.
    const sessionId = "ses_codex";
    const snap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "gpt-5",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 120_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.01,
        },
        {
          turnIndex: 1,
          capturedAt: HOUR_A + 60_000,
          model: "o3",
          inputTokens: 50,
          outputTokens: 30,
          costUsd: 0.05,
        },
        {
          turnIndex: 2,
          capturedAt: HOUR_A + 120_000,
          model: "gpt-5",
          inputTokens: 200,
          outputTokens: 40,
          costUsd: 0.02,
        },
      ],
    };

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "codex-default", agentType: "codex" }],
      createWorkspaceAgent: async () =>
        makeStubAdapter({
          sessions: [{ sessionId, summary: "", lastModified: HOUR_A + 120_000 }],
          usageBySession: { [sessionId]: snap },
        }),
    });

    await scanner.tick();
    const rows = selectAllUsageEvents(tmpHome);
    expect(rows).toHaveLength(2);

    const byModel = new Map(rows.map((r) => [r.external_key, r]));
    const gpt5 = byModel.get(`codex:ses_codex:${HOUR_A}:gpt-5`);
    const o3 = byModel.get(`codex:ses_codex:${HOUR_A}:o3`);
    expect(gpt5).toBeDefined();
    expect(o3).toBeDefined();
    expect(gpt5?.input_tokens).toBe(300); // 100 + 200
    expect(gpt5?.cost_usd).toBeCloseTo(0.03, 4); // 0.01 + 0.02
    expect(o3?.input_tokens).toBe(50);
    expect(o3?.cost_usd).toBeCloseTo(0.05, 4);
  });

  it("chunks a large backlog across multiple ticks via maxSessionsPerTick + ASC sort", async () => {
    // Simulate the first-boot scenario: a workspace with 5 historical
    // sessions (this is the bounded test stand-in for hundreds in
    // production). The cap is set to 2, so each tick processes the
    // OLDEST two changed sessions, the watermark advances to the last
    // session in the chunk, and the next tick picks up the remaining
    // three until everything is captured. The sort+chunk+watermark
    // dance proves no session is ever skipped.
    const sessions: SessionListItem[] = [];
    const usageBySession: Record<string, SessionUsageSnapshot> = {};
    // Five sessions, one per hour, oldest first. Out-of-order on the
    // input array to prove the scanner sorts before slicing.
    const baseHour = HOUR_A;
    const sessionMeta = [
      { id: "ses_3", hour: baseHour + 3 * HOUR_MS, cost: 0.03 },
      { id: "ses_0", hour: baseHour + 0 * HOUR_MS, cost: 0.001 },
      { id: "ses_4", hour: baseHour + 4 * HOUR_MS, cost: 0.04 },
      { id: "ses_1", hour: baseHour + 1 * HOUR_MS, cost: 0.01 },
      { id: "ses_2", hour: baseHour + 2 * HOUR_MS, cost: 0.02 },
    ];
    for (const m of sessionMeta) {
      sessions.push({ sessionId: m.id, summary: "", lastModified: m.hour + 1_000 });
      usageBySession[m.id] = {
        sessionId: m.id,
        modelFallback: "claude-sonnet-4-6",
        startedAt: m.hour,
        updatedAt: m.hour + 1_000,
        turns: [
          {
            turnIndex: 0,
            capturedAt: m.hour + 1_000,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: m.cost,
          },
        ],
      };
    }

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () => makeStubAdapter({ sessions, usageBySession }),
      maxSessionsPerTick: 2,
    });

    // Tick 1 — processes ses_0 and ses_1 (oldest two).
    await scanner.tick();
    let rows = selectAllUsageEvents(tmpHome).map((r) => r.session_id);
    expect(rows.sort()).toEqual(["ses_0", "ses_1"]);
    // Watermark advanced to ses_1's lastModified.
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(baseHour + 1 * HOUR_MS + 1_000);

    // Tick 2 — listSessions returns the same 5; the watermark filter
    // drops ses_0 + ses_1 (already processed). Cap of 2 means the
    // next oldest pair (ses_2, ses_3) lands. ses_4 stays deferred.
    await scanner.tick();
    rows = selectAllUsageEvents(tmpHome).map((r) => r.session_id);
    expect(rows.sort()).toEqual(["ses_0", "ses_1", "ses_2", "ses_3"]);
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(baseHour + 3 * HOUR_MS + 1_000);

    // Tick 3 — picks up the last remaining ses_4.
    await scanner.tick();
    rows = selectAllUsageEvents(tmpHome).map((r) => r.session_id);
    expect(rows.sort()).toEqual(["ses_0", "ses_1", "ses_2", "ses_3", "ses_4"]);
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(baseHour + 4 * HOUR_MS + 1_000);

    // Tick 4 — everything's at the watermark; no work, no new rows.
    await scanner.tick();
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(5);
  });

  it("only advances the watermark for workspaces that actually had sessions", async () => {
    // One workspace has activity, the other is empty. Both are walked
    // by `tick()`; only the active one should get its watermark
    // advanced (the empty-workspace watermark stays at 0 so a future
    // restore-from-backup of session files isn't silently swallowed).
    const sessionA = "ses_a";
    const snap: SessionUsageSnapshot = {
      sessionId: sessionA,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 1_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.001,
        },
      ],
    };

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [
        { workspaceId: "band-feat", project: "band", worktreePath: "/tmp/band-feat" },
        { workspaceId: "other-main", project: "other", worktreePath: "/tmp/other-main" },
      ],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async (worktreePath) => {
        if (worktreePath === "/tmp/band-feat") {
          return makeStubAdapter({
            sessions: [{ sessionId: sessionA, summary: "", lastModified: HOUR_A + 1_000 }],
            usageBySession: { [sessionA]: snap },
          });
        }
        // Other workspace has zero sessions on disk.
        return makeStubAdapter({ sessions: [], usageBySession: {} });
      },
    });

    await scanner.tick();

    const rows = selectAllUsageEvents(tmpHome);
    expect(rows).toHaveLength(1);
    expect(rows[0].external_key).toBe(`claude-code:ses_a:${HOUR_A}:claude-sonnet-4-6`);
    expect(rows[0].workspace_id).toBe("band-feat");

    // Other workspace's watermark stays 0 — no sessions observed, so
    // the scanner refused to bump (defensive vs future backfills).
    expect(watermark(tmpHome, "other-main", "claude-code")).toBe(0);
    expect(watermark(tmpHome, "band-feat", "claude-code")).toBe(HOUR_A + 1_000);
  });

  it("skips adapters without getSessionUsage", async () => {
    // Returns an adapter missing the optional getSessionUsage method —
    // the scanner detects the absence and bails before any work.
    const minimalAgent: CodingAgent = {
      name: "Minimal",
      supportedFeatures: { costTracking: false, sessionListing: true },
      // eslint-disable-next-line require-yield
      async *runSession() {},
      async listSessions() {
        return [{ sessionId: "should-not-read", summary: "", lastModified: 1_700_000_000_000 }];
      },
    };

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "minimal", agentType: "minimal" }],
      createWorkspaceAgent: async () => minimalAgent,
    });

    await scanner.tick();
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(0);
    expect(watermark(tmpHome, workspaceId, "minimal")).toBe(0);
  });

  it("tolerates createWorkspaceAgent throwing without aborting other pairs", async () => {
    const sessionId = "ses_ok";
    const snap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 1_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.0001,
        },
      ],
    };

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [
        { agentId: "broken", agentType: "codex" },
        { agentId: "ok", agentType: "claude-code" },
      ],
      createWorkspaceAgent: async (_dir, agentId) => {
        if (agentId === "broken") throw new Error("ENOENT: codex binary not on PATH");
        return makeStubAdapter({
          sessions: [{ sessionId, summary: "", lastModified: HOUR_A + 1_000 }],
          usageBySession: { [sessionId]: snap },
        });
      },
    });

    await scanner.tick();
    const rows = selectAllUsageEvents(tmpHome);
    expect(rows).toHaveLength(1);
    expect(rows[0].external_key).toBe(`claude-code:ses_ok:${HOUR_A}:claude-sonnet-4-6`);
    expect(rows[0].provider).toBe("claude-code");
  });

  it("short-circuits when polling is disabled — no listSessions, no rows", async () => {
    // The dashboard's "Poll for usage data" toggle is wired through
    // `isPollingEnabled`. When disabled, `tick()` must return without
    // touching any of the adapter methods — the whole point is to
    // claw back CPU + subprocess churn. We assert via call counters
    // on the stub adapter that `listSessions` was never invoked.
    const sessionId = "ses_disabled";
    const snap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 1_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.0001,
        },
      ],
    };
    const stub = makeStubAdapter({
      sessions: [{ sessionId, summary: "", lastModified: HOUR_A + 1_000 }],
      usageBySession: { [sessionId]: snap },
    });
    // Surface the call counters for assertion below.
    const calls = (stub as CodingAgent & { __calls: { listSessions: number } }).__calls;

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () => stub,
      isPollingEnabled: () => false,
    });

    await scanner.tick();

    expect(calls.listSessions).toBe(0);
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(0);
    // Watermark untouched — the gate is upstream of any state advance,
    // so flipping the toggle back on later resumes from the same place.
    expect(watermark(tmpHome, workspaceId, "claude-code")).toBe(0);
  });

  it("re-reads polling state each tick so a runtime toggle takes effect", async () => {
    // Mirror the production behaviour: the scanner reads the setting
    // fresh on every tick rather than capturing it in the constructor,
    // so a user can toggle the dashboard switch and see the next tick
    // honour it without restarting the server.
    const sessionId = "ses_toggle";
    const snap: SessionUsageSnapshot = {
      sessionId,
      modelFallback: "claude-sonnet-4-6",
      startedAt: HOUR_A + 1_000,
      updatedAt: HOUR_A + 1_000,
      turns: [
        {
          turnIndex: 0,
          capturedAt: HOUR_A + 1_000,
          inputTokens: 5,
          outputTokens: 5,
          costUsd: 0.0005,
        },
      ],
    };
    let pollingEnabled = false;

    const scanner = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
      listWorkspaces: () => [{ workspaceId, project, worktreePath }],
      listAgents: () => [{ agentId: "claude-code-default", agentType: "claude-code" }],
      createWorkspaceAgent: async () =>
        makeStubAdapter({
          sessions: [{ sessionId, summary: "", lastModified: HOUR_A + 1_000 }],
          usageBySession: { [sessionId]: snap },
        }),
      isPollingEnabled: () => pollingEnabled,
    });

    // First tick: disabled. Nothing happens.
    await scanner.tick();
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(0);

    // Flip the toggle. The next tick must scan.
    pollingEnabled = true;
    await scanner.tick();
    expect(selectAllUsageEvents(tmpHome)).toHaveLength(1);
  });
});
