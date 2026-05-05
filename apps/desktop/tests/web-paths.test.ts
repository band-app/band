/**
 * Integration test for resolveWebDir.
 *
 * The function walks up from `appPath` to find `apps/web/dist/start-server.mjs`.
 * We construct a real directory tree in tmp and assert the resolution.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveWebDir } from "../src/main/services/web-paths.ts";

describe("resolveWebDir", () => {
  test("dev: walks up from appPath to find apps/web bundle", async () => {
    const repo = await mkdtemp(join(tmpdir(), "band-desktop-paths-"));
    try {
      // Lay out: repo/apps/desktop/dist/main and repo/apps/web/dist/start-server.mjs
      await mkdir(join(repo, "apps", "desktop", "dist", "main"), { recursive: true });
      const webDir = join(repo, "apps", "web");
      await mkdir(join(webDir, "dist"), { recursive: true });
      await writeFile(join(webDir, "dist", "start-server.mjs"), "// fake");

      const resolved = resolveWebDir({
        isPackaged: false,
        appPath: join(repo, "apps", "desktop", "dist", "main"),
      });
      assert.equal(resolved, webDir);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("dev: throws when bundle is missing anywhere up the tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-desktop-paths-missing-"));
    try {
      assert.throws(
        () => resolveWebDir({ isPackaged: false, appPath: dir }),
        /Web server bundle not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("packaged: uses resourcesPath/web", async () => {
    const resources = await mkdtemp(join(tmpdir(), "band-desktop-resources-"));
    try {
      const webDir = join(resources, "web");
      await mkdir(join(webDir, "dist"), { recursive: true });
      await writeFile(join(webDir, "dist", "start-server.mjs"), "// fake");

      const resolved = resolveWebDir({
        isPackaged: true,
        resourcesPath: resources,
      });
      assert.equal(resolved, webDir);
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  test("packaged: throws when resourcesPath/web/dist/start-server.mjs is missing", async () => {
    const resources = await mkdtemp(join(tmpdir(), "band-desktop-resources-missing-"));
    try {
      assert.throws(
        () => resolveWebDir({ isPackaged: true, resourcesPath: resources }),
        /Web server bundle not found/,
      );
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });
});
