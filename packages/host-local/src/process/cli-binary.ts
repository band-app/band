import { lstatSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";

/**
 * Pure resolver for the band CLI binary. Takes the cwd and the calling
 * module's dirname as inputs so callers can drive it with synthetic paths in
 * tests. The function still hits the real filesystem to confirm each
 * candidate exists — that's the actual contract we care about — but it has
 * no dependency on `process.cwd()` or `import.meta.dirname` so an integration
 * test can lay out a fake packaged-app tree under a tmp dir and call this
 * directly, without subprocess gymnastics.
 */
export function findCliBinaryAt(opts: { cwd: string; dirname: string }): string | null {
  const { cwd, dirname } = opts;

  // Cargo/Electron emit `band.exe` on Windows, `band` elsewhere.
  const exe = platform() === "win32" ? "band.exe" : "band";

  // --- Strategy A: cargo build output (dev & source builds) ---
  const appsStrategies = [
    // cwd = apps/hub/ (Vite dev and production server)
    resolve(cwd, ".."),
    // cwd = project root (fallback)
    resolve(cwd, "apps"),
    // From this source file in dev (packages/host-local/src/process/ → apps/)
    resolve(dirname, "..", "..", "..", "..", "apps"),
    // From bundled `dist/` file (<Resources>/web/dist/ → <Resources>/) only
    // — in dev mode this resolves to `packages/host-local/`, which has no
    // `cli/target/<profile>/band` and is harmless; the walk above is the
    // actual dev-mode path. Included so a future cargo-target
    // layout under <Resources>/cli/ would still resolve. Today's Electron
    // bundle ships the binary under `binaries/` (handled by Strategy B),
    // so this strategy never hits in production either.
    resolve(dirname, "..", "..", ".."),
  ];

  for (const appsDir of appsStrategies) {
    for (const profile of ["release", "debug"]) {
      const p = join(appsDir, "cli", "target", profile, exe);
      try {
        lstatSync(p);
        return p;
      } catch {
        // Continue
      }
    }
  }

  // --- Strategy B: Electron extraResources layout (issue #364) ---
  // electron-builder ships the sidecar at <Resources>/binaries/band on every
  // platform. The web server runs as a child of the main process with cwd
  // set to <Resources>/web by `services/web-server.ts` (via
  // `web-paths.ts::resolveWebDir`), so the sidecar is one level up and
  // across into `binaries/`. We try both the cwd-based and module-relative
  // paths so the resolution survives a future change to the spawn cwd (the
  // dirname path matches the bundled file's installed location at
  // `<Resources>/web/dist/start-server.mjs`).
  const electronCandidates = [
    // From cwd (<Resources>/web) → <Resources>/binaries/band
    resolve(cwd, "..", "binaries", exe),
    // From the bundled dist file (<Resources>/web/dist/start-server.mjs)
    // → <Resources>/binaries/band
    resolve(dirname, "..", "..", "binaries", exe),
  ];
  for (const p of electronCandidates) {
    try {
      lstatSync(p);
      return p;
    } catch {
      // Continue
    }
  }

  return null;
}

/** Find the CLI binary by trying multiple resolution strategies. */
export function findCliBinary(): string | null {
  return findCliBinaryAt({ cwd: process.cwd(), dirname: import.meta.dirname });
}
