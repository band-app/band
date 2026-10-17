import { describe, expect, it } from "vite-plus/test";

import { computeActivity } from "../src/lib/activity-reporter";
import { pollIntervalFor } from "../src/lib/poll-interval";
import { isSaver } from "../src/lib/power-state";
import { coldParkDelayMs, hotRetainMs } from "../src/lib/terminal-park-policy";

// Pure functions with no state to fake: the cadence a UI reports to the hub, how a poll slows down,
// and how long a hidden terminal stays warm.

describe("power policy", () => {
  it("reports active only when focused and plugged in", () => {
    expect(computeActivity({ focused: true, onBattery: false })).toBe("active");
    expect(computeActivity({ focused: true, onBattery: true })).toBe("idle");
    expect(computeActivity({ focused: false, onBattery: false })).toBe("idle");
    expect(computeActivity({ focused: false, onBattery: true })).toBe("background");
  });

  it("saves energy on battery or when blurred", () => {
    expect(isSaver({ focused: true, onBattery: false })).toBe(false);
    expect(isSaver({ focused: true, onBattery: true })).toBe(true);
    expect(isSaver({ focused: false, onBattery: false })).toBe(true);
  });

  it("pauses polls when blurred and slows them on battery", () => {
    expect(pollIntervalFor(5_000, { focused: true, onBattery: false })).toBe(5_000);
    expect(pollIntervalFor(5_000, { focused: true, onBattery: true })).toBe(15_000);
    expect(pollIntervalFor(5_000, { focused: true, onBattery: true }, 6)).toBe(30_000);
    expect(pollIntervalFor(5_000, { focused: false, onBattery: false })).toBe(false);
    expect(pollIntervalFor(false, { focused: true, onBattery: false })).toBe(false);
  });

  it("keeps hidden terminals warm for less time on battery", () => {
    expect(coldParkDelayMs(30_000, false)).toBe(30_000);
    expect(coldParkDelayMs(30_000, true)).toBe(10_000);
    expect(hotRetainMs(300_000, false)).toBe(300_000);
    expect(hotRetainMs(300_000, true)).toBe(60_000);
  });
});
