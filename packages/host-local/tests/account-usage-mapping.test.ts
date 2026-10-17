import assert from "node:assert/strict";
import { test } from "node:test";

import { mapClaudeUsage } from "../src/usage/claude-usage.ts";
import { mapCodexUsage } from "../src/usage/codex-usage.ts";

const reset = "2026-10-14T12:00:00.000Z";
const resetMs = Date.parse(reset);

test("claude: five hour, weekly and the scoped Fable limit", () => {
  const windows = mapClaudeUsage({
    five_hour: { utilization: 17, resets_at: reset },
    seven_day: { utilization: 3, resets_at: reset },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 0,
        resets_at: reset,
        scope: { model: { display_name: "Fable" } },
      },
      {
        kind: "weekly_scoped",
        percent: 77,
        resets_at: reset,
        scope: { model: { display_name: "Opus" } },
      },
    ],
  });
  assert.deepEqual(windows, [
    { label: "5h", percent: 17, resetsAt: resetMs },
    { label: "wk", percent: 3, resetsAt: resetMs },
    { label: "Fable", percent: 0, resetsAt: resetMs },
  ]);
});

test("claude: the top-level Fable spellings", () => {
  for (const key of ["fable_weekly", "fable_seven_day", "seven_day_fable"] as const) {
    const windows = mapClaudeUsage({
      seven_day: { utilization: 1 },
      [key]: { used_percentage: 42, resets_at: resetMs },
    });
    assert.deepEqual(windows.at(-1), { label: "Fable", percent: 42, resetsAt: resetMs }, key);
  }
});

test("claude: clamps, reads epoch seconds and drops windows without a percent", () => {
  const windows = mapClaudeUsage({
    five_hour: { utilization: 140, resets_at: 1_800_000_000 },
    seven_day: { resets_at: reset },
    limits: null,
  });
  assert.deepEqual(windows, [{ label: "5h", percent: 100, resetsAt: 1_800_000_000_000 }]);
});

test("claude: a changed shape gives no windows", () => {
  assert.deepEqual(mapClaudeUsage({}), []);
  assert.deepEqual(mapClaudeUsage({ five_hour: "oops" as never }), []);
});

test("codex: windows are labelled by their length, with order as the fallback", () => {
  assert.deepEqual(
    mapCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 604800,
          reset_at: 1_800_100_000,
        },
      },
    }),
    [
      { label: "5h", percent: 10, resetsAt: 1_800_000_000_000 },
      { label: "wk", percent: 20, resetsAt: 1_800_100_000_000 },
    ],
  );
  // A free plan reports only a weekly window as the primary one.
  assert.deepEqual(
    mapCodexUsage({
      rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
    }),
    [{ label: "wk", percent: 5, resetsAt: null }],
  );
  assert.deepEqual(mapCodexUsage({ rate_limit: null }), []);
});
