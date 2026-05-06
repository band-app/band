/**
 * Integration tests for scripts/after-sign.mjs.
 *
 * After splitting the deep-sign / sidecar-sign work into afterPack (which
 * runs before electron-builder seals the outer .app, so the seal stays
 * valid), the only step left in afterSign is notarization. These tests
 * exercise the wiring between the hook and notarize.mjs:
 *
 *   - On non-darwin platforms the hook is a no-op (no Apple ecosystem
 *     to talk to).
 *   - On darwin with a missing .app bundle the hook throws (mirrors
 *     afterPack — defensive sanity check).
 *   - On darwin with SKIP_NOTARIZE=1 the hook completes without
 *     shelling out (the env-var escape hatch the release workflow
 *     currently uses).
 *
 * Notarize itself has its own dedicated test file (notarize.test.mjs);
 * here we only verify the hook wires through correctly.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import afterSign from "../scripts/after-sign.mjs";

async function makeStubApp(dir) {
  const appPath = join(dir, "Band.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), "<plist></plist>");
  return appPath;
}

describe("afterSign hook", () => {
  test("no-op on non-darwin platforms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-after-sign-win-"));
    try {
      await afterSign({
        electronPlatformName: "win32",
        appOutDir: dir,
        packager: { appInfo: { productFilename: "Band" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no-op on linux too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-after-sign-linux-"));
    try {
      await afterSign({
        electronPlatformName: "linux",
        appOutDir: dir,
        packager: { appInfo: { productFilename: "Band" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws on darwin when the .app bundle is missing", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-sign-missing-"));
    try {
      await assert.rejects(
        () =>
          afterSign({
            electronPlatformName: "darwin",
            appOutDir: dir,
            packager: { appInfo: { productFilename: "Band" } },
          }),
        /expected \.app bundle/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin with SKIP_NOTARIZE=1: completes without shelling out", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-sign-skip-"));
    try {
      await makeStubApp(dir);

      const snapshot = { SKIP_NOTARIZE: process.env.SKIP_NOTARIZE };
      process.env.SKIP_NOTARIZE = "1";

      /** @type {Array<{ cmd: string, args: string[] }>} */
      const calls = [];
      try {
        await afterSign(
          {
            electronPlatformName: "darwin",
            appOutDir: dir,
            packager: { appInfo: { productFilename: "Band" } },
          },
          {
            runner: (cmd, args) => calls.push({ cmd, args }),
            log: () => {},
          },
        );
      } finally {
        if (snapshot.SKIP_NOTARIZE === undefined) delete process.env.SKIP_NOTARIZE;
        else process.env.SKIP_NOTARIZE = snapshot.SKIP_NOTARIZE;
      }

      // notarize.mjs short-circuits on SKIP_NOTARIZE=1 before any xcrun
      // invocation, so no calls should reach the runner.
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin dev build (no notarize creds): completes without shelling out", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-sign-dev-"));
    try {
      await makeStubApp(dir);

      const snapshot = {
        SKIP_NOTARIZE: process.env.SKIP_NOTARIZE,
        APPLE_API_KEY_PATH: process.env.APPLE_API_KEY_PATH,
        APPLE_API_KEY_ID: process.env.APPLE_API_KEY_ID,
        APPLE_API_ISSUER: process.env.APPLE_API_ISSUER,
        APPLE_ID: process.env.APPLE_ID,
        APPLE_APP_SPECIFIC_PASSWORD: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
      };
      for (const k of Object.keys(snapshot)) delete process.env[k];

      const calls = [];
      try {
        await afterSign(
          {
            electronPlatformName: "darwin",
            appOutDir: dir,
            packager: { appInfo: { productFilename: "Band" } },
          },
          {
            runner: (cmd, args) => calls.push({ cmd, args }),
            log: () => {},
          },
        );
      } finally {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v !== undefined) process.env[k] = v;
        }
      }

      // No creds → notarize bails out without calling notarytool.
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
