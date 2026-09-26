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

import { readFile, stat } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Chrome 96 moved the cookie DB into `Network/`; older profiles still keep
 * it at the profile root.
 */
export async function resolveCookiesPath(profileDir: string): Promise<string | null> {
  const networkPath = join(profileDir, "Network", "Cookies");
  if (await exists(networkPath)) return networkPath;
  const legacyPath = join(profileDir, "Cookies");
  return (await exists(legacyPath)) ? legacyPath : null;
}

/**
 * List the profiles that have a cookie DB, in `Local State` order. Returns
 * an empty list when Chrome isn't installed or has never been run. Async
 * because it runs in an IPC handler on the Electron main process.
 */
export async function listChromeProfiles(userDataDir: string): Promise<ChromeProfile[]> {
  let infoCache: Record<string, { name?: unknown }> = {};
  try {
    const localState = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf-8")) as {
      profile?: { info_cache?: unknown };
    };
    const cache = localState.profile?.info_cache;
    if (cache && typeof cache === "object") infoCache = cache as Record<string, { name?: unknown }>;
  } catch {
    // Missing or corrupt Local State still leaves the Default profile usable.
  }

  const candidates: ChromeProfile[] = Object.entries(infoCache).map(([directory, info]) => ({
    directory,
    name: typeof info?.name === "string" && info.name ? info.name : directory,
  }));
  if (candidates.length === 0) candidates.push({ directory: "Default", name: "Default" });

  const withCookies = await Promise.all(
    candidates.map(
      async (p) =>
        isSafeProfileDirectory(p.directory) &&
        (await resolveCookiesPath(join(userDataDir, p.directory))) !== null,
    ),
  );
  return candidates.filter((_, i) => withCookies[i]);
}
