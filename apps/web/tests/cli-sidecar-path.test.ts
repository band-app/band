/**
 * Integration test for findCliBinary() in apps/web/src/lib/cli.ts when running
 * inside a packaged Electron build.
 *
 * Background: in a packaged build, electron-builder ships the web server
 * bundle at `<Resources>/web/dist/start-server.mjs` and the CLI sidecar at
 * `<Resources>/binaries/band`. The web server is spawned with cwd set to
 * `<Resources>/web` (see `apps/desktop/src/main/services/web-paths.ts` ->
 * `apps/desktop/src/main/services/web-server.ts::makeSpawnOptions`). Inside
 * the bundle, `import.meta.dirname === <Resources>/web/dist`.
 *
 * Resolution must therefore reach the sidecar with:
 *   - process.cwd() ("<Resources>/web") + ".." -> "<Resources>" -> binaries/band
 *   - import.meta.dirname ("<Resources>/web/dist") + "../.." -> "<Resources>"
 *     -> binaries/band
 *
 * An earlier off-by-one (one extra "..") landed the lookup at
 * `Contents/binaries/band` (outside `Contents/Resources/`), so `findCliBinary`
 * returned null and the desktop app's CLI install banner failed with a
 * misleading cargo-build error. This test guards against the regression.
 *
 * Black-box: we mimic the packaged on-disk layout in a tmp dir, spawn a Node
 * subprocess with cwd = `<tmp>/Resources/web/`, and have the subprocess import
 * the real `findCliBinary` and print its return value. We copy `cli.ts` into
 * `<tmp>/Resources/web/dist/` so its `import.meta.dirname` resolves to the
 * bundled location (otherwise the function's `import.meta.dirname` would
 * point at the real repo path and Strategy A's cargo-build lookup could win
 * on hosts that have a `apps/cli/target/release/band` lying around).
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_SOURCE = join(import.meta.dirname, "..", "src", "lib", "cli.ts");

describe("findCliBinary in packaged Electron layout", () => {
  let tmp: string;

  beforeEach(() => {
    // realpathSync to dodge macOS' /var -> /private/var symlink: spawn's cwd
    // is canonicalised by the kernel, so `process.cwd()` inside the
    // subprocess returns the real path. Pinning here keeps the equality
    // assertion straightforward.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-cli-sidecar-")));
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves <Resources>/binaries/band when cwd is <Resources>/web", () => {
    // Lay out the packaged-app shape under <tmp>/Resources/:
    //   <tmp>/Resources/web/dist/start-server.mjs   (the bundle)
    //   <tmp>/Resources/binaries/band               (the sidecar)
    const resources = join(tmp, "Resources");
    const webDir = join(resources, "web");
    const distDir = join(webDir, "dist");
    const binDir = join(resources, "binaries");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(distDir, "start-server.mjs"), "// stub bundled server\n", "utf-8");
    const sidecar = join(binDir, "band");
    writeFileSync(sidecar, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(sidecar, 0o755);

    // Copy cli.ts into the bundled location so the function's
    // `import.meta.dirname` matches what it sees in a packaged build.
    // Without this, the real source path leaks in and Strategy A could
    // find a cargo build outside the sandbox.
    const bundledCli = join(distDir, "cli.ts");
    copyFileSync(CLI_SOURCE, bundledCli);

    // Spawn a Node subprocess with cwd = <Resources>/web/ that imports the
    // bundled cli.ts and prints findCliBinary()'s return value. Type
    // stripping is enabled by default in Node 22.6+, so importing the .ts
    // module from a .mjs runner requires no flags.
    const runnerScript = [
      `import { findCliBinary } from ${JSON.stringify(bundledCli)};`,
      `process.stdout.write(findCliBinary() ?? "<null>");`,
    ].join("\n");

    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", runnerScript], {
      cwd: webDir,
      encoding: "utf-8",
    });

    expect(stdout).toBe(sidecar);
  });

  it("returns null when the sidecar is absent from the packaged layout", () => {
    // Same shape, but no `binaries/band`. Strategy A walks up from the
    // copied cli.ts (under <tmp>/Resources/web/dist/) and finds nothing.
    // Strategy B's candidates also miss. findCliBinary should return null.
    const resources = join(tmp, "Resources");
    const webDir = join(resources, "web");
    const distDir = join(webDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "start-server.mjs"), "// stub bundled server\n", "utf-8");

    const bundledCli = join(distDir, "cli.ts");
    copyFileSync(CLI_SOURCE, bundledCli);

    const runnerScript = [
      `import { findCliBinary } from ${JSON.stringify(bundledCli)};`,
      `process.stdout.write(findCliBinary() ?? "<null>");`,
    ].join("\n");

    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", runnerScript], {
      cwd: webDir,
      encoding: "utf-8",
    });

    expect(stdout).toBe("<null>");
  });
});
