/**
 * Integration test for resolveUiDir, on real directory trees in tmp.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveUiDir } from "../src/main/services/ui-paths.ts";

async function withTree(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "band-desktop-ui-paths-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveUiDir", () => {
  test("dev: finds apps/web/dist/client by walking up", () =>
    withTree(async (repo) => {
      const ui = join(repo, "apps", "web", "dist", "client");
      await mkdir(ui, { recursive: true });
      await writeFile(join(ui, "_shell.html"), "<html/>");
      await mkdir(join(repo, "apps", "desktop", "dist", "main"), { recursive: true });
      assert.equal(
        resolveUiDir({
          isPackaged: false,
          appPath: join(repo, "apps", "desktop", "dist", "main"),
        }),
        ui,
      );
    }));

  test("dev: null when the UI is not built", () =>
    withTree(async (repo) => {
      await mkdir(join(repo, "apps", "web", "dist", "client"), { recursive: true });
      assert.equal(resolveUiDir({ isPackaged: false, appPath: repo }), null);
    }));

  test("packaged: resourcesPath/web/dist/client", () =>
    withTree(async (resources) => {
      const ui = join(resources, "web", "dist", "client");
      await mkdir(ui, { recursive: true });
      await writeFile(join(ui, "_shell.html"), "<html/>");
      assert.equal(resolveUiDir({ isPackaged: true, resourcesPath: resources }), ui);
    }));

  test("packaged: null when the bundle has no UI", () =>
    withTree(async (resources) => {
      assert.equal(resolveUiDir({ isPackaged: true, resourcesPath: resources }), null);
    }));
});
