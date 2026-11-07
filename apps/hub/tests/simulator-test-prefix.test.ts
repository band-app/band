import { describe, expect, it } from "vitest";

// A hub test that boots a simulator would otherwise name its devices "Band – ...", which are the
// person's own devices. `scrubWorkerEnv` (called by vitest.config.ts) gives every test process a
// prefix of its own; the worker passes it on to extension services.
describe("simulator test prefix", () => {
  it("is a band-test prefix in every hub test process", () => {
    expect(process.env.BAND_SIMULATOR_NAME_PREFIX).toMatch(/^band-test-[0-9a-z]+-\d+$/);
  });
});
