/**
 * Integration tests for scripts/after-pack.mjs.
 *
 * The afterPack hook runs BEFORE electron-builder seals the outer .app,
 * so the deep-sign + sidecar-sign work happens here — modifying nested
 * Resources/ files after the outer sign would invalidate the bundle's
 * CodeResources seal and trigger Gatekeeper's "is damaged" dialog.
 *
 * We exercise it the same way electron-builder will: pass an
 * AfterPackContext-shaped object pointing at a fake .app on disk, with a
 * fake `Resources/web/` populated with native binaries, and assert:
 *
 *   - On non-darwin platforms the hook is a no-op.
 *   - On darwin, it walks Contents/Resources/web/ and signs every native
 *     binary (delegated to deep-sign-mac.mjs), and signs the CLI sidecar
 *     at Contents/Resources/binaries/band (delegated to signFile).
 *   - When extraResources are absent (e.g. a future variant that doesn't
 *     ship the web bundle), the deep-sign step is skipped without error.
 *   - Notarization is *not* called from afterPack (it lives in afterSign,
 *     which has its own test).
 *
 * The hook composes two helpers that already have their own unit-level
 * coverage; here we focus on the wiring between them.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import afterPack from "../scripts/after-pack.mjs";

/**
 * Build a Band.app with both a populated Resources/web/ tree (native deps
 * the deepSignMac walker should catch) AND the CLI sidecar at
 * Resources/binaries/band (the explicit signFile target). Mirrors the
 * exact layout electron-builder produces from the YAML extraResources block.
 */
async function makeAppWithWeb(appOutDir, { withCli = true } = {}) {
  const appPath = join(appOutDir, "Band.app");
  const web = join(appPath, "Contents", "Resources", "web");
  const dist = join(web, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "pty.node"), "// fake");
  await writeFile(join(dist, "spawn-helper"), "// fake");
  await writeFile(join(dist, "start-server.mjs"), "// boot");

  let cli = null;
  if (withCli) {
    cli = join(appPath, "Contents", "Resources", "binaries", "band");
    await mkdir(join(appPath, "Contents", "Resources", "binaries"), { recursive: true });
    await writeFile(cli, "// fake Mach-O");
  }
  return { appPath, web, cli };
}

describe("afterPack hook", () => {
  test("no-op on non-darwin platforms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-win-"));
    try {
      // We don't even need to create the .app; the hook should bail before
      // touching the filesystem.
      await afterPack({
        electronPlatformName: "win32",
        appOutDir: dir,
        packager: { appInfo: { productFilename: "Band" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no-op on linux too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-linux-"));
    try {
      await afterPack({
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
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-missing-"));
    try {
      await assert.rejects(
        () =>
          afterPack({
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

  test("darwin dev build (no creds): completes without shelling out", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-dev-"));
    try {
      await makeAppWithWeb(dir);

      // Snapshot + clear any signing env so the dev path is exercised.
      const snapshot = {
        APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY,
        APPLE_API_KEY_PATH: process.env.APPLE_API_KEY_PATH,
        APPLE_API_KEY_ID: process.env.APPLE_API_KEY_ID,
        APPLE_API_ISSUER: process.env.APPLE_API_ISSUER,
        APPLE_ID: process.env.APPLE_ID,
        APPLE_APP_SPECIFIC_PASSWORD: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
      };
      for (const k of Object.keys(snapshot)) delete process.env[k];

      try {
        await afterPack({
          electronPlatformName: "darwin",
          appOutDir: dir,
          packager: { appInfo: { productFilename: "Band" } },
        });
      } finally {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v !== undefined) process.env[k] = v;
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin: tolerates an .app without Resources/web/ (no extraResources)", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-noweb-"));
    try {
      const appPath = join(dir, "Band.app");
      await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(appPath, "Contents", "Info.plist"), "<plist></plist>");

      // No web/, no creds — should complete without throwing.
      const snapshot = {
        APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY,
        APPLE_API_KEY_PATH: process.env.APPLE_API_KEY_PATH,
      };
      delete process.env.APPLE_SIGNING_IDENTITY;
      delete process.env.APPLE_API_KEY_PATH;
      try {
        await afterPack({
          electronPlatformName: "darwin",
          appOutDir: dir,
          packager: { appInfo: { productFilename: "Band" } },
        });
      } finally {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v !== undefined) process.env[k] = v;
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin signed build: signs web/ tree AND the CLI sidecar at binaries/band", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-orch-"));
    try {
      const { web, cli } = await makeAppWithWeb(dir);
      // electron-builder also writes its own entitlements file under the
      // standard build/ path — the after-pack hook walks up to find it,
      // and falls through to defaultEntitlements() when the local one is
      // absent. The fixture relies on the latter, which is fine because
      // the runner spy never actually invokes codesign.

      const snapshot = {
        APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY,
        SKIP_NOTARIZE: process.env.SKIP_NOTARIZE,
      };
      process.env.APPLE_SIGNING_IDENTITY = "Developer ID Application: Test (TEAM)";
      // Skip the notarize step explicitly so we only assert codesign calls.
      process.env.SKIP_NOTARIZE = "1";

      /** @type {Array<{ cmd: string, args: string[] }>} */
      const calls = [];
      try {
        await afterPack(
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
        for (const k of Object.keys(snapshot)) {
          if (snapshot[k] === undefined) delete process.env[k];
          else process.env[k] = snapshot[k];
        }
      }

      // The web fixture has 2 native binaries (pty.node + spawn-helper) →
      // deepSignMac issues 2 sign + 2 verify = 4 calls. signFile then issues
      // 1 sign + 1 verify = 2 more calls. Total: 6.
      assert.equal(calls.length, 6);

      // The CLI sidecar must be signed; its sign call must include the band
      // binary's full path. We assert the path appears as the last arg of
      // any sign call (codesign's positional file arg comes last).
      const cliSignCall = calls.find(
        (c) => c.args[0] === "--force" && c.args[c.args.length - 1] === cli,
      );
      assert.ok(cliSignCall, "expected a codesign --force call targeting the CLI binary");
      assert.equal(cliSignCall.cmd, "codesign");

      // And the web tree must be signed too — assert at least one sign call
      // landed inside the web/ subtree.
      const webSignCalls = calls.filter(
        (c) => c.args[0] === "--force" && c.args[c.args.length - 1].startsWith(web),
      );
      assert.equal(webSignCalls.length, 2);

      // Every sign call must carry the same canonical args (hardened
      // runtime + timestamp + entitlements). Pick one and assert.
      const sample = webSignCalls[0];
      assert.equal(sample.args[2], "Developer ID Application: Test (TEAM)");
      assert.deepEqual(sample.args.slice(3, 7), [
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin signed build with no CLI sidecar: signs only the web/ tree", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-after-pack-nocli-"));
    try {
      await makeAppWithWeb(dir, { withCli: false });

      const snapshot = {
        APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY,
        SKIP_NOTARIZE: process.env.SKIP_NOTARIZE,
      };
      process.env.APPLE_SIGNING_IDENTITY = "Developer ID Application: Test (TEAM)";
      process.env.SKIP_NOTARIZE = "1";

      const calls = [];
      try {
        await afterPack(
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
        for (const k of Object.keys(snapshot)) {
          if (snapshot[k] === undefined) delete process.env[k];
          else process.env[k] = snapshot[k];
        }
      }

      // 2 sign + 2 verify from the web tree, nothing from signFile.
      assert.equal(calls.length, 4);
      // No call should target a path under Resources/binaries/.
      for (const call of calls) {
        const last = call.args[call.args.length - 1];
        assert.ok(!last.includes("/Resources/binaries/"), `unexpected sign of ${last}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
