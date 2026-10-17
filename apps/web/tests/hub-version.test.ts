import { afterEach, describe, expect, it } from "vite-plus/test";

import { describeError } from "../src/dashboard/stores/dashboard-store";
import {
  compareHubVersion,
  isMissingProcedure,
  isOldHubGap,
  NEEDS_NEWER_HUB,
  setAppNewerThanHub,
} from "../src/lib/hub-version";

// Pure functions with no state to fake: version comparison and the error classification.

const missing = Object.assign(new Error('No procedure found on path "voice.status"'), {
  data: { code: "NOT_FOUND", httpStatus: 404 },
});

describe("compareHubVersion", () => {
  it("calls a newer minor or major newer", () => {
    expect(compareHubVersion("0.50.0", "0.49.0")).toBe("newer");
    expect(compareHubVersion("1.0.0", "0.49.3")).toBe("newer");
  });
  it("ignores patch differences", () => {
    expect(compareHubVersion("0.50.2", "0.50.0")).toBe("same");
    expect(compareHubVersion("0.50.0", "0.50.4")).toBe("same");
  });
  it("calls an older app older", () => {
    expect(compareHubVersion("0.49.0", "0.50.0")).toBe("older");
  });
  it("returns null for versions it cannot read", () => {
    expect(compareHubVersion("dev", "0.50.0")).toBeNull();
  });
});

describe("old hub errors", () => {
  afterEach(() => setAppNewerThanHub(false));

  it("keeps a missing procedure visible with a same-version hub", () => {
    expect(isMissingProcedure(missing)).toBe(true);
    expect(isOldHubGap(missing)).toBe(false);
    expect(describeError(missing)).toContain("No procedure found");
  });

  it("explains a missing procedure when the app is newer than the hub", () => {
    setAppNewerThanHub(true);
    expect(isOldHubGap(missing)).toBe(true);
    expect(describeError(missing)).toBe(NEEDS_NEWER_HUB);
  });

  it("keeps other errors visible when the app is newer", () => {
    setAppNewerThanHub(true);
    const other = Object.assign(new Error("boom"), { data: { code: "INTERNAL_SERVER_ERROR" } });
    expect(isOldHubGap(other)).toBe(false);
    expect(describeError(other)).toBe("boom");
  });
});
