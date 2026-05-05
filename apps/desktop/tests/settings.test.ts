/**
 * Integration test for settings.json reading.
 *
 * Real filesystem, sandboxed via HOME. Asserts that getConfiguredPort and
 * tryGetToken return the right values for: missing file, malformed JSON,
 * partial settings, and complete settings.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { getConfiguredPort, tryGetToken } from "../src/main/services/settings.ts";

describe("settings", () => {
  let sandboxHome: string;
  let settingsFile: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-settings-"));
    process.env.HOME = sandboxHome;
    await mkdir(join(sandboxHome, ".band"), { recursive: true });
    settingsFile = join(sandboxHome, ".band", "settings.json");
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("default port when settings.json is absent", () => {
    assert.equal(getConfiguredPort(), 3456);
    assert.equal(tryGetToken(), null);
  });

  test("returns configured port and token", async () => {
    await writeFile(settingsFile, JSON.stringify({ webServerPort: 4567, tokenSecret: "abc123" }));
    assert.equal(getConfiguredPort(), 4567);
    assert.equal(tryGetToken(), "abc123");
  });

  test("partial settings — port without token", async () => {
    await writeFile(settingsFile, JSON.stringify({ webServerPort: 9000 }));
    assert.equal(getConfiguredPort(), 9000);
    assert.equal(tryGetToken(), null);
  });

  test("malformed JSON falls back to default port", async () => {
    await writeFile(settingsFile, "{not json");
    // tryGetToken swallows the parse error and returns null
    assert.equal(tryGetToken(), null);
    // getConfiguredPort wraps loadSettings in try/catch via tryGetToken pattern;
    // verify it returns the default rather than throwing.
    assert.equal(getConfiguredPort(), 3456);
  });

  test("rejects empty token strings", async () => {
    await writeFile(settingsFile, JSON.stringify({ tokenSecret: "" }));
    assert.equal(tryGetToken(), null);
  });
});
