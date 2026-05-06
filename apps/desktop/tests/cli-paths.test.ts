/**
 * Integration test for resolveCliBinary.
 *
 * The function locates the bundled Band CLI sidecar:
 *   - Packaged: <resourcesPath>/binaries/band
 *   - Dev:      walks up from `appPath` to apps/cli/target/{release,debug}/band
 *
 * We construct real directory trees in tmp and assert the resolution.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveCliBinary } from "../src/main/services/cli-paths.ts";

const BINARY_NAME = process.platform === "win32" ? "band.exe" : "band";

describe("resolveCliBinary", () => {
  test("packaged: returns resourcesPath/binaries/band when present", async () => {
    const resources = await mkdtemp(join(tmpdir(), "band-cli-paths-pkg-"));
    try {
      const binDir = join(resources, "binaries");
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, BINARY_NAME), "// fake binary");

      const resolved = resolveCliBinary({
        isPackaged: true,
        resourcesPath: resources,
      });
      assert.equal(resolved, join(binDir, BINARY_NAME));
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  test("packaged: returns null when binary missing", async () => {
    const resources = await mkdtemp(join(tmpdir(), "band-cli-paths-pkg-missing-"));
    try {
      const resolved = resolveCliBinary({
        isPackaged: true,
        resourcesPath: resources,
      });
      assert.equal(resolved, null);
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  test("packaged: returns null when resourcesPath omitted", () => {
    const resolved = resolveCliBinary({ isPackaged: true });
    assert.equal(resolved, null);
  });

  test("dev: walks up from appPath to release cargo target", async () => {
    const repo = await mkdtemp(join(tmpdir(), "band-cli-paths-dev-rel-"));
    try {
      // Lay out: repo/apps/desktop/dist/main and repo/apps/cli/target/release/band
      await mkdir(join(repo, "apps", "desktop", "dist", "main"), { recursive: true });
      const releaseDir = join(repo, "apps", "cli", "target", "release");
      await mkdir(releaseDir, { recursive: true });
      await writeFile(join(releaseDir, BINARY_NAME), "// fake release binary");

      const resolved = resolveCliBinary({
        isPackaged: false,
        appPath: join(repo, "apps", "desktop", "dist", "main"),
      });
      assert.equal(resolved, join(releaseDir, BINARY_NAME));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("dev: prefers release over debug when both exist", async () => {
    const repo = await mkdtemp(join(tmpdir(), "band-cli-paths-dev-pref-"));
    try {
      await mkdir(join(repo, "apps", "desktop"), { recursive: true });
      const releaseDir = join(repo, "apps", "cli", "target", "release");
      const debugDir = join(repo, "apps", "cli", "target", "debug");
      await mkdir(releaseDir, { recursive: true });
      await mkdir(debugDir, { recursive: true });
      await writeFile(join(releaseDir, BINARY_NAME), "// release");
      await writeFile(join(debugDir, BINARY_NAME), "// debug");

      const resolved = resolveCliBinary({
        isPackaged: false,
        appPath: join(repo, "apps", "desktop"),
      });
      assert.equal(resolved, join(releaseDir, BINARY_NAME));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("dev: falls back to debug when only debug exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "band-cli-paths-dev-dbg-"));
    try {
      await mkdir(join(repo, "apps", "desktop"), { recursive: true });
      const debugDir = join(repo, "apps", "cli", "target", "debug");
      await mkdir(debugDir, { recursive: true });
      await writeFile(join(debugDir, BINARY_NAME), "// debug");

      const resolved = resolveCliBinary({
        isPackaged: false,
        appPath: join(repo, "apps", "desktop"),
      });
      assert.equal(resolved, join(debugDir, BINARY_NAME));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("dev: returns null when no binary is found anywhere up the tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-cli-paths-dev-missing-"));
    try {
      const resolved = resolveCliBinary({ isPackaged: false, appPath: dir });
      assert.equal(resolved, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
