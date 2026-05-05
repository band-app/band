/**
 * Resolve the directory containing the bundled web server.
 *
 * Direct port of `apps/dashboard/src-tauri/src/commands/webserver.rs::resolve_web_dir`.
 *
 *   - In dev (Electron run from the repo): walk up from the compiled main
 *     entry to `<repo>/apps/web/`. We never trust `process.cwd()` because
 *     Electron may be launched with a different working directory.
 *   - In a packaged app: `process.resourcesPath/web/` — matches the layout
 *     `electron-builder` will produce in Phase 8 (which mirrors the existing
 *     Tauri `Resources/web/` layout).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WebPathOptions {
  /** True when running inside a packaged Electron build. */
  isPackaged: boolean;
  /** `process.resourcesPath` — only used when packaged. */
  resourcesPath?: string;
  /** `app.getAppPath()` — used in dev to walk up to the repo root. */
  appPath?: string;
}

/** Result file the boot path uses to confirm the bundle is present. */
const SENTINEL = "dist/start-server.mjs";

export function resolveWebDir(opts: WebPathOptions): string {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) {
      throw new Error("resourcesPath required for packaged builds");
    }
    const dir = join(opts.resourcesPath, "web");
    if (!existsSync(join(dir, SENTINEL))) {
      throw new Error(
        `Web server bundle not found at ${dir}. Build the desktop app via electron-builder.`,
      );
    }
    return dir;
  }

  // Dev: walk up from app.getAppPath() looking for apps/web/dist/start-server.mjs.
  // Tauri uses CARGO_MANIFEST_DIR (compile-time); we use a runtime scan since
  // Node has no equivalent. Bounded depth so we fail loudly.
  const start = opts.appPath ?? process.cwd();
  let current = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(current, "apps", "web");
    if (existsSync(join(candidate, SENTINEL))) {
      return candidate;
    }
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `Web server bundle not found. Run \`pnpm build:web\` first. Searched upward from ${start}.`,
  );
}
