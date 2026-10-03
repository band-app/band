import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTempBandHome } from "./helpers/band-home";

describe("assertTempBandHome", () => {
  it("throws when BAND_HOME is unset", () => {
    expect(() => assertTempBandHome({})).toThrow(/not set/);
  });

  it("throws when BAND_HOME is the real Band home or inside it", () => {
    const real = join(homedir(), ".band");
    expect(() => assertTempBandHome({ BAND_HOME: real })).toThrow(/real Band home/);
    expect(() => assertTempBandHome({ BAND_HOME: join(real, "run") })).toThrow(/real Band home/);
  });

  it("throws when BAND_HOME is outside the temp dir", () => {
    expect(() => assertTempBandHome({ BAND_HOME: join(homedir(), "elsewhere", ".band") })).toThrow(
      /outside the temp dir/,
    );
  });

  it("accepts a BAND_HOME inside the temp dir", () => {
    const home = join(tmpdir(), "band-guard-test", ".band");
    expect(assertTempBandHome({ BAND_HOME: home })).toBe(home);
  });
});
