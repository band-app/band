/**
 * Resolve the bundled Band CLI binary path.
 *
 * Mirrors `apps/desktop/src/main/services/web-paths.ts` for the CLI sidecar
 * shipped via `electron-builder`'s `extraResources` (Phase 7 of the Tauri →
 * Electron migration, issue #364). The Tauri equivalent is the `externalBin`
 * resolution that lands the per-host-triple `band-<triple>` binary in
 * `Band.app/Contents/MacOS/band`; we simplify to a single host-built binary
 * shipped under `Resources/binaries/band` because `electron-builder` doesn't
 * use the `band-<triple>` naming convention.
 *
 *   - In dev (Electron run from the repo): walk up from `appPath` to find
 *     `apps/cli/target/{release,debug}/band`. Prefer release; fall back to
 *     debug so `pnpm dev:desktop` (which runs `pnpm build:cli:dev`) works.
 *   - In a packaged app: `process.resourcesPath/binaries/band` — matches the
 *     `extraResources` entry in `apps/desktop/electron-builder.yml`.
 *
 * The path is *not* used directly by the install_cli IPC handler in
 * `macos-shell.ts` to symlink — it is the source we trust over whatever
 * binary path the renderer (web server) supplies. See the handler for the
 * security-conscious override semantics.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CliPathOptions {
  /** True when running inside a packaged Electron build. */
  isPackaged: boolean;
  /** `process.resourcesPath` — only used when packaged. */
  resourcesPath?: string;
  /** `app.getAppPath()` — used in dev to walk up to the repo root. */
  appPath?: string;
}

/** Filename of the CLI binary on disk (Windows uses `.exe`). */
const BINARY_NAME = process.platform === "win32" ? "band.exe" : "band";

/** Relative path within `Resources/` produced by electron-builder. */
const PACKAGED_REL_PATH = join("binaries", BINARY_NAME);

/**
 * Resolve the absolute path to the bundled CLI binary, or `null` when no
 * candidate exists on disk. The caller decides whether a missing binary is
 * fatal (e.g. `installCli`) or a hint to fall back to the renderer-supplied
 * path (e.g. legacy code paths that pre-date the sidecar).
 */
export function resolveCliBinary(opts: CliPathOptions): string | null {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) return null;
    const path = join(opts.resourcesPath, PACKAGED_REL_PATH);
    return existsSync(path) ? path : null;
  }

  // Dev: walk up from app.getAppPath() looking for apps/cli/target/{release,debug}/band.
  // Bounded depth so we fail loudly rather than crawling the whole disk.
  const start = opts.appPath ?? process.cwd();
  let current = start;
  for (let i = 0; i < 8; i++) {
    for (const profile of ["release", "debug"] as const) {
      const candidate = join(current, "apps", "cli", "target", profile, BINARY_NAME);
      if (existsSync(candidate)) return candidate;
    }
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}
