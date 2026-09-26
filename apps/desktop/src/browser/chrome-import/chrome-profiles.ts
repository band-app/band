/**
 * Find the user's Google Chrome profiles on disk.
 *
 * Chrome keeps one directory per profile (`Default`, `Profile 1`, …) under
 * its user-data dir, and a `Local State` JSON file whose
 * `profile.info_cache` maps each directory to its display name. Only the
 * display name is read; emails and avatars are left alone.
 *
 * Nothing here runs until the user has agreed to let Band read Chrome data
 * (the consent dialog in the browser pane's profile menu).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChromeProfile {
  /** Directory name under the user-data dir, e.g. `Default` or `Profile 1`. */
  directory: string;
  /** Display name from `Local State`, e.g. `Work`. */
  name: string;
}

/** Chrome's user-data dir. Band only imports on macOS today. */
export function chromeUserDataDir(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "Google", "Chrome");
}

/**
 * Chrome profile directory names become path segments, so reject anything
 * that could escape the user-data dir.
 */
export function isSafeProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== "." &&
    directory !== ".." &&
    !directory.includes("\0") &&
    !directory.includes("/") &&
    !directory.includes("\\")
  );
}

/**
 * Chrome 96 moved the cookie DB into `Network/`; older profiles still keep
 * it at the profile root.
 */
export function resolveCookiesPath(profileDir: string): string | null {
  const networkPath = join(profileDir, "Network", "Cookies");
  if (existsSync(networkPath)) return networkPath;
  const legacyPath = join(profileDir, "Cookies");
  return existsSync(legacyPath) ? legacyPath : null;
}

/**
 * List the profiles that have a cookie DB, in `Local State` order. Returns
 * an empty list when Chrome isn't installed or has never been run.
 */
export function listChromeProfiles(userDataDir: string): ChromeProfile[] {
  const localStatePath = join(userDataDir, "Local State");
  let infoCache: Record<string, { name?: unknown }> = {};
  if (existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(readFileSync(localStatePath, "utf-8")) as {
        profile?: { info_cache?: Record<string, { name?: unknown }> };
      };
      infoCache = localState.profile?.info_cache ?? {};
    } catch {
      // A corrupt Local State still leaves the Default profile usable.
      infoCache = {};
    }
  }

  const candidates: ChromeProfile[] = Object.entries(infoCache).map(([directory, info]) => ({
    directory,
    name: typeof info?.name === "string" && info.name ? info.name : directory,
  }));
  if (candidates.length === 0) candidates.push({ directory: "Default", name: "Default" });

  return candidates.filter(
    (p) =>
      isSafeProfileDirectory(p.directory) &&
      resolveCookiesPath(join(userDataDir, p.directory)) !== null,
  );
}
