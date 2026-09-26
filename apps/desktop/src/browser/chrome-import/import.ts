/**
 * Import a Chrome profile's cookies into a Band browser profile's session.
 *
 * The renderer only calls this after the user agreed to let Band read
 * Chrome data. Cookies go straight from Chrome's DB into the Electron
 * session partition; they are not returned over IPC, sent to the web
 * server, or logged. The IPC result carries counts only.
 */

import { join } from "node:path";
import { createLogger } from "../../main/services/log.js";
import {
  isValidProfileId,
  listProfilePartitionsOnDisk,
  retireProfile,
  sessionForProfile,
} from "../profiles.js";
import { readChromeCookies } from "./chrome-cookies.js";
import {
  type ChromeProfile,
  chromeUserDataDir,
  isSafeProfileDirectory,
  listChromeProfiles,
  resolveCookiesPath,
} from "./chrome-profiles.js";
import { getChromeSafeStoragePassword } from "./keychain.js";

const log = createLogger("chrome-import");

/** How many `cookies.set` calls run at once. */
const SET_CONCURRENCY = 32;

export interface ChromeProfilesResult {
  /** False on platforms Band can't import from (only macOS is supported). */
  supported: boolean;
  profiles: ChromeProfile[];
}

export interface ChromeImportArgs {
  /** Band profile to import into. */
  profileId: string;
  /** Chrome profile directory, as returned by `listChromeImportProfiles`. */
  chromeProfileDirectory: string;
}

export interface ChromeImportSummary {
  imported: number;
  /** Cookies Chromium refused (e.g. a value with non-ASCII bytes). */
  rejected: number;
  skippedGoogle: number;
  skippedPartitioned: number;
  skippedExpired: number;
  undecryptable: number;
  total: number;
}

export function listChromeImportProfiles(): ChromeProfilesResult {
  if (process.platform !== "darwin") return { supported: false, profiles: [] };
  return { supported: true, profiles: listChromeProfiles(chromeUserDataDir()) };
}

export async function importChromeProfile(args: ChromeImportArgs): Promise<ChromeImportSummary> {
  if (process.platform !== "darwin") {
    throw new Error("Importing Chrome profiles is only supported on macOS.");
  }
  if (!isValidProfileId(args.profileId)) throw new Error("Invalid browser profile id");
  if (!isSafeProfileDirectory(args.chromeProfileDirectory)) {
    throw new Error("Invalid Chrome profile");
  }
  const cookiesPath = resolveCookiesPath(join(chromeUserDataDir(), args.chromeProfileDirectory));
  if (!cookiesPath) throw new Error("This Chrome profile has no cookies to import.");

  let read: Awaited<ReturnType<typeof readChromeCookies>>;
  try {
    read = await readChromeCookies(cookiesPath, getChromeSafeStoragePassword);
  } catch (err) {
    if (err instanceof Error && err.name === "KeychainAccessError") throw err;
    log.warn(
      { profileId: args.profileId, err: err instanceof Error ? err.message : String(err) },
      "reading Chrome cookie DB failed",
    );
    throw new Error("Could not read Chrome's cookies. Quit Chrome and try again.");
  }

  const sess = sessionForProfile(args.profileId);
  let imported = 0;
  let rejected = 0;
  for (let i = 0; i < read.cookies.length; i += SET_CONCURRENCY) {
    const batch = read.cookies.slice(i, i + SET_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((cookie) => sess.cookies.set(cookie)));
    for (const r of results) {
      if (r.status === "fulfilled") imported++;
      else rejected++;
    }
  }
  await sess.cookies.flushStore();

  const summary: ChromeImportSummary = {
    imported,
    rejected,
    skippedGoogle: read.skippedGoogle,
    skippedPartitioned: read.skippedPartitioned,
    skippedExpired: read.skippedExpired,
    undecryptable: read.undecryptable,
    total: read.total,
  };
  // Counts only. Never names, domains or values.
  log.info({ profileId: args.profileId, ...summary }, "imported Chrome cookies");
  return summary;
}

/**
 * Wipe a deleted profile's cookies, storage and cache from disk.
 * `destroyViews` closes every view still running in the profile first, so
 * no page writes storage back while it is cleared; the profile is retired
 * so a respawn lands in Default instead.
 */
export async function clearProfileData(
  profileId: string,
  destroyViews: (profileId: string) => void,
): Promise<void> {
  if (!isValidProfileId(profileId)) throw new Error("Invalid browser profile id");
  retireProfile(profileId);
  destroyViews(profileId);
  const sess = sessionForProfile(profileId);
  await sess.clearStorageData();
  await sess.clearCache();
  await sess.cookies.flushStore();
}

/**
 * Wipe every profile partition on disk that isn't in `keep` (the profiles
 * the server knows). Catches profiles deleted while the desktop app wasn't
 * the client, e.g. from Settings in a plain browser tab.
 */
export async function pruneProfileData(
  keep: string[],
  destroyViews: (profileId: string) => void,
): Promise<string[]> {
  const known = new Set(keep);
  const stale = listProfilePartitionsOnDisk().filter((id) => !known.has(id));
  for (const id of stale) await clearProfileData(id, destroyViews);
  if (stale.length > 0) log.info({ count: stale.length }, "wiped deleted browser profiles");
  return stale;
}
