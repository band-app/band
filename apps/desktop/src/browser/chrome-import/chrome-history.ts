/**
 * Read a Chrome profile's browsing history for import into Band's
 * per-workspace history (`history.import` on the web server).
 *
 * Chrome keeps one row per URL in the `urls` table of the profile's
 * `History` DB, with a visit count and the last visit time. That matches
 * Band's `browser_history` rows, so no per-visit data is read. The DB is
 * read from a private copy (`snapshot.ts`).
 */

import { chromeTimeToUnixSeconds } from "./chrome-cookies.js";
import { withDbSnapshot } from "./snapshot.js";

export interface ChromeHistoryEntry {
  url: string;
  /** `null` when Chrome has no title for the page. */
  title: string | null;
  visitCount: number;
  /** Unix milliseconds. */
  lastVisitedAt: number;
}

/** Most recently visited URLs to import. Older ones rarely matter for autocomplete. */
export const HISTORY_IMPORT_LIMIT = 5000;
/** Same caps the server's `history.*` procedures accept. */
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;

function hasCredentials(url: string): boolean {
  try {
    const { username, password } = new URL(url);
    return Boolean(username || password);
  } catch {
    return true;
  }
}

interface UrlRow {
  url: string;
  title: string | null;
  visit_count: bigint;
  last_visit_time: bigint;
}

/**
 * Return the profile's most recently visited http(s) URLs, newest first.
 * Hidden rows (subframe navigations Chrome keeps out of its own history
 * page) are skipped, and so are URLs with a username or password in them,
 * which the server refuses to store.
 */
export async function readChromeHistory(
  historyPath: string,
  limit: number = HISTORY_IMPORT_LIMIT,
): Promise<ChromeHistoryEntry[]> {
  const rows = await withDbSnapshot(
    historyPath,
    (db) =>
      db
        .prepare(
          `SELECT url, title, visit_count, last_visit_time
             FROM urls
            WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
              AND length(url) <= ?
            ORDER BY last_visit_time DESC
            LIMIT ?`,
        )
        .all(MAX_URL_LENGTH, limit) as unknown as UrlRow[],
  );

  const entries: ChromeHistoryEntry[] = [];
  for (const row of rows) {
    if (hasCredentials(row.url)) continue;
    const lastVisitSeconds = chromeTimeToUnixSeconds(row.last_visit_time);
    if (lastVisitSeconds === 0) continue;
    const title = row.title ? row.title.slice(0, MAX_TITLE_LENGTH) : null;
    entries.push({
      url: row.url,
      title,
      // Typed-but-never-loaded URLs have a count of 0; the server wants 1+.
      visitCount: Math.max(1, Number(row.visit_count)),
      lastVisitedAt: lastVisitSeconds * 1000,
    });
  }
  return entries;
}
