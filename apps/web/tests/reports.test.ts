// Integration tests for the Reports API (issue #425).
//
// Boots the real server, seeds `usage_events` directly through the
// production SQLite migrations, and calls `trpc.reports.summary` over
// HTTP. The DB is the real production schema reached through the same
// migrate path the server boots through, so any drift between schema and
// queries fails here.
//
// Mirrors the patterns in `tasks-crud.test.ts` and `task-cleanup.test.ts`:
// same `startServer` shape, same `openDb` helper, same `trpcQuery` HTTP
// shape. No tRPC mocking, no MSW — production code path end-to-end.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "reports-test-token";
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
// Server lifecycle — same shape as tasks-crud.test.ts
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-reports-test-")));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const { tmpHome } = opts;
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home: tmpHome,
          close: () =>
            new Promise<void>((r) => {
              const fallback = setTimeout(() => {
                child.kill("SIGKILL");
              }, 5_000);
              child.on("exit", () => {
                clearTimeout(fallback);
                r();
              });
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// DB seeding — direct INSERTs into `usage_events`. Mirrors how task-service
// writes rows in production (per-turn token row + cost-only session-result
// row) but bypasses the in-memory agent stream so the test can deterministically
// shape what the aggregate sees.
// ---------------------------------------------------------------------------

function openDb(tmpHome: string): DatabaseSync {
  const dbPath = join(tmpHome, ".band", "band.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

interface SeedUsageEvent {
  taskId: string;
  /** Optional — defaults to `taskId`. The Reports aggregate counts
   *  DISTINCT `session_id` for "sessions", so multiple rows under one
   *  `taskId` would collapse to one session by default. Set explicitly
   *  to test rows that share a task but split across sessions. */
  sessionId?: string;
  workspaceId: string;
  project: string;
  codingAgentId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  capturedAt: number;
}

function seedUsageEvent(sqlite: DatabaseSync, ev: SeedUsageEvent): void {
  sqlite
    .prepare(
      `INSERT INTO usage_events
        (task_id, session_id, workspace_id, project, coding_agent_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_output_tokens, cost_usd, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ev.taskId,
      ev.sessionId ?? ev.taskId,
      ev.workspaceId,
      ev.project,
      ev.codingAgentId ?? null,
      ev.provider ?? null,
      ev.model ?? null,
      ev.inputTokens ?? 0,
      ev.outputTokens ?? 0,
      ev.cacheReadTokens ?? 0,
      ev.cacheCreationTokens ?? 0,
      0,
      ev.costUsd ?? 0,
      ev.capturedAt,
    );
}

// ---------------------------------------------------------------------------
// Aggregate shape returned by reports.summary
// ---------------------------------------------------------------------------

interface AggregateRow {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
}

interface ReportsSummary {
  fromMs: number;
  toMs: number;
  total: AggregateRow;
  byModel: AggregateRow[];
  byProject: AggregateRow[];
  byAgent: AggregateRow[];
  byWorkspace: AggregateRow[];
  byBucket: AggregateRow[];
  bucketSize: "day" | "week" | "month";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reports.summary (issue #425)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Anchor the seed timestamps far enough in the past that the test
  // doesn't race with anything time-sensitive (the prune sweep runs on
  // a 30-day window, and a usage row at "now - 5h" is well inside it).
  // Snapping to start-of-day on the test machine keeps the byBucket
  // bucketing assertion deterministic regardless of when the suite runs.
  const dayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const sqlite = openDb(tmpHome);
    try {
      // 2 Claude/sonnet tasks with cost, spread across 3 days. Each task
      // emits a per-turn token row + a cost-only row, mirroring how
      // task-service writes them in production.
      // Day 0 (today) — task A, two turns + cost
      seedUsageEvent(sqlite, {
        taskId: "tsk_a",
        workspaceId: "band-feat",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 5_000,
        cacheCreationTokens: 0,
        capturedAt: dayStart + 9 * 60 * 60 * 1000, // 9am today
      });
      seedUsageEvent(sqlite, {
        taskId: "tsk_a",
        workspaceId: "band-feat",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 800,
        outputTokens: 300,
        cacheReadTokens: 6_000,
        capturedAt: dayStart + 10 * 60 * 60 * 1000,
      });
      seedUsageEvent(sqlite, {
        taskId: "tsk_a",
        workspaceId: "band-feat",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-sonnet-4-6",
        costUsd: 0.0421,
        capturedAt: dayStart + 10 * 60 * 60 * 1000 + 1,
      });

      // Day -1 — task B, single turn + cost on sonnet, different workspace
      seedUsageEvent(sqlite, {
        taskId: "tsk_b",
        workspaceId: "band-main",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 500,
        outputTokens: 100,
        capturedAt: dayStart - DAY_MS + 15 * 60 * 60 * 1000,
      });
      seedUsageEvent(sqlite, {
        taskId: "tsk_b",
        workspaceId: "band-main",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-sonnet-4-6",
        costUsd: 0.0123,
        capturedAt: dayStart - DAY_MS + 15 * 60 * 60 * 1000 + 1,
      });

      // Day -2 — task C, Codex with zero cost, different project
      seedUsageEvent(sqlite, {
        taskId: "tsk_c",
        workspaceId: "other-main",
        project: "other",
        codingAgentId: "codex",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 2_000,
        outputTokens: 600,
        capturedAt: dayStart - 2 * DAY_MS + 12 * 60 * 60 * 1000,
      });

      // Way old row — outside the 7-day window, must NOT show up
      seedUsageEvent(sqlite, {
        taskId: "tsk_old",
        workspaceId: "band-main",
        project: "band",
        codingAgentId: "claude-code",
        provider: "claude",
        model: "claude-opus-4-7",
        inputTokens: 99_999,
        outputTokens: 99_999,
        costUsd: 9.99,
        capturedAt: dayStart - 30 * DAY_MS,
      });
    } finally {
      sqlite.close();
    }

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("aggregates totals across the last 7 days", async () => {
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: dayStart - 6 * DAY_MS,
      toMs: dayStart + DAY_MS,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<ReportsSummary>(res);

    // Total cost = 0.0421 + 0.0123 = 0.0544 (the $9.99 row from 30d ago
    // is excluded by the half-open range).
    expect(data.total.costUsd).toBeCloseTo(0.0544, 4);
    // 3 distinct tasks contributed in the window (tsk_a, tsk_b, tsk_c).
    expect(data.total.sessionCount).toBe(3);
    // Sum of input tokens — 1000 + 800 + 500 + 2000 = 4300
    expect(data.total.inputTokens).toBe(4_300);
    // Output tokens — 200 + 300 + 100 + 600 = 1200
    expect(data.total.outputTokens).toBe(1_200);
    // Cache read tokens — 5000 + 6000 = 11000
    expect(data.total.cacheReadTokens).toBe(11_000);
    // Total tokens = input + output + cacheRead + cacheCreate + reasoning
    expect(data.total.totalTokens).toBe(4_300 + 1_200 + 11_000);
  });

  it("groups by model with one row per distinct model", async () => {
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: dayStart - 6 * DAY_MS,
      toMs: dayStart + DAY_MS,
    });
    const data = await trpcData<ReportsSummary>(res);

    const models = new Map(data.byModel.map((r) => [r.bucket, r]));
    expect(new Set(models.keys())).toEqual(new Set(["claude-sonnet-4-6", "gpt-5"]));

    const sonnet = models.get("claude-sonnet-4-6")!;
    expect(sonnet.costUsd).toBeCloseTo(0.0544, 4);
    expect(sonnet.sessionCount).toBe(2); // tsk_a, tsk_b

    const gpt5 = models.get("gpt-5")!;
    expect(gpt5.costUsd).toBe(0); // codex doesn't report cost
    expect(gpt5.sessionCount).toBe(1);
  });

  it("groups by project, agent, and workspace", async () => {
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: dayStart - 6 * DAY_MS,
      toMs: dayStart + DAY_MS,
    });
    const data = await trpcData<ReportsSummary>(res);

    const projects = new Map(data.byProject.map((r) => [r.bucket, r]));
    expect(new Set(projects.keys())).toEqual(new Set(["band", "other"]));
    expect(projects.get("band")!.sessionCount).toBe(2); // tsk_a + tsk_b
    expect(projects.get("other")!.sessionCount).toBe(1);

    const agents = new Map(data.byAgent.map((r) => [r.bucket, r]));
    expect(new Set(agents.keys())).toEqual(new Set(["claude-code", "codex"]));
    expect(agents.get("claude-code")!.costUsd).toBeCloseTo(0.0544, 4);
    expect(agents.get("codex")!.costUsd).toBe(0);

    const workspaces = new Map(data.byWorkspace.map((r) => [r.bucket, r]));
    expect(new Set(workspaces.keys())).toEqual(new Set(["band-feat", "band-main", "other-main"]));
  });

  it("buckets the daily cost trend by local-time day", async () => {
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: dayStart - 6 * DAY_MS,
      toMs: dayStart + DAY_MS,
    });
    const data = await trpcData<ReportsSummary>(res);

    // Three days have rows in the window — tsk_a today, tsk_b yesterday,
    // tsk_c two days ago. The buckets are YYYY-MM-DD strings; we don't
    // pin the literal date strings (test machine TZ would couple us to
    // a clock), but we do pin the count and that today's bucket has the
    // larger cost row. A 7-day range stays under the 60-day "day" bucket
    // threshold from `pickBucket`, so we also assert that.
    expect(data.bucketSize).toBe("day");
    expect(data.byBucket.length).toBe(3);
    const totalChartedCost = data.byBucket.reduce((sum, r) => sum + r.costUsd, 0);
    expect(totalChartedCost).toBeCloseTo(0.0544, 4);
  });

  it("excludes rows outside the half-open range", async () => {
    // 1-day window: today only. tsk_b's "yesterday" row and tsk_c's "two
    // days ago" row must be excluded.
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: dayStart,
      toMs: dayStart + DAY_MS,
    });
    const data = await trpcData<ReportsSummary>(res);

    expect(data.total.sessionCount).toBe(1);
    expect(data.total.costUsd).toBeCloseTo(0.0421, 4);
    expect(data.byBucket.length).toBe(1);
  });

  it("returns zeroed totals for an empty range", async () => {
    // 100 years from now — guaranteed empty.
    const farFuture = Date.now() + 100 * 365 * DAY_MS;
    const res = await trpcQuery(server.url, "reports.summary", {
      fromMs: farFuture,
      toMs: farFuture + DAY_MS,
    });
    const data = await trpcData<ReportsSummary>(res);

    expect(data.total.costUsd).toBe(0);
    expect(data.total.sessionCount).toBe(0);
    expect(data.byModel).toEqual([]);
    expect(data.byBucket).toEqual([]);
  });
});
