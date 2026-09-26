/**
 * Persistence for Band browser profiles and the per-project default
 * profile.
 *
 * A profile row is metadata only (id, display name, where its cookies came
 * from). The cookies themselves live in the desktop app's Electron session
 * partition for that profile and never reach the server.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { browserProfiles, projectBrowserProfiles } from "../schema";

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

  rename(id: string, name: string): void {
    getDb().update(browserProfiles).set({ name }).where(eq(browserProfiles.id, id)).run();
  }

  /** Delete a profile and every project default that points at it. */
  remove(id: string): void {
    const db = getDb();
    db.transaction((tx) => {
      tx.delete(projectBrowserProfiles).where(eq(projectBrowserProfiles.profileId, id)).run();
      tx.delete(browserProfiles).where(eq(browserProfiles.id, id)).run();
    });
  }

  getProjectDefault(projectName: string): string | null {
    const row = getDb()
      .select({ profileId: projectBrowserProfiles.profileId })
      .from(projectBrowserProfiles)
      .where(eq(projectBrowserProfiles.projectName, projectName))
      .get();
    return row?.profileId ?? null;
  }

  findAllProjectDefaults(): { projectName: string; profileId: string }[] {
    return getDb()
      .select({
        projectName: projectBrowserProfiles.projectName,
        profileId: projectBrowserProfiles.profileId,
      })
      .from(projectBrowserProfiles)
      .all();
  }

  setProjectDefault(projectName: string, profileId: string, updatedAt: number): void {
    getDb()
      .insert(projectBrowserProfiles)
      .values({ projectName, profileId, updatedAt })
      .onConflictDoUpdate({
        target: projectBrowserProfiles.projectName,
        set: { profileId, updatedAt },
      })
      .run();
  }

  clearProjectDefault(projectName: string): void {
    getDb()
      .delete(projectBrowserProfiles)
      .where(eq(projectBrowserProfiles.projectName, projectName))
      .run();
  }
}
