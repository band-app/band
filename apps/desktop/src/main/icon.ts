/**
 * Resolve the app icon path. We reuse the Tauri icon set
 * (`apps/dashboard/src-tauri/icons/`) so both shells display the same icon
 * during the migration; Phase 8's `electron-builder` bakes platform-specific
 * formats (`.icns`, `.ico`) into the packaged app directly.
 *
 * In dev we always return PNG: Electron's `BrowserWindow.icon` and
 * `app.dock.setIcon()` both accept PNG on every platform, while `.icns`
 * only loads through the OS bundle path (Info.plist) which we don't have
 * until packaging.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Pick the best available PNG (HiDPI first). */
function pickPng(dir: string): string | null {
  const candidates = ["128x128@2x.png", "icon.png", "128x128.png"];
  for (const name of candidates) {
    const path = resolve(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Find the icons directory across dev and packaged layouts.
 *
 *   - Dev: walk up from `dist/main/main/` to the repo root and use the
 *     existing `apps/dashboard/src-tauri/icons/` until Phase 7 copies them.
 *   - Packaged: `process.resourcesPath/icons/`.
 */
function iconsDir(): string | null {
  if (app.isPackaged) {
    const resources = resolve(process.resourcesPath, "icons");
    return existsSync(resources) ? resources : null;
  }
  // Walk up looking for apps/dashboard/src-tauri/icons.
  let current = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(current, "apps", "dashboard", "src-tauri", "icons");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Returns a PNG icon path, or null if none was found. */
export function resolveAppIcon(): string | null {
  const dir = iconsDir();
  if (!dir) return null;
  return pickPng(dir);
}
