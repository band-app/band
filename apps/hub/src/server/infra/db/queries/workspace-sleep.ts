/** Persistence for `workspace_sleep`: workspaces whose ephemeral worker exited (plan step 3.5). */

import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { workspaceSleep } from "../schema";

export type WorkspaceSleepRow = typeof workspaceSleep.$inferSelect;

export class WorkspaceSleepQueries {
  insert(row: WorkspaceSleepRow): void {
    getDb()
      .insert(workspaceSleep)
      .values(row)
      .onConflictDoUpdate({ target: workspaceSleep.workspaceId, set: row })
      .run();
  }

  get(workspaceId: string): WorkspaceSleepRow | undefined {
    return getDb()
      .select()
      .from(workspaceSleep)
      .where(eq(workspaceSleep.workspaceId, workspaceId))
      .get();
  }

  listAll(): WorkspaceSleepRow[] {
    return getDb().select().from(workspaceSleep).all();
  }

  listByHost(hostId: string): WorkspaceSleepRow[] {
    return getDb().select().from(workspaceSleep).where(eq(workspaceSleep.hostId, hostId)).all();
  }

  delete(workspaceId: string): void {
    getDb().delete(workspaceSleep).where(eq(workspaceSleep.workspaceId, workspaceId)).run();
  }

  deleteByHost(hostId: string): void {
    getDb().delete(workspaceSleep).where(eq(workspaceSleep.hostId, hostId)).run();
  }

  setWaking(hostId: string, at: number | null): void {
    getDb()
      .update(workspaceSleep)
      .set({ wakingSince: at })
      .where(eq(workspaceSleep.hostId, hostId))
      .run();
  }
}
