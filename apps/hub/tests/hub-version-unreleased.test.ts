import { describe, expect, it } from "vitest";
import { updateTargetFor } from "../src/server/services/_utils/host-version";
import { isUnreleasedVersion } from "../src/server/services/_utils/hub-version";

describe("isUnreleasedVersion", () => {
  it("counts the source default and a nightly stamped on it as unreleased", () => {
    expect(isUnreleasedVersion("0.1.0")).toBe(true);
    expect(isUnreleasedVersion("0.1.0-nightly.20261018.abc1234")).toBe(true);
  });

  it("counts released versions and their prereleases as released", () => {
    for (const v of ["0.47.0", "0.47.0-rc.1", "0.1.1", "1.1.0"]) {
      expect(isUnreleasedVersion(v), v).toBe(false);
    }
  });

  it("offers a worker behind a nightly hub no update target", () => {
    expect(updateTargetFor("behind", "0.1.0-nightly.20261018.abc1234", null)).toBeNull();
    expect(updateTargetFor("behind", "0.47.0", null)).toBe("0.47.0");
  });
});
