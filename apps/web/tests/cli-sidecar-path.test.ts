/**
 * Integration test for the band CLI sidecar resolver in
 * `apps/web/src/lib/cli.ts` when running inside a packaged Electron build.
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
 * `Contents/binaries/band` (outside `Contents/Resources/`), so the resolver
 * returned null and the desktop app's CLI install banner failed with a
 * misleading cargo-build error. This test guards against the regression.
 *
 * Black-box-ish: we mimic the packaged on-disk layout in a tmp dir and drive
 * `findCliBinaryAt` with the synthetic cwd / dirname pair. The function
 * still hits the real filesystem to confirm each candidate exists (which is
 * the actual contract we care about), so this exercises the same logic the
 * production `findCliBinary` runs — just with the path inputs injected
 * rather than read from `process.cwd()` / `import.meta.dirname`.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCliBinaryAt } from "../src/lib/cli";

describe("findCliBinaryAt in packaged Electron layout", () => {
  let tmp: string;

  beforeEach(() => {
    // realpathSync to dodge macOS' /var -> /private/var symlink so the
    // returned path matches the expected sidecar path verbatim.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-cli-sidecar-")));
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves <Resources>/binaries/band given the packaged cwd and dirname", () => {
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

    // cwd is <Resources>/web (matches the real spawn cwd) and dirname is
    // <Resources>/web/dist (matches `import.meta.dirname` of the bundled
    // start-server.mjs).
    const result = findCliBinaryAt({ cwd: webDir, dirname: distDir });
    expect(result).toBe(sidecar);
  });

  it("returns null when the sidecar is absent from the packaged layout", () => {
    // Same shape, but no `binaries/band`. Strategy A's cargo walk is also
    // bounded to the temp tree (no apps/cli/target inside <tmp>), so the
    // resolver should miss every candidate and return null rather than
    // pick up some unrelated `band` binary lying around on the host.
    const resources = join(tmp, "Resources");
    const webDir = join(resources, "web");
    const distDir = join(webDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "start-server.mjs"), "// stub bundled server\n", "utf-8");

    const result = findCliBinaryAt({ cwd: webDir, dirname: distDir });
    expect(result).toBeNull();
  });
});
