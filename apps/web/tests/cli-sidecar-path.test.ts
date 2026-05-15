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
import { findCliBinaryAt, noBinaryError } from "../src/lib/cli";

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

  it("resolves via the dirname-based candidate when the cwd path misses", () => {
    // The earlier positive test always short-circuits at the cwd-based
    // Strategy B candidate. If a future regression revives the off-by-one
    // on the *dirname*-based candidate only, that test would still pass.
    // Pin the second candidate by passing a cwd that resolves nowhere
    // (cwd/../binaries/band does not exist), forcing the resolver to fall
    // through to the dirname path.
    const resources = join(tmp, "Resources");
    const distDir = join(resources, "web", "dist");
    const binDir = join(resources, "binaries");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const sidecar = join(binDir, "band");
    writeFileSync(sidecar, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(sidecar, 0o755);

    // cwd points at an unrelated subtree with no binaries/ sibling, so the
    // cwd-based candidate misses. dirname is the real bundled location.
    const unrelatedCwd = join(tmp, "unrelated", "deep", "subdir");
    mkdirSync(unrelatedCwd, { recursive: true });

    const result = findCliBinaryAt({ cwd: unrelatedCwd, dirname: distDir });
    expect(result).toBe(sidecar);
  });
});

describe("noBinaryError", () => {
  it("returns the .dmg-user message when BAND_PACKAGED is set", () => {
    const err = noBinaryError({ BAND_PACKAGED: "1" });
    expect(err.message).toBe("Bundled CLI binary missing - try reinstalling Band");
  });

  it("returns the cargo-build message when BAND_PACKAGED is unset", () => {
    const err = noBinaryError({});
    expect(err.message).toMatch(/cargo build --release -p band-cli/);
  });

  it("treats an empty BAND_PACKAGED as unset", () => {
    // process.env values are strings; an empty string is the same as "not
    // present" for our boolean intent.
    const err = noBinaryError({ BAND_PACKAGED: "" });
    expect(err.message).toMatch(/cargo build --release -p band-cli/);
  });

  it("treats BAND_PACKAGED=0 as unset (strict === \"1\" check)", () => {
    // "0" is truthy as a non-empty string but semantically means "off".
    // A truthy check would mis-route to the reinstall message.
    const err = noBinaryError({ BAND_PACKAGED: "0" });
    expect(err.message).toMatch(/cargo build --release -p band-cli/);
  });
});
