import type { SessionUsageSnapshot } from "../types.ts";

/** One provider session tied to a workspace directory. */
export interface UsageSessionItem {
  sessionId: string;
  /** Epoch ms of the session's last on-disk change. The Reports scanner
   *  compares it against its per-(workspace, agent) watermark. */
  lastModified: number;
}

/**
 * Reads token + cost usage for one coding agent from the provider's on-disk
 * session storage, for the Reports scanner (issue #425).
 *
 * Implementations never invoke the agent itself. `getSessionUsage` returns
 * *every* turn the session contains — the scanner re-buckets and upserts the
 * full totals each time a session changes — and `null` when the session isn't
 * found on disk.
 */
export interface UsageReader {
  listSessions(dir: string): Promise<UsageSessionItem[]>;
  getSessionUsage(sessionId: string, dir: string): Promise<SessionUsageSnapshot | null>;
}
