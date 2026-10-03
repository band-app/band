// Integration tests for the user-configurable usage-events retention
// window (issue #425).
//
// `pruneOldUsageEvents` is the workhorse: it's called on boot and on
// every 24h interval, and the window it uses comes from
// `settings.usageRetentionDays` (falling back to
// `USAGE_EVENT_RETENTION_MS` = 365 days). The tests below seed
// `usage_events` directly via the real schema, write `settings.json`
// via the real `SettingsQueries`, then call `pruneOldUsageEvents`
// in-process and assert which rows survive — i.e. the prune sees the
// settings flow end-to-end without booting the server.
//
// Same shape as `workspace-queries.test.ts`: tmp BAND_HOME per test,
// `closeDb()` between tests to reset the module-level singleton.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/server/infra/db/connection";
import { SettingsQueries } from "../src/server/infra/db/queries/settings";
import {
  pruneOldUsageEvents,
  USAGE_EVENT_RETENTION_MS,
  UsageEventQueries,
} from "../src/server/infra/db/queries/usage-events";
import { usageEvents as usageEventsTable } from "../src/server/infra/db/schema";
import { settingsUpdateInput } from "../src/server/services/settings-service";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedEvent(opts: {
  taskId: string;
  workspaceId: string;
  project: string;
  capturedAt: number;
}): void {
  new UsageEventQueries().insert({
    taskId: opts.taskId,
    workspaceId: opts.workspaceId,
    project: opts.project,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: 0,
    capturedAt: opts.capturedAt,
  });
}

function listEventIds(): number[] {
  const rows = getDb()
    .select({ id: usageEventsTable.id })
    .from(usageEventsTable)
    .orderBy(asc(usageEventsTable.id))
    .all();
  return rows.map((r) => r.id);
}

describe("usage-events retention setting", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-usage-retention-test-")));
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

  it("falls back to 365 days when settings.usageRetentionDays is unset", () => {
    const now = Date.now();
    // Two rows: one inside the 365-day window, one just outside.
    seedEvent({
      taskId: "fresh",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 30 * DAY_MS,
    });
    seedEvent({
      taskId: "ancient",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 400 * DAY_MS,
    });
    expect(listEventIds()).toHaveLength(2);

    const removed = pruneOldUsageEvents();

    expect(removed).toBe(1);
    expect(listEventIds()).toHaveLength(1);
    // Sanity check on the documented default — if anyone bumps the
    // constant in usage-events.ts, this assertion forces them to
    // update the test too.
    expect(USAGE_EVENT_RETENTION_MS).toBe(365 * DAY_MS);
  });

  it("honours a user-configured retention window from settings", () => {
    const now = Date.now();
    new SettingsQueries().save({ usageRetentionDays: 30 });

    // 5 d old — survives.
    seedEvent({
      taskId: "young",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 5 * DAY_MS,
    });
    // 60 d old — would survive the 365-day default, must be pruned by
    // the 30-day override.
    seedEvent({
      taskId: "old",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 60 * DAY_MS,
    });

    const removed = pruneOldUsageEvents();

    expect(removed).toBe(1);
    expect(listEventIds()).toHaveLength(1);
  });

  it("ignores a malformed retention value and falls back to the default", () => {
    const now = Date.now();
    // Save() goes through SettingsQueries directly, bypassing Zod —
    // simulates a hand-edited settings.json that put garbage in the
    // field. The prune must not blow up; it must use the 365-day
    // default.
    new SettingsQueries().save({ usageRetentionDays: -42 });

    seedEvent({
      taskId: "fresh",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 30 * DAY_MS,
    });
    seedEvent({
      taskId: "ancient",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 400 * DAY_MS,
    });

    const removed = pruneOldUsageEvents();

    // 365-day window applied: only "ancient" goes.
    expect(removed).toBe(1);
    expect(listEventIds()).toHaveLength(1);
  });

  it("respects an explicit retentionMs override, ignoring settings", () => {
    const now = Date.now();
    // Setting says 365, but caller passes 10 days — test that the
    // explicit argument wins (boot path uses this for deterministic
    // windows).
    new SettingsQueries().save({ usageRetentionDays: 365 });

    seedEvent({
      taskId: "5d",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 5 * DAY_MS,
    });
    seedEvent({
      taskId: "20d",
      workspaceId: "w",
      project: "p",
      capturedAt: now - 20 * DAY_MS,
    });

    const removed = pruneOldUsageEvents(10 * DAY_MS);

    expect(removed).toBe(1);
    expect(listEventIds()).toHaveLength(1);
  });
});

describe("usage retention Zod validation (settings router contract)", () => {
  // The settings tRPC procedure validates incoming patches against
  // `settingsUpdateInput`. These tests pin the bounds so a future
  // schema change (e.g. lowering the max) is visible.

  it("accepts an integer day count in range", () => {
    const result = settingsUpdateInput.safeParse({ usageRetentionDays: 30 });
    expect(result.success).toBe(true);
  });

  it("rejects a zero-day window", () => {
    const result = settingsUpdateInput.safeParse({ usageRetentionDays: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a value above 3650 days", () => {
    const result = settingsUpdateInput.safeParse({ usageRetentionDays: 3651 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer day count", () => {
    const result = settingsUpdateInput.safeParse({ usageRetentionDays: 30.5 });
    expect(result.success).toBe(false);
  });

  it("accepts an undefined value (omitted field)", () => {
    const result = settingsUpdateInput.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts usagePollingEnabled: true | false", () => {
    expect(settingsUpdateInput.safeParse({ usagePollingEnabled: true }).success).toBe(true);
    expect(settingsUpdateInput.safeParse({ usagePollingEnabled: false }).success).toBe(true);
  });

  it("rejects a non-boolean usagePollingEnabled value", () => {
    // A typo'd payload (e.g. desktop shell writing "off" instead of
    // false) must fail loud rather than silently disable polling.
    const result = settingsUpdateInput.safeParse({ usagePollingEnabled: "off" });
    expect(result.success).toBe(false);
  });
});
