import { describe, expect, it } from "vitest";
import {
  assertProfileIsolated,
  diffListings,
  isUnderOsTmp,
} from "../e2e-desktop/helpers/profile-guard";

describe("assertProfileIsolated", () => {
  const home = "/tmp/band-home-1";
  it("passes when every path is under the home", () => {
    expect(() =>
      assertProfileIsolated(
        {
          userData: `${home}/electron-profile`,
          sessionData: `${home}/electron-profile/session`,
          partitions: `${home}/electron-profile/session/Partitions`,
        },
        home,
      ),
    ).not.toThrow();
  });
  it("names the resolved userData path when the profile is not applied", () => {
    const real = "/Users/someone/Library/Application Support/Band";
    expect(() =>
      assertProfileIsolated(
        { userData: real, sessionData: real, partitions: `${real}/Partitions` },
        home,
      ),
    ).toThrow(/userData=\/Users\/someone\/Library\/Application Support\/Band/);
  });
});

describe("isUnderOsTmp", () => {
  it("accepts a path under the temp dir, with or without the macOS private prefix", () => {
    expect(isUnderOsTmp("/private/var/folders/x/T/h", "/var/folders/x/T")).toBe(true);
    expect(isUnderOsTmp("/var/folders/x/T/h", "/var/folders/x/T/")).toBe(true);
  });
  it("refuses the home directory", () => {
    expect(isUnderOsTmp("/Users/someone", "/var/folders/x/T")).toBe(false);
  });
});

describe("diffListings", () => {
  it("reports removed and shrunk files, not additions or growth", () => {
    const before = new Map([
      ["a", "100:1"],
      ["b", "10:1"],
      ["g", "10:1"],
      ["s", "100:1"],
    ]);
    const after = new Map([
      ["a", "20:2"],
      ["c", "5:1"],
      ["g", "50:2"],
      ["s", "90:2"],
    ]);
    expect(diffListings(before, after)).toEqual(["removed b", "shrunk a (100 to 20 bytes)"]);
  });
});
