/**
 * Persistence for Band browser profiles and the per-repo default
 * profile.
 *
 * A profile row is metadata only (id, display name, where its cookies came
 * from). The cookies themselves live in the desktop app's Electron session
 * partition for that profile and never reach the server.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { browserProfiles, repoBrowserProfiles } from "../schema";

export interface BrowserProfileRow {
  id: string;
  name: string;
  source: string | null;
  createdAt: number;
}

export class BrowserProfileQueries {
  findAll(): BrowserProfileRow[] {
    return getDb().select().from(browserProfiles).orderBy(asc(browserProfiles.createdAt)).all();
  }

  find(id: string): BrowserProfileRow | undefined {
    return getDb().select().from(browserProfiles).where(eq(browserProfiles.id, id)).get();
  }

  insert(row: BrowserProfileRow): void {
    getDb().insert(browserProfiles).values(row).run();
  }

  /** Delete a profile and every repo default that points at it. */
  remove(id: string): void {
    const db = getDb();
    db.transaction((tx) => {
      tx.delete(repoBrowserProfiles).where(eq(repoBrowserProfiles.profileId, id)).run();
      tx.delete(browserProfiles).where(eq(browserProfiles.id, id)).run();
    });
  }

  getRepoDefault(repoName: string): string | null {
    const row = getDb()
      .select({ profileId: repoBrowserProfiles.profileId })
      .from(repoBrowserProfiles)
      .where(eq(repoBrowserProfiles.repoName, repoName))
      .get();
    return row?.profileId ?? null;
  }

  findAllRepoDefaults(): { repoName: string; profileId: string }[] {
    return getDb()
      .select({
        repoName: repoBrowserProfiles.repoName,
        profileId: repoBrowserProfiles.profileId,
      })
      .from(repoBrowserProfiles)
      .all();
  }

  setRepoDefault(repoName: string, profileId: string, updatedAt: number): void {
    getDb()
      .insert(repoBrowserProfiles)
      .values({ repoName, profileId, updatedAt })
      .onConflictDoUpdate({
        target: repoBrowserProfiles.repoName,
        set: { profileId, updatedAt },
      })
      .run();
  }

  clearRepoDefault(repoName: string): void {
    getDb().delete(repoBrowserProfiles).where(eq(repoBrowserProfiles.repoName, repoName)).run();
  }
}
