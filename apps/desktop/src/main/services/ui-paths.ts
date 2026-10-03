/**
 * Where the built UI (`apps/web/dist/client`) is, for the `app://` scheme.
 *
 *   - Packaged: `process.resourcesPath/web/dist/client`, next to the hub bundle
 *     (`extraResources` in `electron-builder.yml`).
 *   - Dev: `<repo>/apps/web/dist/client`, found by walking up from the app path.
 *
 * Returns null when there is no build, so the caller can fall back to loading
 * the hub's own URL.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WebPathOptions } from "./web-paths.js";

/** The prerendered SPA shell; its presence marks a complete UI build. */
const SENTINEL = "_shell.html";

export function resolveUiDir(opts: WebPathOptions): string | null {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) return null;
    const dir = join(opts.resourcesPath, "web", "dist", "client");
    return existsSync(join(dir, SENTINEL)) ? dir : null;
  }
  let current = opts.appPath ?? process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(current, "apps", "web", "dist", "client");
    if (existsSync(join(candidate, SENTINEL))) return candidate;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}
