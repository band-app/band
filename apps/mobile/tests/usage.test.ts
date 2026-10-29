import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountLine,
  formatDuration,
  problemKey,
  providerName,
  roundedPercent,
  rowKey,
  type UsageDataLike,
  usageTone,
  usageView,
  windowResetText,
} from "../src/lib/settings/usage.ts";

const row = {
  provider: "claude",
  account: "a@b.c",
  plan: "Max",
  windows: [{ label: "5h", percent: 42.4, resetsAt: null }],
  hosts: ["mac", "box"],
};
const data: UsageDataLike = { rows: [row], problems: [] };

describe("usage formatting", () => {
  it("picks a tone at 80 and 95 percent", () => {
    assert.equal(usageTone(79.9), "success");
    assert.equal(usageTone(80), "warning");
    assert.equal(usageTone(95), "danger");
  });

  it("rounds and clamps percentages", () => {
    assert.equal(roundedPercent(42.4), 42);
    assert.equal(roundedPercent(130), 100);
    assert.equal(roundedPercent(-3), 0);
  });

  it("formats durations", () => {
    assert.equal(formatDuration(12 * 60_000), "12m");
    assert.equal(formatDuration(127 * 60_000), "2h 7m");
    assert.equal(formatDuration((3 * 1440 + 4 * 60) * 60_000), "3d 4h");
  });

  it("words the reset time", () => {
    assert.equal(windowResetText(null, 0), null);
    assert.equal(windowResetText(0, 1000), "Resets now");
    assert.equal(windowResetText(127 * 60_000, 0), "Resets in 2h 7m");
  });

  it("joins the account and its workers", () => {
    assert.equal(accountLine(row), "a@b.c on mac, box");
    assert.equal(accountLine({ ...row, account: null }), "on mac, box");
  });
});

describe("usageView", () => {
  const base = { pending: false, error: null, refreshError: null };

  it("is loading while the first read is pending", () => {
    assert.equal(usageView({ ...base, data: undefined, pending: true }).kind, "loading");
  });

  it("shows the error when the first load fails", () => {
    assert.deepEqual(usageView({ ...base, data: undefined, error: "boom" }), {
      kind: "error",
      message: "boom",
    });
  });

  it("is empty with no account and no problem", () => {
    assert.equal(usageView({ ...base, data: { rows: [], problems: [] } }).kind, "empty");
  });

  it("lists problems even with no account", () => {
    const problems = [
      { provider: "codex", reason: "no-login", message: "Not logged in on mac", hosts: ["mac"] },
    ];
    const view = usageView({ ...base, data: { rows: [], problems } });
    assert.equal(view.kind, "data");
    assert.equal(view.kind === "data" && view.problems[0]?.message, "Not logged in on mac");
  });

  it("keeps the last data when a refresh fails", () => {
    const view = usageView({ ...base, data, refreshError: "offline" });
    assert.equal(view.kind, "data");
    assert.equal(view.kind === "data" && view.refreshError, "offline");
    assert.equal(view.kind === "data" && view.rows.length, 1);
  });
});

describe("usage keys and names", () => {
  it("names providers and passes unknown ones through", () => {
    assert.equal(providerName("claude"), "Claude");
    assert.equal(providerName("codex"), "Codex");
    assert.equal(providerName("other"), "other");
  });

  it("keys rows by account, else by workers", () => {
    assert.equal(rowKey(row), "claude:a@b.c");
    assert.equal(rowKey({ ...row, account: null }), "claude:mac,box");
  });

  it("keys problems by provider, reason and workers", () => {
    const p = { provider: "codex", reason: "no-login", message: "m", hosts: ["a"] };
    assert.notEqual(problemKey(p), problemKey({ ...p, hosts: ["b"] }));
  });
});
