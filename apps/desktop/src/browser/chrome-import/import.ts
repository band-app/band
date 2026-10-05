/**
 * Import a Chrome profile's cookies and browsing history.
 *
 * The renderer only calls this after the user picked what to import in the
 * import dialog. Cookies go straight from Chrome's DB into the Electron
 * session partition; they are not returned over IPC, sent to the web
 * server, or logged, and the IPC result carries their counts only. History
 * entries are returned to the renderer, which stores them in the web
 * server's per-worktree history (where Band's own browsing is recorded).
 *
 * Every selected DB is read before anything is written, so a locked or
 * unreadable DB fails the whole import instead of leaving half of it done.
 */

import { join } from "node:path";
import { createLogger } from "../../main/services/log.js";
import {
  isValidProfileId,
  listProfilePartitionsOnDisk,
  retireProfile,
  sessionForProfile,
} from "../profiles.js";
import { type ChromeCookieReadResult, readChromeCookies } from "./chrome-cookies.js";
import { type ChromeHistoryEntry, readChromeHistory } from "./chrome-history.js";
import {
  type ChromeProfile,
  chromeUserDataDir,
  isChromeRunning,
  isSafeProfileDirectory,
  listChromeProfiles,
  resolveCookiesPath,
  resolveHistoryPath,
} from "./chrome-profiles.js";
import { getChromeSafeStoragePassword } from "./keychain.js";

const log = createLogger("chrome-import");

/** How many `cookies.set` calls run at once. */
const SET_CONCURRENCY = 32;

export interface ChromeProfilesResult {
  /** False on platforms Band can't import from (only macOS is supported). */
  supported: boolean;
  /** Chrome is open, so its DBs may be mid-write. The dialog asks the user to quit it. */
  running: boolean;
  profiles: ChromeProfile[];
}

export interface ChromeImportArgs {
  /** Band profile to import cookies into. Ignored when `cookies` is false. */
  profileId: string;
  /** Chrome profile directory, as returned by `listChromeImportProfiles`. */
  chromeProfileDirectory: string;
  cookies: boolean;
  history: boolean;
}

export interface ChromeCookieSummary {
  imported: number;
  /** Cookies Chromium refused (e.g. a value with non-ASCII bytes). */
  rejected: number;
  skippedGoogle: number;
  skippedPartitioned: number;
  skippedExpired: number;
  undecryptable: number;
  total: number;
}

export interface ChromeImportResult {
  /** `null` when cookies weren't selected. */
  cookies: ChromeCookieSummary | null;
  /** `null` when history wasn't selected. */
  history: ChromeHistoryEntry[] | null;
}

export async function listChromeImportProfiles(): Promise<ChromeProfilesResult> {
  if (process.platform !== "darwin") return { supported: false, running: false, profiles: [] };
  const userDataDir = chromeUserDataDir();
  const [running, profiles] = await Promise.all([
    isChromeRunning(userDataDir),
    listChromeProfiles(userDataDir),
  ]);
  return { supported: true, running, profiles };
}

/** Polled by the import dialog so its "close Chrome" hint goes away once Chrome quits. */
export async function chromeRunningStatus(): Promise<{ running: boolean }> {
  if (process.platform !== "darwin") return { running: false };
  return { running: await isChromeRunning(chromeUserDataDir()) };
}

/** Errors whose message is already written for the user. */
function isUserFacing(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.name === "KeychainAccessError" || err.name === "ChromeDataLockedError")
  );
}

async function readOrExplain<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isUserFacing(err)) throw err;
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `reading Chrome ${what} failed`,
    );
    throw new Error(`Could not read Chrome's ${what}. Quit Google Chrome and try again.`);
  }
}

export async function importChromeProfile(args: ChromeImportArgs): Promise<ChromeImportResult> {
  if (process.platform !== "darwin") {
    throw new Error("Importing Chrome profiles is only supported on macOS.");
  }
  if (!args.cookies && !args.history) throw new Error("Choose something to import.");
  if (args.cookies && !isValidProfileId(args.profileId)) {
    throw new Error("Invalid browser profile id");
  }
  if (!isSafeProfileDirectory(args.chromeProfileDirectory)) {
    throw new Error("Invalid Chrome profile");
  }
  const profileDir = join(chromeUserDataDir(), args.chromeProfileDirectory);

  // Read everything first. Nothing is written until every read succeeded.
  let cookies: ChromeCookieReadResult | null = null;
  if (args.cookies) {
    const cookiesPath = await resolveCookiesPath(profileDir);
    if (!cookiesPath) throw new Error("This Chrome profile has no cookies to import.");
    cookies = await readOrExplain("cookies", () =>
      readChromeCookies(cookiesPath, getChromeSafeStoragePassword),
    );
  }
  let history: ChromeHistoryEntry[] | null = null;
  if (args.history) {
    const historyPath = await resolveHistoryPath(profileDir);
    if (!historyPath) throw new Error("This Chrome profile has no browsing history to import.");
    history = await readOrExplain("browsing history", () => readChromeHistory(historyPath));
  }

  const summary = cookies ? await writeCookies(args.profileId, cookies) : null;
  // Counts only. Never names, domains, URLs or values.
  log.info(
    {
      profileId: args.cookies ? args.profileId : null,
      ...summary,
      historyEntries: history?.length,
    },
    "imported Chrome profile data",
  );
  return { cookies: summary, history };
}

async function writeCookies(
  profileId: string,
  read: ChromeCookieReadResult,
): Promise<ChromeCookieSummary> {
  const sess = sessionForProfile(profileId);
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
  return {
    imported,
    rejected,
    skippedGoogle: read.skippedGoogle,
    skippedPartitioned: read.skippedPartitioned,
    skippedExpired: read.skippedExpired,
    undecryptable: read.undecryptable,
    total: read.total,
  };
}

/**
 * Wipe a deleted profile's cookies, storage and cache from disk.
 * `stopPages` stops every page still running in the profile first, so no
 * page writes storage back while it is cleared; the profile is retired so
 * an offscreen respawn lands in Default instead.
 */
export async function clearProfileData(
  profileId: string,
  stopPages: (profileId: string) => void,
): Promise<void> {
  if (!isValidProfileId(profileId)) throw new Error("Invalid browser profile id");
  retireProfile(profileId);
  stopPages(profileId);
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
  stopPages: (profileId: string) => void,
): Promise<string[]> {
  const known = new Set(keep);
  const stale = (await listProfilePartitionsOnDisk()).filter((id) => !known.has(id));
  for (const id of stale) await clearProfileData(id, stopPages);
  if (stale.length > 0) log.info({ count: stale.length }, "wiped deleted browser profiles");
  return stale;
}
