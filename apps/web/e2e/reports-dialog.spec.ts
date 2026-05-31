/**
 * End-to-end coverage for the Reports dialog (issue #425).
 *
 * Boots the production server bundle against a fresh tmp `~/.band/`,
 * seeds `usage_events` directly via the real SQLite migrations, then
 * drives the React UI through the `ReportsDialog` page object. No tRPC
 * mocking — the dialog reads via `trpc.reports.summary` against the
 * real server reading the real DB.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ReportsDialog } from "./pages/ReportsDialog";

const TOKEN = "e2e-reports-dialog-token";

const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  "..",
  "src",
  "server",
  "infra",
  "db",
  "migrations",
);

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string;

// Anchor to start-of-day on the test host so the byBucket day buckets are
// stable across timezones and don't depend on wall-clock at run time.
//
// Using `dayStart` directly means seeded "today" data lives at
// dayStart + 9h — which is in the FUTURE if the test runs before
// local 9am, and `reports.summary`'s `captured_at < toMs (now)`
// filter excludes it (caused flake when tests ran in the early
// morning). Anchor to `now - 3h` instead so "today" data is always
// in the past relative to wall-clock when the test runs.
const nowMs = Date.now();
const TODAY_ANCHOR = nowMs - 3 * 60 * 60 * 1000;
const dayStart = (() => {
  const d = new Date(TODAY_ANCHOR);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

function openDb(home: string): DatabaseSync {
  const dbPath = join(home, ".band", "band.db");
  mkdirSync(join(home, ".band"), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

interface SeedRow {
  taskId: string;
  workspaceId: string;
  project: string;
  codingAgentId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  capturedAt: number;
}

function seedUsageEvent(sqlite: DatabaseSync, row: SeedRow): void {
  sqlite
    .prepare(
      `INSERT INTO usage_events
        (task_id, session_id, workspace_id, project, coding_agent_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_output_tokens, cost_usd, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.taskId,
      // Test fixtures use one session per task; mirror taskId into
      // session_id so the "Sessions" stat (COUNT DISTINCT session_id)
      // counts these rows correctly.
      row.taskId,
      row.workspaceId,
      row.project,
      row.codingAgentId ?? null,
      row.provider ?? null,
      row.model ?? null,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheReadTokens ?? 0,
      0,
      0,
      row.costUsd ?? 0,
      row.capturedAt,
    );
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  const sqlite = openDb(tmpHome);
  try {
    // Today — Claude Sonnet, two turns + cost
    seedUsageEvent(sqlite, {
      taskId: "tsk_a",
      workspaceId: "band-feat",
      project: "band",
      codingAgentId: "claude-code",
      provider: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 5_000,
      // Both rows anchored to (now - 3h), guaranteed past wall-clock.
      capturedAt: TODAY_ANCHOR,
    });
    seedUsageEvent(sqlite, {
      taskId: "tsk_a",
      workspaceId: "band-feat",
      project: "band",
      codingAgentId: "claude-code",
      provider: "claude",
      model: "claude-sonnet-4-6",
      costUsd: 0.05,
      capturedAt: TODAY_ANCHOR + 1,
    });

    // Yesterday — Codex, zero cost, different project
    seedUsageEvent(sqlite, {
      taskId: "tsk_b",
      workspaceId: "other-main",
      project: "other",
      codingAgentId: "codex",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 800,
      outputTokens: 200,
      // Yesterday at noon — guaranteed past today's anchor.
      capturedAt: dayStart - 12 * 60 * 60 * 1000,
    });
  } finally {
    sqlite.close();
  }

  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (typeof server !== "undefined") await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Reports dialog (issue #425)", () => {
  test("opens from the menu and renders cards, chart and breakdowns", async ({ page }) => {
    const reports = new ReportsDialog(page, server.url, TOKEN);

    await reports.open();
    await reports.waitForReady();

    // Top cards: total cost is $0.05 (only Claude contributes cost),
    // total tasks is 2 (one per seeded taskId), top model is sonnet
    // because gpt-5 has $0 cost.
    await expect(reports.totalCost).toContainText("$0.05");
    await expect(reports.totalSessions).toContainText("2");
    await expect(reports.topModel).toContainText("claude-sonnet-4-6");

    // Chart container is rendered with an SVG inside (recharts wraps
    // the chart in a ResponsiveContainer that produces an SVG once it
    // has mounted into the layout).
    await expect(reports.chart).toBeVisible();
    await expect(reports.chart.locator("svg")).toBeVisible({ timeout: 10_000 });

    // Breakdown tables: model lists sonnet + gpt-5, agent lists claude-code
    // + codex, project lists band + other, workspace lists band-feat +
    // other-main. Cost cell for gpt-5/codex/other shows the em-dash
    // placeholder, not "$0.00".
    await expect(reports.byModel).toContainText("claude-sonnet-4-6");
    await expect(reports.byModel).toContainText("gpt-5");
    await expect(reports.byAgent).toContainText("claude-code");
    await expect(reports.byAgent).toContainText("codex");
    await expect(reports.byProject).toContainText("band");
    await expect(reports.byProject).toContainText("other");
    await expect(reports.byWorkspace).toContainText("band-feat");
    await expect(reports.byWorkspace).toContainText("other-main");

    // The em-dash for cost-unavailable rows. We assert presence on the
    // by-model table (Codex/gpt-5 row); it's the most precisely scoped
    // place to look because the same character is also used in the
    // % cost column for $0 totals.
    await expect(reports.byModel).toContainText("—");
  });

  test("does not overflow horizontally on a narrow mobile viewport", async ({ page }) => {
    // Regression for the mobile layout bug — tables inside the breakdown
    // grid used to push the dialog wider than the viewport, hiding the
    // close button off-screen. We assert the dialog's rendered width is
    // at most the viewport width (with a 1px tolerance for sub-pixel
    // rounding) so the fix can't silently regress.
    const reports = new ReportsDialog(page, server.url, TOKEN);
    await page.setViewportSize({ width: 375, height: 800 });

    await reports.open();
    await reports.waitForReady();

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("viewport size unset");

    const dialogBox = await reports.dialog.boundingBox();
    if (!dialogBox) throw new Error("dialog has no bounding box");
    expect(dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);

    // The page <body> shouldn't have grown a horizontal scrollbar either.
    const bodyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(bodyOverflow).toBeLessThanOrEqual(1);

    // Sanity check: the by-model section is still visible inside the
    // viewport (i.e. content didn't disappear under `overflow-hidden`).
    await expect(reports.byModel).toBeVisible();
  });

  test("switching to Today narrows the range and drops yesterday's row", async ({ page }) => {
    const reports = new ReportsDialog(page, server.url, TOKEN);
    await reports.open();
    await reports.waitForReady();

    // Default "Last 7 days" — both seeded tasks are inside the window.
    await expect(reports.totalSessions).toContainText("2");

    // Switch to "Today" via the Radix Select. The select trigger
    // exposes its currently-displayed value as text, so the click +
    // option flow is the standard Radix pattern.
    await reports.periodSelect.click();
    await page.getByRole("option", { name: "Today" }).click();

    // tsk_b was on "yesterday" — it must drop out, leaving only tsk_a.
    await expect(reports.totalSessions).toContainText("1");
    await expect(reports.totalCost).toContainText("$0.05");
    // Codex no longer appears at all in any breakdown for the
    // narrowed range.
    await expect(reports.byAgent).not.toContainText("codex");
  });
});
