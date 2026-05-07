/**
 * Resolve the app icon path used for the dev-mode dock icon and the
 * Windows/Linux `BrowserWindow.icon` field.
 *
 * In packaged macOS builds the dock icon comes from the bundled `.icns`
 * (resolved via `Info.plist`'s `CFBundleIconFile`), so we don't need a PNG
 * at runtime. In dev there's no app bundle, so we override Electron's
 * default icon by pointing `app.dock.setIcon()` at a PNG instead — that's
 * what this resolver returns.
 *
 * The PNGs live alongside `icon.icns` under `apps/desktop/build/`, which
 * `electron-builder` already treats as `directories.buildResources` so
 * the same files work for packaged Windows/Linux targets if we add them.
 *
 * Returns `null` if no icon was found — callers fall back to whatever the
 * platform supplies by default.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Pick the best available PNG (HiDPI first). */
function pickPng(dir: string): string | null {
  const candidates = ["icon@2x.png", "icon.png"];
  for (const name of candidates) {
    const path = resolve(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Find the icons directory across dev and packaged layouts.
 *
 *   - Packaged: `process.resourcesPath/icons/` (only present if we ever
 *     bundle PNGs as `extraResources`; today macOS uses `.icns` from the
 *     bundle, so this falls through to `null`).
 *   - Dev: walk up from the compiled main bundle (`dist/main/main/`) to
 *     the repo and use `apps/desktop/build/`, which holds `icon.icns`
 *     and the matching PNGs.
 */
function iconsDir(): string | null {
  if (app.isPackaged) {
    const resources = resolve(process.resourcesPath, "icons");
    return existsSync(resources) ? resources : null;
  }
  // Walk up looking for apps/desktop/build/.
  let current = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(current, "apps", "desktop", "build");
    if (existsSync(resolve(candidate, "icon.png"))) return candidate;
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
