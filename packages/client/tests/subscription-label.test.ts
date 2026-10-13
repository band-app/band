import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWatch, formatExpiry } from "../src/subscription-label.ts";

describe("describeWatch", () => {
  it("names a pull request, CI, a cron timer and a webhook", () => {
    assert.deepEqual(describeWatch({ id: "1", source: "github", filterKey: "github:pr:o/r#3" }), {
      source: "GitHub",
      watches: "PR o/r#3",
    });
    assert.deepEqual(
      describeWatch({ id: "1", source: "github", filterKey: "github:ci:o/r@main" }),
      { source: "GitHub", watches: "CI on o/r@main" },
    );
    assert.deepEqual(
      describeWatch({ id: "1", source: "timer", filterKey: "timer:1", cron: "*/5 * * * *" }),
      { source: "Timer", watches: "cron */5 * * * *" },
    );
    assert.deepEqual(describeWatch({ id: "w1", source: "webhook", filterKey: "webhook:w1" }), {
      source: "Webhook",
      watches: "/api/hooks/w1",
    });
  });
});

describe("formatExpiry", () => {
  it("uses the largest whole unit", () => {
    const now = 1_000_000;
    assert.equal(formatExpiry(now - 1, now), "expired");
    assert.equal(formatExpiry(now + 2 * 86_400_000, now), "expires in 2d");
    assert.equal(formatExpiry(now + 3 * 3_600_000, now), "expires in 3h");
    assert.equal(formatExpiry(now + 10_000, now), "expires in 1m");
  });
});
