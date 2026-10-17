import { describe, expect, it } from "vitest";
import { CONTINUED_ICON_WINDOW_MS, continuedIconVisible } from "../src/lib/continued-seen";

// Pure rule with no state to fake: continuation time, seen mark and clock in, visibility out.
// The sidebar behavior is covered by apps/web/e2e/follow-the-work.spec.ts.

describe("continuedIconVisible", () => {
  const at = 1_000_000_000;
  it("shows for an unseen continuation under 24 hours old", () => {
    expect(continuedIconVisible(at, null, at + CONTINUED_ICON_WINDOW_MS - 1)).toBe(true);
  });
  it("hides a continuation 24 hours old or more", () => {
    expect(continuedIconVisible(at, null, at + CONTINUED_ICON_WINDOW_MS)).toBe(false);
  });
  it("hides a continuation the user has seen", () => {
    expect(continuedIconVisible(at, at, at + 1000)).toBe(false);
  });
  it("shows a newer continuation after an older one was seen", () => {
    expect(continuedIconVisible(at + 5000, at, at + 6000)).toBe(true);
  });
});
